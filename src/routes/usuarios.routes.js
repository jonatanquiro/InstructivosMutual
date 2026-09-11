const express = require("express");
const bcrypt = require("bcrypt");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Todas las rutas de este archivo ya pasaron por requiereLogin +
// requiereAdmin en server.js, así que acá asumimos que quien llama es admin.

router.get("/usuarios", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT id, nombre_usuario, nombre_completo, rol, activo, ultimo_login
      FROM app_usuarios
      ORDER BY nombre_completo
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
  const { nombreCompleto, rol, activo } = req.body;
  const id = Number(req.params.id);

  if (!nombreCompleto || !rol || typeof activo !== "boolean") {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
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

module.exports = router;
