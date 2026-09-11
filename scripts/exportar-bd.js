// Exporta el contenido de todas las tablas de la app a un JSON, para
// trasladarlo a otro server cuando no hay permiso de BACKUP DATABASE.
// No exporta esquema (eso ya está en sql/schema.sql + sql/agregar_*.sql),
// solo los datos.
//
// Uso: node scripts/exportar-bd.js
// Genera: scripts/datos/export-bd.json

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { sql, getPool } = require("../src/config/db");

const TABLAS = [
  "app_modulos",
  "app_preguntas",
  "app_usuarios",
  "app_config_usuario",
  "app_cumpleanios",
  "app_consultas_log",
];

async function main() {
  const pool = await getPool();
  const exportado = {};

  for (const tabla of TABLAS) {
    try {
      const resultado = await pool.request().query(`SELECT * FROM ${tabla}`);
      exportado[tabla] = resultado.recordset;
      console.log(`  ${tabla}: ${resultado.recordset.length} filas`);
    } catch (error) {
      console.warn(`  ${tabla}: no se pudo exportar (¿no existe todavía?) — ${error.message}`);
    }
  }

  const rutaSalida = path.join(__dirname, "datos", "export-bd.json");
  fs.writeFileSync(rutaSalida, JSON.stringify(exportado, null, 2), "utf-8");
  console.log(`\nListo: exportado a ${rutaSalida}`);
  await sql.close();
}

main().catch((err) => {
  console.error("Error exportando:", err);
  process.exit(1);
});
