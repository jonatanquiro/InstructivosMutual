const { sql } = require("../config/db");

// Confirma que el usuario logueado puede leer/escribir en la conversación:
// la grupal es libre para cualquier logueado, las privadas requieren ser
// participante. Devuelve la fila de la conversación o null/false si no.
// Separado de chat.routes.js (y no en config/socket.js) para que ambos lo
// puedan usar sin que quede una dependencia circular entre esos dos.
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

// Marca que un usuario leyó una conversación hasta cierto mensaje (se usa
// tanto al pedir mensajes como al mandar uno: mandar también es "leer").
async function marcarLeido(pool, conversacionId, usuarioId, mensajeId) {
  await pool
    .request()
    .input("conversacionId", sql.Int, conversacionId)
    .input("usuarioId", sql.Int, usuarioId)
    .input("ultimoMensajeId", sql.Int, mensajeId)
    .query(`
      MERGE app_chat_lecturas AS destino
      USING (SELECT @conversacionId AS conversacion_id, @usuarioId AS usuario_id) AS origen
        ON destino.conversacion_id = origen.conversacion_id AND destino.usuario_id = origen.usuario_id
      WHEN MATCHED THEN
        UPDATE SET ultimo_mensaje_id = @ultimoMensajeId
      WHEN NOT MATCHED THEN
        INSERT (conversacion_id, usuario_id, ultimo_mensaje_id)
        VALUES (@conversacionId, @usuarioId, @ultimoMensajeId);
    `);
}

// Hasta qué mensaje leyó cada uno de los OTROS participantes (todos menos
// el que pregunta). Se usa para calcular "visto" en los mensajes propios.
async function obtenerLecturasDeOtros(pool, conversacionId, usuarioId) {
  const otros = await pool
    .request()
    .input("conversacionId", sql.Int, conversacionId)
    .input("usuarioId", sql.Int, usuarioId)
    .query(`
      SELECT p.usuario_id, COALESCE(l.ultimo_mensaje_id, 0) AS ultimo_mensaje_id
      FROM app_chat_participantes p
      LEFT JOIN app_chat_lecturas l
        ON l.conversacion_id = p.conversacion_id AND l.usuario_id = p.usuario_id
      WHERE p.conversacion_id = @conversacionId AND p.usuario_id <> @usuarioId
    `);
  return otros.recordset;
}

module.exports = { verificarAcceso, marcarLeido, obtenerLecturasDeOtros };
