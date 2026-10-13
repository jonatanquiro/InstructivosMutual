const express = require("express");
const { requiereAdmin } = require("../middleware/auth");
const { chatActivo, guardarAjuste } = require("../config/ajustes");

// Montado en /api/ajustes con requiereLogin. Cualquier usuario puede leerlos
// (el menú y comun.js los usan para mostrar u ocultar el chat); sólo un admin
// puede cambiarlos.
const router = express.Router();

router.get("/", async (req, res) => {
  res.json({ chatActivo: await chatActivo() });
});

router.put("/", requiereAdmin, async (req, res) => {
  const { chatActivo: activo } = req.body;
  if (typeof activo !== "boolean") return res.status(400).json({ error: "Valor inválido" });
  try {
    await guardarAjuste("chat_activo", activo ? "1" : "0", req.session.usuarioId);
    res.json({ chatActivo: activo });
  } catch (error) {
    console.error("Error guardando ajustes generales:", error);
    res.status(500).json({ error: "No se pudo guardar (¿se corrió sql/agregar_ajustes.sql?)" });
  }
});

module.exports = router;
