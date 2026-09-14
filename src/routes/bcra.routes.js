const express = require("express");

const router = express.Router();

// Situaciones de deudor según la Central de Deudores del BCRA. 1 es la
// única "buena" (normal); de 2 en adelante indica algún grado de mora.
const DESCRIPCION_SITUACION = {
  1: "Normal",
  2: "Riesgo bajo",
  3: "Riesgo medio",
  4: "Riesgo alto",
  5: "Irrecuperable",
  6: "Irrecuperable por disposición técnica",
};

function limpiarCuit(cuit) {
  return String(cuit || "").replace(/\D/g, "");
}

// Consulta la Central de Deudores del BCRA (API pública, sin autenticación)
// para un CUIT/CUIL. Solo trae el período más reciente informado, que es
// el que importa para saber la situación actual.
router.get("/bcra/deudas/:cuit", async (req, res) => {
  const cuit = limpiarCuit(req.params.cuit);

  if (cuit.length !== 11) {
    return res.status(400).json({ error: "El CUIT/CUIL debe tener 11 dígitos" });
  }

  try {
    const respuestaBcra = await fetch(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuit}`);

    if (respuestaBcra.status === 404) {
      return res.status(404).json({ error: "El BCRA no tiene deudas registradas para ese CUIT/CUIL" });
    }

    if (!respuestaBcra.ok) {
      console.error("BCRA respondió con error:", respuestaBcra.status);
      return res.status(502).json({ error: "El servicio del BCRA no respondió correctamente" });
    }

    const datos = await respuestaBcra.json();
    const resultados = datos.results;
    const primerPeriodo = resultados?.periodos?.[0];

    if (!primerPeriodo) {
      return res.status(404).json({ error: "El BCRA no tiene deudas registradas para ese CUIT/CUIL" });
    }

    res.json({
      identificacion: resultados.identificacion,
      denominacion: resultados.denominacion,
      periodo: primerPeriodo.periodo,
      entidades: primerPeriodo.entidades.map((entidad) => ({
        entidad: entidad.entidad,
        situacion: entidad.situacion,
        situacionDescripcion: DESCRIPCION_SITUACION[entidad.situacion] || `Situación ${entidad.situacion}`,
        // El BCRA expresa "monto" en miles de pesos.
        monto: Number(entidad.monto) * 1000,
        diasAtrasoPago: entidad.diasAtrasoPago || 0,
        enRevision: !!entidad.enRevision,
        procesoJudicial: !!entidad.procesoJud,
      })),
    });
  } catch (error) {
    console.error("Error consultando Central de Deudores del BCRA:", error);
    res.status(502).json({ error: "No se pudo conectar con el servicio del BCRA" });
  }
});

module.exports = router;
