const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const { ejecutarScript, ErrorMotor, RAIZ } = require("../config/motor");

const router = express.Router();

// La planilla que llevan a mano en préstamos (una hoja por mes). Se lee tal
// cual está, cada vez que cambia: no se copia a la base, así lo que se ve
// acá es siempre lo último que guardaron en el Excel.
const PLANILLA = process.env.PRESTAMOS_PLANILLA || "F:\\Textos\\CONTROL PRÉSTAMOS.xlsx";
const SCRIPT = path.join(RAIZ, "motor", "prestamos.py");

// Leerla con Python tarda un par de segundos: se guarda el resultado y sólo
// se vuelve a leer si el archivo tiene otra fecha de modificación.
let cache = null;

router.get("/prestamos", async (req, res) => {
  let modificado;
  try {
    modificado = (await fs.stat(PLANILLA)).mtimeMs;
  } catch (error) {
    return res.status(404).json({ error: `No se encuentra la planilla en «${PLANILLA}». Revisá que la ruta sea accesible desde el servidor.` });
  }

  try {
    if (!cache || cache.modificado !== modificado) {
      const datos = await ejecutarScript(SCRIPT, [], { archivo: PLANILLA }, 60 * 1000);
      if (!datos.ok) return res.status(422).json({ error: datos.error });
      cache = { modificado, datos };
    }
    res.json({
      archivo: path.basename(PLANILLA),
      actualizado: new Date(cache.modificado).toISOString(),
      hojas: cache.datos.hojas,
      solicitudes: cache.datos.solicitudes,
    });
  } catch (error) {
    if (!(error instanceof ErrorMotor)) console.error("Error leyendo la planilla de préstamos:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "No se pudo leer la planilla de préstamos." });
  }
});

module.exports = router;
