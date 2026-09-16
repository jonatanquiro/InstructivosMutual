const { Server } = require("socket.io");
const { sql, getPool } = require("./db");
const { registrarActividad } = require("./presencia");
const { verificarAcceso, marcarLeido } = require("../routes/chat-datos");

// Instancia única del server de sockets, seteada recién en inicializar().
// Las rutas HTTP del chat importan emitirAConversacion/emitirAUsuario para
// avisar en tiempo real (mensaje nuevo, visto, conversación nueva) sin
// depender de que el navegador esté sondeando cada tantos segundos —
// sondeo que además el propio navegador frena solo cuando la pestaña queda
// de fondo mucho tiempo.
let io = null;

const salaConversacion = (id) => `conversacion:${id}`;
const salaUsuario = (id) => `usuario:${id}`;

// Mete al socket en la sala de cada conversación de la que el usuario ya
// participa (la grupal siempre, más sus privadas/grupos), para que le
// lleguen los mensajes nuevos de entrada sin tener que pedirlo él.
async function unirseASusConversaciones(socket, usuarioId) {
  const pool = await getPool();
  const resultado = await pool
    .request()
    .input("usuarioId", sql.Int, usuarioId)
    .query(`
      SELECT id FROM app_chat_conversaciones WHERE tipo = 'grupal'
      UNION
      SELECT conversacion_id AS id FROM app_chat_participantes WHERE usuario_id = @usuarioId
    `);
  for (const fila of resultado.recordset) socket.join(salaConversacion(fila.id));
}

// sessionMiddleware es la MISMA instancia que usa server.js con
// express-session: así el socket queda asociado al usuario logueado usando
// la cookie de sesión que el navegador ya manda, sin inventar otro login.
function inicializar(servidorHttp, sessionMiddleware) {
  io = new Server(servidorHttp);
  io.engine.use(sessionMiddleware);

  io.on("connection", (socket) => {
    const usuarioId = socket.request.session?.usuarioId;
    if (!usuarioId) {
      socket.disconnect(true);
      return;
    }

    socket.join(salaUsuario(usuarioId));
    registrarActividad(usuarioId);
    unirseASusConversaciones(socket, usuarioId).catch((error) =>
      console.error("Error uniendo socket a sus conversaciones:", error)
    );

    // Mientras el socket siga conectado (pestaña abierta, aunque esté de
    // fondo) seguimos marcando actividad, para que "en línea" no dependa
    // de que mande pedidos HTTP sueltos mientras solo está chateando.
    const intervaloActividad = setInterval(() => registrarActividad(usuarioId), 30000);
    socket.on("disconnect", () => clearInterval(intervaloActividad));

    // El cliente lo manda cuando un mensaje le llega por socket a una
    // conversación que tiene abierta en pantalla en ese momento, para no
    // esperar al próximo GET de mensajes para marcarlo como leído.
    socket.on("marcarLeido", async ({ conversacionId, mensajeId } = {}) => {
      const id = Number(conversacionId);
      const msgId = Number(mensajeId);
      if (!id || !msgId) return;
      try {
        const pool = await getPool();
        const acceso = await verificarAcceso(pool, id, usuarioId);
        if (!acceso) return;
        await marcarLeido(pool, id, usuarioId, msgId);
        emitirAConversacion(id, "lecturaActualizada", { conversacionId: id, usuarioId, ultimoMensajeId: msgId });
      } catch (error) {
        console.error("Error marcando leído por socket:", error);
      }
    });
  });
}

function emitirAConversacion(conversacionId, evento, datos) {
  if (io) io.to(salaConversacion(conversacionId)).emit(evento, datos);
}

function emitirAUsuario(usuarioId, evento, datos) {
  if (io) io.to(salaUsuario(usuarioId)).emit(evento, datos);
}

// Fuerza a los sockets ya conectados de un usuario a sumarse a la sala de
// una conversación recién creada (grupo o DM nuevo), sin que el cliente
// tenga que pedirlo — la decisión de quién participa la toma el servidor
// en el momento de crearla, no un socket event en el que habría que
// revalidar el acceso.
function unirUsuarioAConversacion(usuarioId, conversacionId) {
  if (io) io.in(salaUsuario(usuarioId)).socketsJoin(salaConversacion(conversacionId));
}

module.exports = { inicializar, emitirAConversacion, emitirAUsuario, unirUsuarioAConversacion };
