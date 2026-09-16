// Vacía TODO el chat interno: mensajes, conversaciones privadas/grupos,
// participantes, lecturas, reacciones y las imágenes adjuntas en disco.
// Deja el canal "General" recién creado, igual que una instalación nueva
// (ver sql/schema.sql). No toca usuarios, fotos de perfil ni el resto de
// la base.
//
// Pensado sobre todo para limpiar la instancia de TESTEO entre pruebas.
// Pide confirmación escrita antes de borrar nada.
//
// Uso:
//   node scripts/vaciar-chat.js                 -> usa .env (producción)
//   set ENV_FILE=.env.test&& node scripts/vaciar-chat.js  -> usa .env.test

require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { sql, getPool } = require("../src/config/db");

// Mismo criterio que chat.routes.js: CHAT_UPLOADS_DIR puede ser una ruta
// relativa a src/ o una ruta absoluta (por ejemplo en otro disco).
const carpetaConfigurada = process.env.CHAT_UPLOADS_DIR || "uploads/chat";
const CARPETA_UPLOADS_CHAT = path.isAbsolute(carpetaConfigurada)
  ? carpetaConfigurada
  : path.join(__dirname, "..", "src", carpetaConfigurada);

function preguntar(mensaje) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(mensaje, (respuesta) => {
    rl.close();
    resolve(respuesta);
  }));
}

async function main() {
  console.log(`Base: ${process.env.DB_DATABASE} (server ${process.env.DB_SERVER})`);
  console.log(`Carpeta de imágenes del chat: ${CARPETA_UPLOADS_CHAT}`);
  console.log("");
  console.log("Esto borra TODOS los mensajes, conversaciones privadas y grupos,");
  console.log("reacciones, y las imágenes adjuntas del chat. NO se puede deshacer.");
  console.log("");

  const respuesta = await preguntar('Escribí "borrar" para confirmar: ');
  if (respuesta.trim().toLowerCase() !== "borrar") {
    console.log("Cancelado, no se borró nada.");
    return;
  }

  const pool = await getPool();

  // Orden por las foreign keys: reacciones/lecturas/mensajes dependen de
  // conversaciones (y reacciones también de mensajes), así que se borran
  // de adentro hacia afuera.
  await pool.request().query("DELETE FROM app_chat_reacciones");
  await pool.request().query("DELETE FROM app_chat_lecturas");
  await pool.request().query("DELETE FROM app_chat_mensajes");
  await pool.request().query("DELETE FROM app_chat_participantes");
  await pool.request().query("DELETE FROM app_chat_conversaciones");
  await pool.request().query("DBCC CHECKIDENT ('app_chat_mensajes', RESEED, 0)");
  await pool.request().query("DBCC CHECKIDENT ('app_chat_conversaciones', RESEED, 0)");
  await pool.request().query("INSERT INTO app_chat_conversaciones (tipo, nombre) VALUES ('grupal', 'General')");

  let borrados = 0;
  if (fs.existsSync(CARPETA_UPLOADS_CHAT)) {
    for (const archivo of fs.readdirSync(CARPETA_UPLOADS_CHAT)) {
      fs.unlinkSync(path.join(CARPETA_UPLOADS_CHAT, archivo));
      borrados++;
    }
  }

  console.log(`Listo: chat vaciado (${borrados} imagen(es) borrada(s)). Queda "General" sin mensajes.`);
  await sql.close();
}

main().catch((err) => {
  console.error("Error vaciando el chat:", err);
  process.exit(1);
});
