const express = require("express");
const { sql, getPool } = require("../config/db");

const router = express.Router();

// Todas las rutas de este archivo ya pasaron por requiereLogin +
// requiereAdmin en server.js, así que acá asumimos que quien llama es admin.

// --- Módulos ---

router.get("/faq-admin/modulos", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT id, nombre, activo
      FROM app_modulos
      ORDER BY nombre
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error listando módulos (admin):", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/faq-admin/modulos", async (req, res) => {
  const { nombre } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: "El nombre del módulo es obligatorio" });
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("nombre", sql.NVarChar, nombre.trim())
      .query(`
        INSERT INTO app_modulos (nombre, activo)
        VALUES (@nombre, 1)
      `);
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Error creando módulo:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/faq-admin/modulos/:id", async (req, res) => {
  const { nombre, activo } = req.body;
  const id = Number(req.params.id);

  if (!nombre || !nombre.trim() || typeof activo !== "boolean") {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("nombre", sql.NVarChar, nombre.trim())
      .input("activo", sql.Bit, activo)
      .query(`
        UPDATE app_modulos
        SET nombre = @nombre, activo = @activo
        WHERE id = @id
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error actualizando módulo:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// --- Preguntas ---

// Preguntas anidadas: una pregunta con padre es una opción de ese padre, y
// siempre vive en el mismo módulo que él (el módulo se toma del padre).
// Devuelve el módulo del padre, o un mensaje de error si el padre no sirve
// (no existe, o es la misma pregunta / una de sus hijas, lo que haría un ciclo).
async function validarPadre(pool, preguntaId, padreId) {
  const resultado = await pool
    .request()
    .input("padreId", sql.Int, padreId)
    .query(`
      WITH ancestros AS (
        SELECT id, padre_id, modulo_id, 0 AS nivel FROM app_preguntas WHERE id = @padreId
        UNION ALL
        SELECT p.id, p.padre_id, p.modulo_id, a.nivel + 1
        FROM app_preguntas p JOIN ancestros a ON p.id = a.padre_id
      )
      SELECT id, modulo_id, nivel FROM ancestros
    `);
  const cadena = resultado.recordset;
  if (cadena.length === 0) return { error: "La pregunta padre no existe" };
  if (preguntaId && cadena.some((p) => p.id === preguntaId)) {
    return { error: "Una pregunta no puede depender de sí misma ni de una de sus opciones" };
  }
  return { moduloId: cadena.find((p) => p.nivel === 0).modulo_id };
}

router.get("/faq-admin/preguntas", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT p.id, p.modulo_id, m.nombre AS modulo_nombre, p.padre_id,
             p.pregunta, p.respuesta, p.activo
      FROM app_preguntas p
      JOIN app_modulos m ON m.id = p.modulo_id
      ORDER BY m.nombre, p.pregunta
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error listando preguntas (admin):", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/faq-admin/preguntas", async (req, res) => {
  let { moduloId, padreId, pregunta, respuesta } = req.body;
  padreId = padreId ? Number(padreId) : null;

  if ((!moduloId && !padreId) || !pregunta || !pregunta.trim() || !respuesta || !respuesta.trim()) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const pool = await getPool();
    if (padreId) {
      const validacion = await validarPadre(pool, null, padreId);
      if (validacion.error) return res.status(400).json({ error: validacion.error });
      moduloId = validacion.moduloId;
    }
    await pool
      .request()
      .input("moduloId", sql.Int, moduloId)
      .input("padreId", sql.Int, padreId)
      .input("pregunta", sql.NVarChar, pregunta.trim())
      .input("respuesta", sql.NVarChar, respuesta.trim())
      .query(`
        INSERT INTO app_preguntas (modulo_id, padre_id, pregunta, respuesta, activo)
        VALUES (@moduloId, @padreId, @pregunta, @respuesta, 1)
      `);
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Error creando pregunta:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/faq-admin/preguntas/:id", async (req, res) => {
  let { moduloId, padreId, pregunta, respuesta, activo } = req.body;
  padreId = padreId ? Number(padreId) : null;
  const id = Number(req.params.id);

  if (
    (!moduloId && !padreId) ||
    !pregunta ||
    !pregunta.trim() ||
    !respuesta ||
    !respuesta.trim() ||
    typeof activo !== "boolean"
  ) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  try {
    const pool = await getPool();
    if (padreId) {
      const validacion = await validarPadre(pool, id, padreId);
      if (validacion.error) return res.status(400).json({ error: validacion.error });
      moduloId = validacion.moduloId;
    }
    // Si cambia de módulo, sus opciones (y las opciones de ellas) se mudan
    // con ella, para que nunca quede una hija en otro módulo que su padre.
    await pool
      .request()
      .input("id", sql.Int, id)
      .input("moduloId", sql.Int, moduloId)
      .input("padreId", sql.Int, padreId)
      .input("pregunta", sql.NVarChar, pregunta.trim())
      .input("respuesta", sql.NVarChar, respuesta.trim())
      .input("activo", sql.Bit, activo)
      .query(`
        UPDATE app_preguntas
        SET modulo_id = @moduloId, padre_id = @padreId, pregunta = @pregunta,
            respuesta = @respuesta, activo = @activo
        WHERE id = @id;

        WITH descendientes AS (
          SELECT id FROM app_preguntas WHERE padre_id = @id
          UNION ALL
          SELECT p.id FROM app_preguntas p JOIN descendientes d ON p.padre_id = d.id
        )
        UPDATE app_preguntas SET modulo_id = @moduloId
        WHERE id IN (SELECT id FROM descendientes);
      `);
    res.json({ ok: true });
  } catch (error) {
    console.error("Error actualizando pregunta:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// --- Estadísticas / analítica ---
// Todo basado en app_consultas_log, que ya se viene llenando desde que el
// usuario abre una respuesta en el chat de preguntas frecuentes.

router.get("/faq-admin/estadisticas/resumen", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM app_modulos WHERE activo = 1) AS modulosActivos,
        (SELECT COUNT(*) FROM app_preguntas WHERE activo = 1) AS preguntasActivas,
        (SELECT COUNT(*) FROM app_consultas_log) AS consultasTotales,
        (SELECT COUNT(*) FROM app_consultas_log WHERE fecha >= DATEADD(DAY, -30, GETDATE())) AS consultasUltimos30Dias
    `);
    res.json(resultado.recordset[0]);
  } catch (error) {
    console.error("Error trayendo resumen de estadísticas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/faq-admin/estadisticas/top-preguntas", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT TOP 15 p.id, p.pregunta, m.nombre AS modulo_nombre, COUNT(c.id) AS consultas
      FROM app_preguntas p
      JOIN app_modulos m ON m.id = p.modulo_id
      JOIN app_consultas_log c ON c.pregunta_id = p.id
      GROUP BY p.id, p.pregunta, m.nombre
      ORDER BY COUNT(c.id) DESC
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo top de preguntas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/faq-admin/estadisticas/por-modulo", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT m.id, m.nombre, COUNT(c.id) AS consultas
      FROM app_modulos m
      LEFT JOIN app_preguntas p ON p.modulo_id = m.id
      LEFT JOIN app_consultas_log c ON c.pregunta_id = p.id
      WHERE m.activo = 1
      GROUP BY m.id, m.nombre
      ORDER BY COUNT(c.id) DESC
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo consultas por módulo:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Preguntas activas que nunca fueron consultadas: ayuda a detectar contenido
// que quizás no se entiende, no se encuentra o ya no hace falta.
router.get("/faq-admin/estadisticas/sin-consultas", async (req, res) => {
  try {
    const pool = await getPool();
    const resultado = await pool.request().query(`
      SELECT p.id, p.pregunta, m.nombre AS modulo_nombre
      FROM app_preguntas p
      JOIN app_modulos m ON m.id = p.modulo_id
      LEFT JOIN app_consultas_log c ON c.pregunta_id = p.id
      WHERE p.activo = 1 AND c.id IS NULL
      ORDER BY m.nombre, p.pregunta
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo preguntas sin consultas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
