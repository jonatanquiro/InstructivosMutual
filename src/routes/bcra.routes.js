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

function mapearEntidadesDeuda(entidades) {
  return (entidades || []).map((entidad) => ({
    entidad: entidad.entidad,
    situacion: entidad.situacion,
    situacionDescripcion: DESCRIPCION_SITUACION[entidad.situacion] || `Situación ${entidad.situacion}`,
    // El BCRA expresa "monto" en miles de pesos.
    monto: Number(entidad.monto) * 1000,
    diasAtrasoPago: entidad.diasAtrasoPago || 0,
    enRevision: !!entidad.enRevision,
    procesoJudicial: !!entidad.procesoJud,
  }));
}

// La API de cheques no informa el nombre de la entidad, solo su código
// numérico BCRA (a diferencia del endpoint de deudas, que sí trae el
// nombre completo).
function mapearCausalesCheques(causales) {
  return (causales || []).map((causal) => ({
    causal: causal.causal,
    entidades: (causal.entidades || []).map((entidad) => ({
      entidad: entidad.entidad,
      detalle: (entidad.detalle || []).map((d) => ({
        nroCheque: d.nroCheque,
        fechaRechazo: d.fechaRechazo,
        monto: Number(d.monto) || 0,
        fechaPago: d.fechaPago,
        fechaPagoMulta: d.fechaPagoMulta,
        estadoMulta: d.estadoMulta,
        ctaPersonal: !!d.ctaPersonal,
        denomJuridica: d.denomJuridica,
        enRevision: !!d.enRevision,
        procesoJudicial: !!d.procesoJud,
      })),
    })),
  }));
}

// La Central de Deudores del BCRA (API pública, sin autenticación) informa
// tres cosas para un CUIT/CUIL: deudas del último período, historial de
// deudas (24 meses) y cheques rechazados. Acá se piden en paralelo las dos
// últimas, para mostrar todo junto en una sola consulta.
async function consultarBcra(ruta, cuit) {
  const respuesta = await fetch(`https://api.bcra.gob.ar/centraldedeudores/v1.0/${ruta}/${cuit}`);

  if (respuesta.status === 404) {
    return null;
  }
  if (!respuesta.ok) {
    throw new Error(`BCRA respondió ${respuesta.status} en ${ruta}`);
  }

  const datos = await respuesta.json();
  return datos.results;
}

router.get("/bcra/deudas/:cuit", async (req, res) => {
  const cuit = limpiarCuit(req.params.cuit);

  if (cuit.length !== 11) {
    return res.status(400).json({ error: "El CUIT/CUIL debe tener 11 dígitos" });
  }

  try {
    const [deudas, cheques] = await Promise.all([
      consultarBcra("Deudas/Historicas", cuit),
      consultarBcra("Deudas/ChequesRechazados", cuit),
    ]);

    if (!deudas && !cheques) {
      return res.status(404).json({ error: "El BCRA no tiene información registrada para ese CUIT/CUIL" });
    }

    res.json({
      identificacion: deudas?.identificacion || cheques?.identificacion,
      denominacion: deudas?.denominacion || cheques?.denominacion,
      periodos: (deudas?.periodos || []).map((p) => ({
        periodo: p.periodo,
        entidades: mapearEntidadesDeuda(p.entidades),
      })),
      chequesRechazados: mapearCausalesCheques(cheques?.causales),
    });
  } catch (error) {
    console.error("Error consultando Central de Deudores del BCRA:", error);
    res.status(502).json({ error: "No se pudo conectar con el servicio del BCRA" });
  }
});

module.exports = router;
