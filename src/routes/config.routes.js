const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const multer = require("multer");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Igual patrón que src/uploads/chat: nombre random en disco, carpeta
// configurable (PERFIL_UPLOADS_DIR, opcional) por si algún día hace falta
// separar test de producción como ya se hace con el chat. También puede ser
// una ruta absoluta en otro disco (ver resolverCarpetaUploads en server.js).
const CARPETA_UPLOADS_PERFILES_CONFIGURADA = process.env.PERFIL_UPLOADS_DIR || "uploads/perfiles";
const CARPETA_UPLOADS_PERFILES = path.isAbsolute(CARPETA_UPLOADS_PERFILES_CONFIGURADA)
  ? CARPETA_UPLOADS_PERFILES_CONFIGURADA
  : path.join(__dirname, "..", CARPETA_UPLOADS_PERFILES_CONFIGURADA);
const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
const EXTENSION_POR_TIPO = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARPETA_UPLOADS_PERFILES),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (EXTENSION_POR_TIPO[file.mimetype] || "")),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype)),
});

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TELEFONO_VALIDO = /^[0-9+\-() ]{6,30}$/;

// Trae la config + el perfil del usuario logueado. Si nunca guardó nada,
// devuelve los defaults sin necesidad de tener fila en la tabla.
router.get("/config", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .query(`
        SELECT tema, telefono, email, fecha_nacimiento, foto_archivo
        FROM app_config_usuario WHERE usuario_id = @usuarioId
      `);

    const fila = resultado.recordset[0];
    res.json({
      tema: fila?.tema || "claro",
      telefono: fila?.telefono || "",
      email: fila?.email || "",
      // DATE de SQL Server llega como Date de JS en UTC (mismo criterio que
      // cumpleanios.routes.js): con toISOString alcanza para "AAAA-MM-DD".
      fechaNacimiento: fila?.fecha_nacimiento ? fila.fecha_nacimiento.toISOString().slice(0, 10) : "",
      fotoUrl: fila?.foto_archivo ? `/uploads/perfiles/${fila.foto_archivo}` : null,
    });
  } catch (error) {
    console.error("Error trayendo configuración:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/config", async (req, res) => {
  const { tema } = req.body;

  if (tema !== "claro" && tema !== "oscuro") {
    return res.status(400).json({ error: "Tema inválido" });
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .input("tema", sql.NVarChar, tema)
      .query(`
        MERGE app_config_usuario AS destino
        USING (SELECT @usuarioId AS usuario_id, @tema AS tema) AS origen
        ON destino.usuario_id = origen.usuario_id
        WHEN MATCHED THEN UPDATE SET tema = origen.tema
        WHEN NOT MATCHED THEN INSERT (usuario_id, tema) VALUES (origen.usuario_id, origen.tema);
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando configuración:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Datos de perfil: van en un endpoint aparte del tema porque se guardan con
// un botón "Guardar" del formulario, no al toque como el selector de tema.
// Los tres campos son opcionales; mandar "" borra el que ya tenía guardado.
router.put("/config/perfil", async (req, res) => {
  const usuarioId = req.session.usuarioId;
  const telefono = String(req.body.telefono || "").trim().slice(0, 30);
  const email = String(req.body.email || "").trim().slice(0, 150);
  const fechaNacimientoTexto = String(req.body.fechaNacimiento || "").trim();

  if (telefono && !TELEFONO_VALIDO.test(telefono)) {
    return res.status(400).json({ error: "Teléfono inválido" });
  }
  if (email && !EMAIL_VALIDO.test(email)) {
    return res.status(400).json({ error: "Email inválido" });
  }

  let fechaNacimiento = null;
  if (fechaNacimientoTexto) {
    fechaNacimiento = new Date(fechaNacimientoTexto);
    if (Number.isNaN(fechaNacimiento.getTime()) || fechaNacimiento > new Date()) {
      return res.status(400).json({ error: "Fecha de nacimiento inválida" });
    }
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .input("telefono", sql.NVarChar, telefono || null)
      .input("email", sql.NVarChar, email || null)
      .input("fechaNacimiento", sql.Date, fechaNacimiento)
      .query(`
        MERGE app_config_usuario AS destino
        USING (SELECT @usuarioId AS usuario_id) AS origen
        ON destino.usuario_id = origen.usuario_id
        WHEN MATCHED THEN
          UPDATE SET telefono = @telefono, email = @email, fecha_nacimiento = @fechaNacimiento
        WHEN NOT MATCHED THEN
          INSERT (usuario_id, telefono, email, fecha_nacimiento)
          VALUES (@usuarioId, @telefono, @email, @fechaNacimiento);
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando perfil:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Sube (o reemplaza) la foto de perfil. Si ya tenía una guardada, borra el
// archivo viejo del disco para no ir acumulando huérfanos.
router.post("/config/foto", upload.single("foto"), async (req, res) => {
  const usuarioId = req.session.usuarioId;
  if (!req.file) {
    return res.status(400).json({ error: "Imagen inválida (jpg/png/webp, máx. 2MB)" });
  }

  try {
    const pool = await getPool();
    const anterior = await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .query("SELECT foto_archivo FROM app_config_usuario WHERE usuario_id = @usuarioId");

    await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .input("fotoArchivo", sql.NVarChar, req.file.filename)
      .query(`
        MERGE app_config_usuario AS destino
        USING (SELECT @usuarioId AS usuario_id) AS origen
        ON destino.usuario_id = origen.usuario_id
        WHEN MATCHED THEN UPDATE SET foto_archivo = @fotoArchivo
        WHEN NOT MATCHED THEN INSERT (usuario_id, foto_archivo) VALUES (@usuarioId, @fotoArchivo);
      `);

    const archivoAnterior = anterior.recordset[0]?.foto_archivo;
    if (archivoAnterior) {
      await fs.unlink(path.join(CARPETA_UPLOADS_PERFILES, archivoAnterior)).catch(() => {});
    }

    res.json({ ok: true, fotoUrl: `/uploads/perfiles/${req.file.filename}` });
  } catch (error) {
    console.error("Error guardando foto de perfil:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Saca la foto de perfil (vuelve al ícono/inicial por defecto).
router.delete("/config/foto", async (req, res) => {
  const usuarioId = req.session.usuarioId;
  try {
    const pool = await getPool();
    const actual = await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .query("SELECT foto_archivo FROM app_config_usuario WHERE usuario_id = @usuarioId");

    const archivo = actual.recordset[0]?.foto_archivo;
    if (archivo) {
      await pool
        .request()
        .input("usuarioId", sql.Int, usuarioId)
        .query("UPDATE app_config_usuario SET foto_archivo = NULL WHERE usuario_id = @usuarioId");
      await fs.unlink(path.join(CARPETA_UPLOADS_PERFILES, archivo)).catch(() => {});
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("Error quitando foto de perfil:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
