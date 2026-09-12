const express = require("express");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Devuelve todos los módulos activos con sus preguntas activas anidadas,
// listo para que el frontend pinte el menú de un tirón.
router.get("/modulos", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT m.id AS modulo_id, m.nombre AS modulo_nombre, m.orden AS modulo_orden,
             p.id AS pregunta_id, p.pregunta, p.respuesta, p.orden AS pregunta_orden
      FROM app_modulos m
      LEFT JOIN app_preguntas p ON p.modulo_id = m.id AND p.activo = 1
      WHERE m.activo = 1
      ORDER BY m.nombre, p.pregunta
    `);

    // Agrupamos las filas planas (join) en la estructura anidada que
    // espera el frontend: [{ id, nombre, preguntas: [...] }, ...]
    const modulosPorId = new Map();
    for (const fila of resultado.recordset) {
      if (!modulosPorId.has(fila.modulo_id)) {
        modulosPorId.set(fila.modulo_id, {
          id: fila.modulo_id,
          nombre: fila.modulo_nombre,
          preguntas: [],
        });
      }
      if (fila.pregunta_id) {
        modulosPorId.get(fila.modulo_id).preguntas.push({
          id: fila.pregunta_id,
          pregunta: fila.pregunta,
          respuesta: fila.respuesta,
        });
      }
    }

    res.json(Array.from(modulosPorId.values()));
  } catch (error) {
    console.error("Error trayendo módulos:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Registra en el log que un usuario consultó una pregunta puntual.
// No es bloqueante para la experiencia: si falla, no rompemos la respuesta
// que el usuario ya está viendo, solo lo logueamos por consola.
router.post("/preguntas/:id/consulta", async (req, res) => {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input("usuarioId", sql.Int, req.session.usuarioId)
      .input("preguntaId", sql.Int, req.params.id)
      .query(`
        INSERT INTO app_consultas_log (usuario_id, pregunta_id)
        VALUES (@usuarioId, @preguntaId)
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error registrando consulta (no crítico):", error);
    res.json({ ok: false });
  }
});

module.exports = router;
