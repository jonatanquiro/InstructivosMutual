// Presencia "en línea" en memoria del proceso: no necesita tabla propia ni
// sobrevivir a un reinicio del servidor (si el server reinicia, no hay
// sesiones activas contra ese proceso nuevo, así que "todos desconectados"
// es lo correcto hasta el próximo request de cada uno).

const ultimaActividad = new Map();
const UMBRAL_MS = 45 * 1000;

function registrarActividad(usuarioId) {
  ultimaActividad.set(usuarioId, Date.now());
}

function estaEnLinea(usuarioId) {
  const ultima = ultimaActividad.get(usuarioId);
  return ultima !== undefined && Date.now() - ultima < UMBRAL_MS;
}

module.exports = { registrarActividad, estaEnLinea };
