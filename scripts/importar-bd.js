// Importa el JSON generado por exportar-bd.js a una base NUEVA (que ya
// tenga las tablas creadas vía sql/schema.sql + los sql/agregar_*.sql, pero
// sin datos todavía). Respeta los IDs originales (IDENTITY_INSERT) para que
// las relaciones (FKs) sigan siendo válidas.
//
// Uso: node scripts/importar-bd.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { sql, getPool } = require("../src/config/db");

// Orden importante: las tablas con FK van después de la tabla que referencian.
const TABLAS = [
  { nombre: "app_modulos", identity: "id" },
  { nombre: "app_usuarios", identity: "id" },
  { nombre: "app_preguntas", identity: "id" },
  { nombre: "app_config_usuario", identity: null },
  { nombre: "app_cumpleanios", identity: "id" },
  { nombre: "app_consultas_log", identity: "id" },
];

async function importarTabla(pool, tabla, filas, columnaIdentity) {
  if (!filas || filas.length === 0) {
    console.log(`  ${tabla}: sin datos para importar`);
    return;
  }

  if (columnaIdentity) {
    await pool.request().query(`SET IDENTITY_INSERT ${tabla} ON`);
  }

  for (const fila of filas) {
    const columnas = Object.keys(fila);
    const request = pool.request();
    for (const columna of columnas) {
      request.input(columna, fila[columna]);
    }
    const listaColumnas = columnas.join(", ");
    const listaParametros = columnas.map((c) => `@${c}`).join(", ");
    await request.query(`INSERT INTO ${tabla} (${listaColumnas}) VALUES (${listaParametros})`);
  }

  if (columnaIdentity) {
    await pool.request().query(`SET IDENTITY_INSERT ${tabla} OFF`);
  }

  console.log(`  ${tabla}: ${filas.length} filas importadas`);
}

async function main() {
  const rutaEntrada = path.join(__dirname, "datos", "export-bd.json");
  const datos = JSON.parse(fs.readFileSync(rutaEntrada, "utf-8"));

  const pool = await getPool();

  for (const { nombre, identity } of TABLAS) {
    await importarTabla(pool, nombre, datos[nombre], identity);
  }

  console.log("\nListo: importación terminada.");
  await sql.close();
}

main().catch((err) => {
  console.error("Error importando:", err);
  process.exit(1);
});
