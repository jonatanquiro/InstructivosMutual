const fs = require("fs/promises");
const path = require("path");
const { sql, getPool } = require("../config/db");

const HORAS_RETENCION = 48;
const CARPETA_UPLOADS = path.join(__dirname, "..", "uploads", "chat");

// Borra mensajes de chat (y sus imágenes) con más de HORAS_RETENCION.
// Pensado para correr periódicamente desde server.js: el chat es para
// coordinación del día a día, no para quedar como historial permanente.
async function limpiarMensajesViejos() {
  try {
    const pool = await getPool();

    const viejos = await pool.request().query(`
      SELECT id, imagen_archivo
      FROM app_chat_mensajes
      WHERE fecha < DATEADD(HOUR, -${HORAS_RETENCION}, GETDATE())
    `);

    if (viejos.recordset.length === 0) return;

    for (const mensaje of viejos.recordset) {
      if (mensaje.imagen_archivo) {
        await fs.unlink(path.join(CARPETA_UPLOADS, mensaje.imagen_archivo)).catch(() => {});
      }
    }

    await pool.request().query(`
      DELETE FROM app_chat_mensajes
      WHERE fecha < DATEADD(HOUR, -${HORAS_RETENCION}, GETDATE())
    `);

    console.log(`Limpieza de chat: se borraron ${viejos.recordset.length} mensaje(s) viejos.`);
  } catch (error) {
    console.error("Error en limpieza de chat (no crítico):", error);
  }
}

module.exports = { limpiarMensajesViejos };
