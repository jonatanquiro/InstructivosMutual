const sql = require("mssql");

// Conexión separada a la base DW (datos mensuales de socios: cuotas,
// préstamos, plazos fijos, ahorros especiales, tarjetas, etc.). Vive aparte
// de la conexión principal (config/db.js) porque es otra base -y
// probablemente otro servidor- y porque acá solo hacemos lectura para
// estadísticas, nunca escritura.
const config = {
  server: process.env.DW_DB_SERVER,
  database: process.env.DW_DB_DATABASE,
  user: process.env.DW_DB_USER,
  password: process.env.DW_DB_PASSWORD,
  port: Number(process.env.DW_DB_PORT || 1433),
  options: {
    trustServerCertificate: process.env.DW_DB_TRUST_SERVER_CERT === "true",
  },
};

// Importante: usamos "new sql.ConnectionPool" (no "sql.connect", que ya usa
// config/db.js) para que este pool no pise el pool global de la otra base.
let poolPromise = null;

function getPoolDW() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect();
  }
  return poolPromise;
}

module.exports = { sql, getPoolDW };
