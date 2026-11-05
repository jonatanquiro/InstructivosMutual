const express = require("express");
const bcrypt = require("bcrypt");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Panel de Administración. Todas las rutas de este archivo ya pasaron por
// requiereLogin + requiereGestion en server.js (montadas en /api/gestion):
// sólo admin, Daniela y Jonatan.

// Nivel de permiso de conciliación, en un solo valor para la pantalla.
// Se guarda en conc_permisos: sin fila = "no"; las otras, según las columnas.
const NIVELES_CONCILIACION = {
  no: null,
  usa: { cerrar: false, reabrir: false },
  cierra: { cerrar: true, reabrir: false },
  total: { cerrar: true, reabrir: true },
};

router.get("/usuarios", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT u.id, u.nombre_usuario, u.nombre_completo, u.rol, u.activo, u.ultimo_login,
             CASE WHEN p.usuario_id IS NULL THEN 'no'
                  WHEN p.puede_reabrir = 1 THEN 'total'
                  WHEN p.puede_cerrar = 1 THEN 'cierra'
                  ELSE 'usa' END AS conciliacion
      FROM app_usuarios u
      LEFT JOIN conc_permisos p ON p.usuario_id = u.id
      ORDER BY u.nombre_completo
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error listando usuarios:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/usuarios", async (req, res) => {
  const { nombreUsuario, password, nombreCompleto, rol } = req.body;

  if (!nombreUsuario || !password || !nombreCompleto) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const pool = await getPool();

    const existente = await pool
      .request()
      .input("nombreUsuario", sql.NVarChar, nombreUsuario)
      .query("SELECT id FROM app_usuarios WHERE nombre_usuario = @nombreUsuario");

    if (existente.recordset.length > 0) {
      return res.status(409).json({ error: "Ya existe un usuario con ese nombre de usuario" });
    }

    const hash = await bcrypt.hash(password, 10);

    await pool
      .request()
      .input("nombreUsuario", sql.NVarChar, nombreUsuario)
      .input("nombreCompleto", sql.NVarChar, nombreCompleto)
      .input("hash", sql.NVarChar, hash)
      .input("rol", sql.NVarChar, rol || "usuario")
      .query(`
        INSERT INTO app_usuarios (nombre_usuario, nombre_completo, password_hash, rol, activo)
        VALUES (@nombreUsuario, @nombreCompleto, @hash, @rol, 1)
      `);

    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Error creando usuario:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/usuarios/:id", async (req, res) => {
  const { nombreCompleto, rol, activo, conciliacion } = req.body;
  const id = Number(req.params.id);

  if (!nombreCompleto || !rol || typeof activo !== "boolean") {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  // conciliacion es opcional: si no viene, el permiso queda como estaba.
  if (conciliacion !== undefined && !(conciliacion in NIVELES_CONCILIACION)) {
    return res.status(400).json({ error: "Permiso de conciliación inválido" });
  }

  // Evita que un admin se desactive a sí mismo y se quede afuera sin querer.
  if (id === req.session.usuarioId && !activo) {
    return res.status(400).json({ error: "No podés desactivar tu propio usuario" });
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("nombreCompleto", sql.NVarChar, nombreCompleto)
      .input("rol", sql.NVarChar, rol)
      .input("activo", sql.Bit, activo)
      .query(`
        UPDATE app_usuarios
        SET nombre_completo = @nombreCompleto, rol = @rol, activo = @activo
        WHERE id = @id
      `);

    if (conciliacion !== undefined) {
      const nivel = NIVELES_CONCILIACION[conciliacion];
      const pedido = pool.request().input("id", sql.Int, id);
      if (!nivel) {
        await pedido.query("DELETE FROM conc_permisos WHERE usuario_id = @id");
      } else {
        await pedido
          .input("cerrar", sql.Bit, nivel.cerrar)
          .input("reabrir", sql.Bit, nivel.reabrir)
          .query(`
            UPDATE conc_permisos SET puede_cerrar = @cerrar, puede_reabrir = @reabrir WHERE usuario_id = @id;
            IF @@ROWCOUNT = 0
              INSERT INTO conc_permisos (usuario_id, puede_cerrar, puede_reabrir) VALUES (@id, @cerrar, @reabrir);
          `);
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("Error actualizando usuario:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/usuarios/:id/password", async (req, res) => {
  const { password } = req.body;
  const id = Number(req.params.id);

  if (!password || password.length < 4) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("hash", sql.NVarChar, hash)
      .query("UPDATE app_usuarios SET password_hash = @hash WHERE id = @id");
    res.json({ ok: true });
  } catch (error) {
    console.error("Error cambiando contraseña:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// ------------------------------------------------ Bancos de conciliación
// Qué bancos aparecen en la pantalla de conciliación. Ocultar no borra nada:
// los meses ya cargados quedan guardados y vuelven a verse al mostrarlo.
router.get("/conciliacion-bancos", async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(`
      SELECT b.codigo, b.nombre, b.moneda, b.orden, b.activo,
             (SELECT COUNT(*) FROM conc_periodos p WHERE p.banco = b.codigo) AS meses
      FROM conc_bancos b ORDER BY b.orden
    `);
    res.json(r.recordset);
  } catch (error) {
    console.error("Error listando bancos de conciliación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/conciliacion-bancos/:codigo", async (req, res) => {
  const { activo } = req.body;
  if (typeof activo !== "boolean") return res.status(400).json({ error: "Falta indicar si se ve o no" });
  try {
    const pool = await getPool();
    const r = await pool.request()
      .input("codigo", sql.NVarChar, req.params.codigo)
      .input("activo", sql.Bit, activo)
      .query("UPDATE conc_bancos SET activo = @activo WHERE codigo = @codigo");
    if (!r.rowsAffected[0]) return res.status(404).json({ error: "Ese banco no existe" });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error cambiando banco de conciliación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
