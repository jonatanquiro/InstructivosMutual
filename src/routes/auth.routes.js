const express = require("express");
const bcrypt = require("bcrypt");
const { sql, getPool } = require("../config/db");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { usuario, password } = req.body;

  if (!usuario || !password) {
    return res.status(400).json({ error: "Faltan usuario o contraseña" });
  }

  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("nombreUsuario", sql.NVarChar, usuario)
      .query(`
        SELECT id, nombre_usuario, nombre_completo, password_hash, rol, activo
        FROM app_usuarios
        WHERE nombre_usuario = @nombreUsuario
      `);

    const usuarioEncontrado = resultado.recordset[0];

    // Ojo: no diferenciamos en el mensaje entre "no existe" y "contraseña
    // incorrecta". Es a propósito, para no darle pistas a quien intenta
    // adivinar usuarios válidos.
    if (!usuarioEncontrado || !usuarioEncontrado.activo) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    const passwordCorrecta = await bcrypt.compare(password, usuarioEncontrado.password_hash);
    if (!passwordCorrecta) {
      return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
    }

    req.session.usuarioId = usuarioEncontrado.id;
    req.session.nombreCompleto = usuarioEncontrado.nombre_completo;
    req.session.rol = usuarioEncontrado.rol;

    await pool
      .request()
      .input("id", sql.Int, usuarioEncontrado.id)
      .query("UPDATE app_usuarios SET ultimo_login = GETDATE() WHERE id = @id");

    res.json({
      ok: true,
      usuario: { nombreCompleto: usuarioEncontrado.nombre_completo, rol: usuarioEncontrado.rol },
    });
  } catch (error) {
    console.error("Error en login:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// La foto no viaja en la sesión (podría cambiar sin re-loguearse), por eso
// esta ruta pasó de sync a async: hace falta ir a buscarla a la base.
router.get("/me", async (req, res) => {
  if (!req.session.usuarioId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .query("SELECT foto_archivo FROM app_config_usuario WHERE usuario_id = @usuarioId");

    const fotoArchivo = resultado.recordset[0]?.foto_archivo;
    res.json({
      usuarioId: req.session.usuarioId,
      nombreCompleto: req.session.nombreCompleto,
      rol: req.session.rol,
      fotoUrl: fotoArchivo ? `/uploads/perfiles/${fotoArchivo}` : null,
    });
  } catch (error) {
    console.error("Error trayendo /me:", error);
    // Ante un error de base, igual respondemos con lo que hay en sesión: no
    // tiene sentido tirar abajo el saludo/header por no poder traer la foto.
    res.json({
      usuarioId: req.session.usuarioId,
      nombreCompleto: req.session.nombreCompleto,
      rol: req.session.rol,
      fotoUrl: null,
    });
  }
});

module.exports = router;
