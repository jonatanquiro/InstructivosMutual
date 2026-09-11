// Carga (o recarga) los cumpleaños en la base desde scripts/datos/cumpleanios.json.
// Es "todo o nada": borra lo que había en app_cumpleanios y vuelve a insertar
// todo desde el archivo. El archivo JSON es la fuente de verdad.
//
// Los datos salen de la base UNION con:
//   USE [UNION]; SELECT SONOMB, SOFENA FROM somaesgral WHERE DIRECTIVO=1
//
// Uso: node scripts/cargar-cumpleanios.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { sql, getPool } = require("../src/config/db");

async function main() {
  const rutaJson = path.join(__dirname, "datos", "cumpleanios.json");
  const { personas } = JSON.parse(fs.readFileSync(rutaJson, "utf-8"));

  const pool = await getPool();

  await pool.request().query("DELETE FROM app_cumpleanios");
  await pool.request().query("DBCC CHECKIDENT ('app_cumpleanios', RESEED, 0)");

  for (const persona of personas) {
    await pool
      .request()
      .input("nombre", sql.NVarChar, persona.nombre)
      .input("fecha", sql.Date, persona.fecha)
      .query(`
        INSERT INTO app_cumpleanios (nombre, fecha_nacimiento)
        VALUES (@nombre, @fecha)
      `);
  }

  console.log(`Listo: ${personas.length} cumpleaños cargados.`);
  await sql.close();
}

main().catch((err) => {
  console.error("Error cargando cumpleaños:", err);
  process.exit(1);
});
