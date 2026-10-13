const { sql, getPool } = require("./db");

// Ajustes generales (tabla app_ajustes, ver sql/agregar_ajustes.sql): valen
// para todos los usuarios y los cambia un admin desde Configuración.
//
// Se consultan en casi todos los requests del chat, así que se guardan unos
// segundos en memoria. Si la tabla todavía no existe (falta correr el
// script) o la base falla, se usa el valor por defecto: chat APAGADO.

const DEFECTOS = { chat_activo: "0" };
const DURACION_CACHE_MS = 5000;
let cache = null;

async function leerAjustes() {
  if (cache && Date.now() - cache.hora < DURACION_CACHE_MS) return cache.valores;
  let valores = { ...DEFECTOS };
  try {
    const pool = await getPool();
    const r = await pool.request().query("SELECT clave, valor FROM app_ajustes");
    for (const fila of r.recordset) valores[fila.clave] = fila.valor;
  } catch (error) {
    console.error("No se pudieron leer los ajustes generales (se usan los de por defecto):", error.message);
    valores = { ...DEFECTOS };
  }
  cache = { hora: Date.now(), valores };
  return valores;
}

async function chatActivo() {
  return (await leerAjustes()).chat_activo === "1";
}

async function guardarAjuste(clave, valor, usuarioId) {
  const pool = await getPool();
  await pool
    .request()
    .input("clave", sql.NVarChar, clave)
    .input("valor", sql.NVarChar, String(valor))
    .input("usuarioId", sql.Int, usuarioId)
    .query(`
      MERGE app_ajustes AS destino
      USING (SELECT @clave AS clave) AS origen ON destino.clave = origen.clave
      WHEN MATCHED THEN UPDATE SET valor = @valor, modificado_por = @usuarioId, fecha_modificacion = GETDATE()
      WHEN NOT MATCHED THEN INSERT (clave, valor, modificado_por) VALUES (@clave, @valor, @usuarioId);
    `);
  cache = null; // que el cambio se vea al instante
}

module.exports = { chatActivo, guardarAjuste };
