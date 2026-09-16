const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs/promises");
const multer = require("multer");
const { sql, getPool } = require("../config/db");
const { cifrarTexto, descifrarTexto } = require("../config/cifrado");
const { estaEnLinea } = require("../config/presencia");
const {
  verificarAcceso,
  marcarLeido,
  obtenerLecturasDeOtros,
  obtenerReaccionesDeMensajes,
} = require("./chat-datos");
const { emitirAConversacion, emitirAUsuario, unirUsuarioAConversacion } = require("../config/socket");

const router = express.Router();

// Tiene que coincidir con la carpeta que sirve server.js en /uploads/chat.
// CHAT_UPLOADS_DIR permite que la instancia de testeo use una carpeta
// separada de la de producción (ver .env.test), y también puede ser una
// ruta absoluta en otro disco (por ejemplo "F:\ChatMutual\chat").
const CARPETA_UPLOADS_CHAT_CONFIGURADA = process.env.CHAT_UPLOADS_DIR || "uploads/chat";
const CARPETA_UPLOADS = path.isAbsolute(CARPETA_UPLOADS_CHAT_CONFIGURADA)
  ? CARPETA_UPLOADS_CHAT_CONFIGURADA
  : path.join(__dirname, "..", CARPETA_UPLOADS_CHAT_CONFIGURADA);
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

// verificarAcceso/marcarLeido/obtenerLecturasDeOtros viven en chat-datos.js
// (no acá) para que config/socket.js las pueda usar también sin quedar una
// dependencia circular entre ese módulo y este.

// Además de marcar el mensaje como leído en la base, avisa por socket a los
// demás participantes para que el doble check (✓✓) del remitente se
// actualice al instante en vez de esperar al próximo sondeo.
async function marcarLeidoYAvisar(pool, conversacionId, usuarioId, mensajeId) {
  await marcarLeido(pool, conversacionId, usuarioId, mensajeId);
  emitirAConversacion(conversacionId, "lecturaActualizada", {
    conversacionId,
    usuarioId,
    ultimoMensajeId: mensajeId,
  });
}

// Lista la conversación grupal + las privadas/grupos del usuario, con el
// último mensaje de cada una para pintar la vista previa en la lista.
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
          otro.usuario_id AS otro_usuario_id,
          otro.nombre_completo AS otro_nombre_completo,
          otro.foto_archivo AS otro_foto_archivo,
          ultimo.texto AS ultimo_texto,
          ultimo.imagen_archivo AS ultimo_imagen_archivo,
          ultimo.fecha AS ultima_fecha,
          (
            SELECT COUNT(*) FROM app_chat_mensajes m
            WHERE m.conversacion_id = c.id
              AND m.id > COALESCE(lectura.ultimo_mensaje_id, 0)
          ) AS no_leidos
        FROM app_chat_conversaciones c
        LEFT JOIN app_chat_participantes participacion_propia
          ON participacion_propia.conversacion_id = c.id
          AND participacion_propia.usuario_id = @usuarioId
        LEFT JOIN app_chat_lecturas lectura
          ON lectura.conversacion_id = c.id AND lectura.usuario_id = @usuarioId
        -- Solo tiene sentido un "otro participante" en un DM (privada). En
        -- un grupo hay varios, así que este OUTER APPLY (a diferencia de un
        -- JOIN plano) devuelve como mucho 1 fila y no duplica la conversación.
        OUTER APPLY (
          SELECT TOP 1 p.usuario_id, u.nombre_completo, cfg.foto_archivo
          FROM app_chat_participantes p
          JOIN app_usuarios u ON u.id = p.usuario_id
          LEFT JOIN app_config_usuario cfg ON cfg.usuario_id = p.usuario_id
          WHERE p.conversacion_id = c.id AND p.usuario_id <> @usuarioId AND c.tipo = 'privada'
        ) otro
        OUTER APPLY (
          SELECT TOP 1 texto, imagen_archivo, fecha
          FROM app_chat_mensajes m
          WHERE m.conversacion_id = c.id
          ORDER BY m.id DESC
        ) ultimo
        WHERE c.tipo = 'grupal' OR participacion_propia.usuario_id = @usuarioId
        ORDER BY CASE WHEN c.tipo = 'grupal' THEN 0 ELSE 1 END, ultima_fecha DESC
      `);

    const idsGrupos = resultado.recordset.filter((f) => f.tipo === "grupo").map((f) => f.id);
    const participantesPorGrupo = new Map();

    if (idsGrupos.length > 0) {
      const solicitudParticipantes = pool.request();
      const placeholders = idsGrupos.map((id, i) => {
        solicitudParticipantes.input(`id${i}`, sql.Int, id);
        return `@id${i}`;
      });

      const filas = await solicitudParticipantes.query(`
        SELECT conversacion_id, usuario_id
        FROM app_chat_participantes
        WHERE conversacion_id IN (${placeholders.join(", ")})
      `);

      for (const fila of filas.recordset) {
        if (!participantesPorGrupo.has(fila.conversacion_id)) {
          participantesPorGrupo.set(fila.conversacion_id, []);
        }
        participantesPorGrupo.get(fila.conversacion_id).push(fila.usuario_id);
      }
    }

    const conversaciones = resultado.recordset.map((fila) => {
      const base = {
        ...fila,
        ultimo_texto: descifrarTexto(fila.ultimo_texto),
      };

      if (fila.tipo === "privada") {
        base.otro_en_linea = fila.otro_usuario_id ? estaEnLinea(fila.otro_usuario_id) : false;
        base.otro_foto_url = fila.otro_foto_archivo ? `/uploads/perfiles/${fila.otro_foto_archivo}` : null;
      } else if (fila.tipo === "grupo") {
        const participantes = participantesPorGrupo.get(fila.id) || [];
        base.total_participantes = participantes.length;
        base.en_linea_count = participantes.filter((id) => id !== usuarioId && estaEnLinea(id)).length;
      }

      return base;
    });

    res.json(conversaciones);
  } catch (error) {
    console.error("Error listando conversaciones:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Crea un grupo con nombre y una lista de participantes (además de quien
// lo crea). Reutiliza exactamente el mismo modelo que los DMs (una fila en
// app_chat_conversaciones + N filas en app_chat_participantes), nada más
// que con más de 2 participantes y tipo 'grupo' en vez de 'privada'.
router.post("/chat/grupos", async (req, res) => {
  const usuarioId = req.session.usuarioId;
  const nombre = String(req.body.nombre || "").trim().slice(0, 150);
  const participantesIds = Array.isArray(req.body.participantesIds)
    ? [...new Set(req.body.participantesIds.map(Number).filter((id) => id && id !== usuarioId))]
    : [];

  if (!nombre) return res.status(400).json({ error: "El grupo necesita un nombre" });
  if (participantesIds.length === 0) {
    return res.status(400).json({ error: "Elegí al menos un participante" });
  }

  try {
    const pool = await getPool();

    const nuevaConversacion = await pool
      .request()
      .input("nombre", sql.NVarChar, nombre)
      .query("INSERT INTO app_chat_conversaciones (tipo, nombre) OUTPUT INSERTED.id VALUES ('grupo', @nombre)");
    const conversacionId = nuevaConversacion.recordset[0].id;

    const todosLosIds = [usuarioId, ...participantesIds];
    for (const idParticipante of todosLosIds) {
      await pool
        .request()
        .input("conversacionId", sql.Int, conversacionId)
        .input("usuarioId", sql.Int, idParticipante)
        .query("INSERT INTO app_chat_participantes (conversacion_id, usuario_id) VALUES (@conversacionId, @usuarioId)");
    }

    // A los demás participantes (no a quien lo crea, que ya lo sabe por la
    // respuesta de este mismo request) se les avisa por socket para que el
    // grupo nuevo aparezca en su lista sin esperar el próximo sondeo, y se
    // suman sus sockets ya conectados a la sala de esta conversación para
    // que les lleguen los mensajes en tiempo real desde el primer momento.
    for (const idParticipante of todosLosIds) {
      unirUsuarioAConversacion(idParticipante, conversacionId);
      if (idParticipante !== usuarioId) {
        emitirAUsuario(idParticipante, "conversacionNueva", { id: conversacionId });
      }
    }

    res.status(201).json({ id: conversacionId });
  } catch (error) {
    console.error("Error creando grupo de chat:", error);
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
        SELECT u.id, u.nombre_completo, cfg.foto_archivo
        FROM app_usuarios u
        LEFT JOIN app_config_usuario cfg ON cfg.usuario_id = u.id
        WHERE u.activo = 1 AND u.id <> @usuarioId
        ORDER BY u.nombre_completo
      `);
    const usuarios = resultado.recordset.map((fila) => ({
      id: fila.id,
      nombre_completo: fila.nombre_completo,
      en_linea: estaEnLinea(fila.id),
      foto_url: fila.foto_archivo ? `/uploads/perfiles/${fila.foto_archivo}` : null,
    }));
    res.json(usuarios);
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

    unirUsuarioAConversacion(usuarioId, conversacionId);
    unirUsuarioAConversacion(otroUsuarioId, conversacionId);
    emitirAUsuario(otroUsuarioId, "conversacionNueva", { id: conversacionId });

    res.status(201).json({ id: conversacionId });
  } catch (error) {
    console.error("Error creando conversación de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/chat/conversaciones/:id/mensajes", async (req, res) => {
  const conversacionId = Number(req.params.id);
  const despuesDe = Number(req.query.despuesDe) || 0;
  const usuarioId = req.session.usuarioId;

  try {
    const pool = await getPool();
    const acceso = await verificarAcceso(pool, conversacionId, usuarioId);
    if (acceso === null) return res.status(404).json({ error: "Conversación no encontrada" });
    if (acceso === false) return res.status(403).json({ error: "No autorizado" });

    // TOP 50 sobre un ORDER BY DESC (y recién después se reordena ascendente)
    // para traer los 50 mensajes más RECIENTES después de "despuesDe" — si
    // hubiera cientos de mensajes viejos, no queremos mostrar los primeros
    // 50 de toda la historia en vez de los últimos.
    const resultado = await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .input("despuesDe", sql.Int, despuesDe)
      .query(`
        SELECT * FROM (
          SELECT TOP 50 m.id, m.usuario_id, u.nombre_completo, cfg.foto_archivo,
            m.texto, m.imagen_archivo, m.fecha, m.editado, m.eliminado
          FROM app_chat_mensajes m
          JOIN app_usuarios u ON u.id = m.usuario_id
          LEFT JOIN app_config_usuario cfg ON cfg.usuario_id = m.usuario_id
          WHERE m.conversacion_id = @conversacionId AND m.id > @despuesDe
          ORDER BY m.id DESC
        ) recientes
        ORDER BY id ASC
      `);

    // Abrir/actualizar la conversación cuenta como "leída" hasta el último
    // mensaje que se le mostró al usuario.
    const maxIdMostrado = resultado.recordset.reduce((max, m) => Math.max(max, m.id), 0);
    if (maxIdMostrado > 0) {
      await marcarLeidoYAvisar(pool, conversacionId, usuarioId, maxIdMostrado);
    }

    // "Visto" (doble check) solo tiene sentido en DM/grupo: hay que ver si
    // TODOS los demás participantes ya leyeron el mensaje. En "General" no
    // se calcula (no aporta nada con muchos participantes).
    const lecturasDeOtros =
      acceso.tipo !== "grupal" ? await obtenerLecturasDeOtros(pool, conversacionId, usuarioId) : [];

    const reaccionesPorMensaje = await obtenerReaccionesDeMensajes(
      pool,
      resultado.recordset.map((fila) => fila.id)
    );

    const mensajes = resultado.recordset.map((fila) => {
      const base = {
        ...fila,
        texto: descifrarTexto(fila.texto),
        foto_url: fila.foto_archivo ? `/uploads/perfiles/${fila.foto_archivo}` : null,
        reacciones: reaccionesPorMensaje.get(fila.id) || [],
      };
      if (fila.usuario_id === usuarioId && lecturasDeOtros.length > 0) {
        base.visto = lecturasDeOtros.every((otro) => otro.ultimo_mensaje_id >= fila.id);
      }
      return base;
    });

    res.json(mensajes);
  } catch (error) {
    console.error("Error trayendo mensajes de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Endpoint liviano para refrescar solo el "visto" de los mensajes propios
// ya mostrados, sin volver a traer/descifrar toda la conversación. El
// frontend lo consulta junto con el polling de mensajes nuevos.
router.get("/chat/conversaciones/:id/lecturas", async (req, res) => {
  const conversacionId = Number(req.params.id);
  const usuarioId = req.session.usuarioId;

  try {
    const pool = await getPool();
    const acceso = await verificarAcceso(pool, conversacionId, usuarioId);
    if (acceso === null) return res.status(404).json({ error: "Conversación no encontrada" });
    if (acceso === false) return res.status(403).json({ error: "No autorizado" });

    const lecturas = acceso.tipo !== "grupal" ? await obtenerLecturasDeOtros(pool, conversacionId, usuarioId) : [];
    res.json(lecturas);
  } catch (error) {
    console.error("Error trayendo lecturas de chat:", error);
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
      .input("texto", sql.NVarChar, texto ? cifrarTexto(texto) : null)
      .input("imagenArchivo", sql.NVarChar, req.file ? req.file.filename : null)
      .query(`
        INSERT INTO app_chat_mensajes (conversacion_id, usuario_id, texto, imagen_archivo)
        OUTPUT INSERTED.id, INSERTED.fecha
        VALUES (@conversacionId, @usuarioId, @texto, @imagenArchivo)
      `);

    const nuevoId = resultado.recordset[0].id;

    // Mandar un mensaje también cuenta como "haberlo leído": si no, el
    // propio remitente vería su mensaje recién enviado como no leído.
    await marcarLeidoYAvisar(pool, conversacionId, req.session.usuarioId, nuevoId);

    // La foto no viaja en la sesión (podría cambiar sin re-loguearse), así
    // que se busca acá para que los demás participantes la vean en su
    // avatar del mensaje sin tener que pedir el perfil de este usuario aparte.
    const perfilRemitente = await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .query("SELECT foto_archivo FROM app_config_usuario WHERE usuario_id = @usuarioId");
    const fotoArchivo = perfilRemitente.recordset[0]?.foto_archivo;

    // Mismo objeto para la respuesta HTTP (quien mandó el mensaje) y para
    // el aviso por socket a los demás participantes de la conversación:
    // así no hay dos formatos de "mensaje" distintos dando vueltas. El
    // check de "visto" solo se agrega fuera de "General" (mismo criterio
    // que en GET /mensajes): con muchos participantes no aporta nada.
    const mensaje = {
      id: nuevoId,
      conversacion_id: conversacionId,
      usuario_id: req.session.usuarioId,
      nombre_completo: req.session.nombreCompleto,
      foto_url: fotoArchivo ? `/uploads/perfiles/${fotoArchivo}` : null,
      texto: texto || null,
      imagen_archivo: req.file ? req.file.filename : null,
      fecha: resultado.recordset[0].fecha,
      editado: false,
      eliminado: false,
      reacciones: [],
    };
    if (acceso.tipo !== "grupal") mensaje.visto = false;
    emitirAConversacion(conversacionId, "mensajeNuevo", mensaje);

    res.status(201).json(mensaje);
  } catch (error) {
    console.error("Error enviando mensaje de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Trae un mensaje propio (para validar dueño antes de editar/borrar/etc.),
// junto con la conversación a la que pertenece para poder avisar por socket.
async function buscarMensajePropio(pool, mensajeId, usuarioId) {
  const resultado = await pool
    .request()
    .input("id", sql.Int, mensajeId)
    .query(`
      SELECT id, conversacion_id, usuario_id, imagen_archivo, eliminado
      FROM app_chat_mensajes WHERE id = @id
    `);
  const mensaje = resultado.recordset[0];
  if (!mensaje) return null;
  if (mensaje.usuario_id !== usuarioId) return false;
  return mensaje;
}

// Edita el texto de un mensaje propio. Solo texto (no se puede "editar" la
// imagen adjunta): si el mensaje no tiene texto, no tiene sentido editarlo
// por acá, se borra y se manda uno nuevo.
router.put("/chat/mensajes/:id", async (req, res) => {
  const mensajeId = Number(req.params.id);
  const texto = String(req.body.texto || "").trim().slice(0, 2000);
  if (!texto) return res.status(400).json({ error: "El mensaje no puede quedar vacío" });

  try {
    const pool = await getPool();
    const mensaje = await buscarMensajePropio(pool, mensajeId, req.session.usuarioId);
    if (mensaje === null) return res.status(404).json({ error: "Mensaje no encontrado" });
    if (mensaje === false) return res.status(403).json({ error: "No autorizado" });
    if (mensaje.eliminado) return res.status(400).json({ error: "El mensaje fue eliminado" });

    await pool
      .request()
      .input("id", sql.Int, mensajeId)
      .input("texto", sql.NVarChar, cifrarTexto(texto))
      .query("UPDATE app_chat_mensajes SET texto = @texto, editado = 1 WHERE id = @id");

    const datos = { id: mensajeId, conversacionId: mensaje.conversacion_id, texto, editado: true };
    emitirAConversacion(mensaje.conversacion_id, "mensajeEditado", datos);
    res.json(datos);
  } catch (error) {
    console.error("Error editando mensaje de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Borra un mensaje propio puntual (a diferencia del DELETE de más abajo,
// que vacía toda la conversación). Es borrado "estilo WhatsApp": la fila
// queda pero sin texto/imagen, marcada como eliminada, para no correr los
// ids de los demás mensajes ni romper el historial de lecturas.
router.delete("/chat/mensajes/:id", async (req, res) => {
  const mensajeId = Number(req.params.id);

  try {
    const pool = await getPool();
    const mensaje = await buscarMensajePropio(pool, mensajeId, req.session.usuarioId);
    if (mensaje === null) return res.status(404).json({ error: "Mensaje no encontrado" });
    if (mensaje === false) return res.status(403).json({ error: "No autorizado" });
    if (mensaje.eliminado) return res.json({ ok: true });

    if (mensaje.imagen_archivo) {
      await fs.unlink(path.join(CARPETA_UPLOADS, mensaje.imagen_archivo)).catch(() => {});
    }

    await pool
      .request()
      .input("id", sql.Int, mensajeId)
      .query(`
        DELETE FROM app_chat_reacciones WHERE mensaje_id = @id;
        UPDATE app_chat_mensajes SET texto = NULL, imagen_archivo = NULL, eliminado = 1 WHERE id = @id;
      `);

    emitirAConversacion(mensaje.conversacion_id, "mensajeEliminado", {
      id: mensajeId,
      conversacionId: mensaje.conversacion_id,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error borrando mensaje de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Reacciona (o saca la reacción) a un mensaje. Una sola reacción por
// usuario por mensaje: mandar el mismo emoji que ya tenía puesto la saca
// (toggle), mandar uno distinto la reemplaza.
router.post("/chat/mensajes/:id/reacciones", async (req, res) => {
  const mensajeId = Number(req.params.id);
  const emoji = String(req.body.emoji || "").trim().slice(0, 20);
  const usuarioId = req.session.usuarioId;
  if (!emoji) return res.status(400).json({ error: "Falta el emoji" });

  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("id", sql.Int, mensajeId)
      .query("SELECT id, conversacion_id, eliminado FROM app_chat_mensajes WHERE id = @id");
    const mensaje = resultado.recordset[0];
    if (!mensaje) return res.status(404).json({ error: "Mensaje no encontrado" });
    if (mensaje.eliminado) return res.status(400).json({ error: "El mensaje fue eliminado" });

    const acceso = await verificarAcceso(pool, mensaje.conversacion_id, usuarioId);
    if (!acceso) return res.status(403).json({ error: "No autorizado" });

    const existente = await pool
      .request()
      .input("mensajeId", sql.Int, mensajeId)
      .input("usuarioId", sql.Int, usuarioId)
      .query("SELECT emoji FROM app_chat_reacciones WHERE mensaje_id = @mensajeId AND usuario_id = @usuarioId");

    if (existente.recordset[0]?.emoji === emoji) {
      await pool
        .request()
        .input("mensajeId", sql.Int, mensajeId)
        .input("usuarioId", sql.Int, usuarioId)
        .query("DELETE FROM app_chat_reacciones WHERE mensaje_id = @mensajeId AND usuario_id = @usuarioId");
    } else {
      await pool
        .request()
        .input("mensajeId", sql.Int, mensajeId)
        .input("usuarioId", sql.Int, usuarioId)
        .input("emoji", sql.NVarChar, emoji)
        .query(`
          MERGE app_chat_reacciones AS destino
          USING (SELECT @mensajeId AS mensaje_id, @usuarioId AS usuario_id) AS origen
          ON destino.mensaje_id = origen.mensaje_id AND destino.usuario_id = origen.usuario_id
          WHEN MATCHED THEN UPDATE SET emoji = @emoji
          WHEN NOT MATCHED THEN INSERT (mensaje_id, usuario_id, emoji) VALUES (@mensajeId, @usuarioId, @emoji);
        `);
    }

    const reaccionesPorMensaje = await obtenerReaccionesDeMensajes(pool, [mensajeId]);
    const reacciones = reaccionesPorMensaje.get(mensajeId) || [];
    const datos = { id: mensajeId, conversacionId: mensaje.conversacion_id, reacciones };
    emitirAConversacion(mensaje.conversacion_id, "reaccionesActualizadas", datos);
    res.json(datos);
  } catch (error) {
    console.error("Error reaccionando a mensaje de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Borra todos los mensajes (y sus imágenes) de una conversación. No hay
// borrado automático por tiempo: es una acción manual que pide el usuario.
// La conversación en sí queda (para "General" no tendría sentido que
// desaparezca, y para un DM permite seguir escribiendo sin tener que
// volver a elegir el contacto).
router.delete("/chat/conversaciones/:id/mensajes", async (req, res) => {
  const conversacionId = Number(req.params.id);

  try {
    const pool = await getPool();
    const acceso = await verificarAcceso(pool, conversacionId, req.session.usuarioId);
    if (acceso === null) return res.status(404).json({ error: "Conversación no encontrada" });
    if (acceso === false) return res.status(403).json({ error: "No autorizado" });

    const mensajes = await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .query("SELECT imagen_archivo FROM app_chat_mensajes WHERE conversacion_id = @conversacionId");

    for (const mensaje of mensajes.recordset) {
      if (mensaje.imagen_archivo) {
        await fs.unlink(path.join(CARPETA_UPLOADS, mensaje.imagen_archivo)).catch(() => {});
      }
    }

    // Las reacciones tienen FK a app_chat_mensajes: hay que borrarlas antes
    // o el DELETE de los mensajes falla por integridad referencial.
    await pool
      .request()
      .input("conversacionId", sql.Int, conversacionId)
      .query(`
        DELETE r FROM app_chat_reacciones r
        JOIN app_chat_mensajes m ON m.id = r.mensaje_id
        WHERE m.conversacion_id = @conversacionId;
        DELETE FROM app_chat_mensajes WHERE conversacion_id = @conversacionId;
      `);

    res.json({ ok: true });
  } catch (error) {
    console.error("Error borrando mensajes de chat:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
