// Carga (o recarga) módulos y preguntas en la base desde scripts/datos/preguntas.json.
// Es "todo o nada": borra lo que había en app_modulos/app_preguntas y vuelve a
// insertar todo desde el archivo. El archivo JSON es la fuente de verdad.
//
// Uso: node scripts/cargar-preguntas.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { sql, getPool } = require("../src/config/db");

async function main() {
  const rutaJson = path.join(__dirname, "datos", "preguntas.json");
  const { modulos } = JSON.parse(fs.readFileSync(rutaJson, "utf-8"));

  const pool = await getPool();

  // Reinicio limpio. app_consultas_log tiene FK a app_preguntas, así que
  // se borra primero (si no, SQL Server no deja borrar app_preguntas).
  await pool.request().query("DELETE FROM app_consultas_log");
  await pool.request().query("DELETE FROM app_preguntas");
  await pool.request().query("DELETE FROM app_modulos");
  // Reseteamos los contadores de IDENTITY para que arranque de 1 de nuevo.
  await pool.request().query("DBCC CHECKIDENT ('app_preguntas', RESEED, 0)");
  await pool.request().query("DBCC CHECKIDENT ('app_modulos', RESEED, 0)");

  let totalPreguntas = 0;

  for (let i = 0; i < modulos.length; i++) {
    const modulo = modulos[i];

    const resultadoModulo = await pool
      .request()
      .input("nombre", sql.NVarChar, modulo.nombre)
      .input("orden", sql.Int, i)
      .query(`
        INSERT INTO app_modulos (nombre, orden)
        OUTPUT INSERTED.id
        VALUES (@nombre, @orden)
      `);
    const moduloId = resultadoModulo.recordset[0].id;

    for (let j = 0; j < modulo.preguntas.length; j++) {
      const pregunta = modulo.preguntas[j];
      await pool
        .request()
        .input("moduloId", sql.Int, moduloId)
        .input("pregunta", sql.NVarChar, pregunta.pregunta)
        .input("respuesta", sql.NVarChar(sql.MAX), pregunta.respuesta)
        .input("orden", sql.Int, j)
        .query(`
          INSERT INTO app_preguntas (modulo_id, pregunta, respuesta, orden)
          VALUES (@moduloId, @pregunta, @respuesta, @orden)
        `);
      totalPreguntas += 1;
    }

    console.log(`  Módulo "${modulo.nombre}": ${modulo.preguntas.length} preguntas`);
  }

  console.log(`\nListo: ${modulos.length} módulos, ${totalPreguntas} preguntas cargadas.`);
  await sql.close();
}

main().catch((err) => {
  console.error("Error cargando preguntas:", err);
  process.exit(1);
});
