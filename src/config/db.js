const sql = require("mssql");

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT || 1433),
  options: {
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT === "true",
  },
};

// mssql arma internamente un pool de conexiones reutilizables. Guardamos
// la promesa de conexión (no la conexión en sí) para que, si dos pedidos
// HTTP llegan al mismo tiempo antes de que termine de conectar, ambos
// esperen la misma conexión en vez de abrir dos pools por separado.
let poolPromise = null;

async function getPool() {
  if (poolPromise) {
    try {
      const pool = await poolPromise;
      if (pool.connected) return pool;
    } catch (error) {
      // Si la conexión falló la última vez, reintentamos en vez de quedar
      // devolviendo el mismo error para siempre hasta reiniciar el proceso.
    }
    poolPromise = null;
  }

  poolPromise = sql.connect(config).catch((error) => {
    poolPromise = null;
    throw error;
  });
  return poolPromise;
}

module.exports = { sql, getPool };
