const express = require("express");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Trae la config del usuario logueado. Si nunca la guardó, devuelve el
// default ("claro") sin necesidad de tener fila en la tabla.
router.get("/config", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .query("SELECT tema FROM app_config_usuario WHERE usuario_id = @usuarioId");

    const tema = resultado.recordset[0]?.tema || "claro";
    res.json({ tema });
  } catch (error) {
    console.error("Error trayendo configuración:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/config", async (req, res) => {
  const { tema } = req.body;

  if (tema !== "claro" && tema !== "oscuro") {
    return res.status(400).json({ error: "Tema inválido" });
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .input("tema", sql.NVarChar, tema)
      .query(`
        MERGE app_config_usuario AS destino
        USING (SELECT @usuarioId AS usuario_id, @tema AS tema) AS origen
        ON destino.usuario_id = origen.usuario_id
        WHEN MATCHED THEN UPDATE SET tema = origen.tema
        WHEN NOT MATCHED THEN INSERT (usuario_id, tema) VALUES (origen.usuario_id, origen.tema);
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error guardando configuración:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
