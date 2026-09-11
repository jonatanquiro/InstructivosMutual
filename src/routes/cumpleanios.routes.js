const express = require("express");
const { getPool } = require("../config/db");

const router = express.Router();

// Trae los próximos 4 cumpleaños desde app_cumpleanios (cargada manualmente
// con scripts/cargar-cumpleanios.js a partir de la base UNION).
router.get("/cumpleanios", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT TOP 4
        nombre,
        CASE
          WHEN DATEFROMPARTS(YEAR(GETDATE()), MONTH(fecha_nacimiento), DAY(fecha_nacimiento)) >= CAST(GETDATE() AS DATE)
            THEN DATEFROMPARTS(YEAR(GETDATE()), MONTH(fecha_nacimiento), DAY(fecha_nacimiento))
          ELSE DATEFROMPARTS(YEAR(GETDATE()) + 1, MONTH(fecha_nacimiento), DAY(fecha_nacimiento))
        END AS proximoCumple
      FROM app_cumpleanios
      ORDER BY proximoCumple
    `);

    const cumples = resultado.recordset.map((fila) => ({
      nombre: fila.nombre,
      fecha: new Date(fila.proximoCumple).toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "2-digit",
      }),
    }));

    res.json(cumples);
  } catch (error) {
    console.error("Error trayendo cumpleaños:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
