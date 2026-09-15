const express = require("express");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { sql, getPool } = require("../config/db");

const router = express.Router();

const CARPETA_UPLOADS = path.join(__dirname, "..", "uploads", "chat");
const TIPOS_IMAGEN_PERMITIDOS = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const EXTENSION_POR_TIPO = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARPETA_UPLOADS),
    filename: (req, file, cb) => {
      const extension = EXTENSION_POR_TIPO[file.mimetype] || "";
      cb(null, crypto.randomUUID() + extension);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, TIPOS_IMAGEN_PERMITIDOS.includes(file.mimetype));
  },
});

// Confirma que el usuario logueado puede leer/escribir en la conversación:
// la grupal es libre para cualquier logueado, las privadas requieren ser
// participante. Devuelve la fila de la conversación o null si no existe.
async function verificarAcceso(pool, conversacionId, usuarioId) {
  const resultado = await pool
    .request()
    .input("id", sql.Int, conversacionId)
    .query("SELECT id, tipo FROM app_chat_conversaciones WHERE id = @id");

  const conversacion = resultado.recordset[0];
  if (!conversacion) return null;

  if (conversacion.tipo === "grupal") return conversacion;

  const participante = await pool
    .request()
    .input("conversacionId", sql.Int, conversacionId)
    .input("usuarioId", sql.Int, usuarioId)
    .query(`
      SELECT 1 FROM app_chat_participantes
      WHERE conversacion_id = @conversacionId AND usuario_id = @usuarioId
    `);

  return participante.recordset.length > 0 ? conversacion : false;
}

// Lista la conversación grupal + las privadas del usuario, con el último
// mensaje de cada una para pintar la vista previa en la lista.
router.get("/chat/conversaciones", async (req, res) => {
  try {
    const pool = await getPool();
    const usuarioId = req.session.usuarioId;

    const resultado = await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .query(`
        SELECT
          c.id, c.tipo, c.nombre,
          otro.nombre_completo AS otro_nombre_completo,
          ultimo.texto AS ultimo_texto,
          ultimo.imagen_archivo AS ultimo_imagen_archivo,
          ultimo.fecha AS ultima_fecha
        FROM app_chat_conversaciones c
        LEFT JOIN app_chat_participantes participacion_propia
          ON participacion_propia.conversacion_id = c.id
          AND participacion_propia.usuario_id = @usuarioId
        LEFT JOIN app_chat_participantes participacion_otro
          ON participacion_otro.conversacion_id = c.id
          AND participacion_otro.usuario_id <> @usuarioId
        LEFT JOIN app_usuarios otro ON otro.id = participacion_otro.usuario_id
        OUTER APPLY (
          SELECT TOP 1 texto, imagen_archivo, fecha
          FROM app_chat_mensajes m
          WHERE m.conversacion_id = c.id
          ORDER BY m.id DESC
        ) ultimo
        WHERE c.tipo = 'grupal' OR participacion_propia.usuario_id = @usuarioId
        ORDER BY CASE WHEN c.tipo = 'grupal' THEN 0 ELSE 1 END, ultima_fecha DESC
      `);

    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error listando conversaciones:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Usuarios activos disponibles para arrancar un DM (cualquier logueado
// puede ver esta lista, a diferencia de /api/usuarios que es solo admin).
router.get("/chat/usuarios", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .query(`
        SELECT id, nombre_completo
        FROM app_usuarios
        WHERE activo = 1 AND id <> @usuarioId
        ORDER BY nombre_completo
      `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error listando usuarios para chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Busca (o crea) la conversación privada con otro usuario.
router.post("/chat/conversaciones", async (req, res) => {
  const usuarioId = req.session.usuarioId;
  const otroUsuarioId = Number(req.body.usuarioId);

  if (!otroUsuarioId || otroUsuarioId === usuarioId) {
    return res.status(400).json({ error: "Usuario inválido" });
  }

  try {
    const pool = await getPool();

    const existente = await pool
      .request()
      .input("usuarioId", sql.Int, usuarioId)
      .input("otroUsuarioId", sql.Int, otroUsuarioId)
      .query(`
        SELECT p1.conversacion_id AS id
        FROM app_chat_participantes p1
        JOIN app_chat_participantes p2
          ON p2.conversacion_id = p1.conversacion_id AND p2.usuario_id = @otroUsuarioId
        WHERE p1.usuario_id = @usuarioId
      `);

    if (existente.recordset.length > 0) {
      return res.json({ id: existente.recordset[0].id });
    }

    const nuevaConversacion = await pool
      .request()
      .query("INSERT INTO app_chat_conversaciones (tipo) OUTPUT INSERTED.id VALUES ('privada')");
    const conversacionId = nuevaConversacion.recordset[0].id;

    await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .input("usuarioId", sql.Int, usuarioId)
      .input("otroUsuarioId", sql.Int, otroUsuarioId)
      .query(`
        INSERT INTO app_chat_participantes (conversacion_id, usuario_id)
        VALUES (@conversacionId, @usuarioId), (@conversacionId, @otroUsuarioId)
      `);

    res.status(201).json({ id: conversacionId });
  } catch (error) {
    console.error("Error creando conversación de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/chat/conversaciones/:id/mensajes", async (req, res) => {
  const conversacionId = Number(req.params.id);
  const despuesDe = Number(req.query.despuesDe) || 0;

  try {
    const pool = await getPool();
    const acceso = await verificarAcceso(pool, conversacionId, req.session.usuarioId);
    if (acceso === null) return res.status(404).json({ error: "Conversación no encontrada" });
    if (acceso === false) return res.status(403).json({ error: "No autorizado" });

    const resultado = await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .input("despuesDe", sql.Int, despuesDe)
      .query(`
        SELECT TOP 50 m.id, m.usuario_id, u.nombre_completo, m.texto, m.imagen_archivo, m.fecha
        FROM app_chat_mensajes m
        JOIN app_usuarios u ON u.id = m.usuario_id
        WHERE m.conversacion_id = @conversacionId AND m.id > @despuesDe
        ORDER BY m.id ASC
      `);

    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo mensajes de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/chat/conversaciones/:id/mensajes", upload.single("imagen"), async (req, res) => {
  const conversacionId = Number(req.params.id);
  const texto = (req.body.texto || "").trim().slice(0, 2000);

  if (!texto && !req.file) {
    return res.status(400).json({ error: "El mensaje necesita texto o una imagen" });
  }

  try {
    const pool = await getPool();
    const acceso = await verificarAcceso(pool, conversacionId, req.session.usuarioId);
    if (acceso === null) return res.status(404).json({ error: "Conversación no encontrada" });
    if (acceso === false) return res.status(403).json({ error: "No autorizado" });

    const resultado = await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .input("texto", sql.NVarChar, texto || null)
      .input("imagenArchivo", sql.NVarChar, req.file ? req.file.filename : null)
      .query(`
        INSERT INTO app_chat_mensajes (conversacion_id, usuario_id, texto, imagen_archivo)
        OUTPUT INSERTED.id, INSERTED.fecha
        VALUES (@conversacionId, @usuarioId, @texto, @imagenArchivo)
      `);

    res.status(201).json({
      id: resultado.recordset[0].id,
      usuario_id: req.session.usuarioId,
      nombre_completo: req.session.nombreCompleto,
      texto: texto || null,
      imagen_archivo: req.file ? req.file.filename : null,
      fecha: resultado.recordset[0].fecha,
    });
  } catch (error) {
    console.error("Error enviando mensaje de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
