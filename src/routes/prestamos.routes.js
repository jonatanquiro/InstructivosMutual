const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { ejecutarScript, ErrorMotor, RAIZ } = require("../config/motor");

const router = express.Router();

// La planilla que llevan a mano en préstamos (una hoja por mes) se sube desde
// la pestaña. Se guarda una sola, la última; la anterior queda como respaldo.
// PRESTAMOS_CARPETA puede ser absoluta (otro disco) o relativa a src/.
const CONFIGURADA = process.env.PRESTAMOS_CARPETA || "uploads/prestamos";
const CARPETA = path.isAbsolute(CONFIGURADA) ? CONFIGURADA : path.join(__dirname, "..", CONFIGURADA);
const PLANILLA = path.join(CARPETA, "planilla.xlsx");
const ANTERIOR = path.join(CARPETA, "planilla-anterior.xlsx");
const DATOS_SUBIDA = path.join(CARPETA, "planilla.json");
const SCRIPT = path.join(RAIZ, "motor", "prestamos.py");
fs.mkdirSync(CARPETA, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARPETA),
    filename: (req, file, cb) => cb(null, `subida-${crypto.randomUUID()}.xlsx`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname)),
});

// Leerla con Python tarda un par de segundos: se guarda el resultado y sólo
// se vuelve a leer cuando se sube otra.
let cache = null;

function leerPlanilla(archivo) {
  return ejecutarScript(SCRIPT, [], { archivo }, 60 * 1000);
}

function datosSubida() {
  try {
    return JSON.parse(fs.readFileSync(DATOS_SUBIDA, "utf8"));
  } catch (error) {
    return {};
  }
}

router.get("/prestamos", async (req, res) => {
  if (!fs.existsSync(PLANILLA)) return res.json({ sinPlanilla: true });

  try {
    if (!cache) {
      const datos = await leerPlanilla(PLANILLA);
      if (!datos.ok) return res.status(422).json({ error: datos.error });
      cache = datos;
    }
    res.json({ ...datosSubida(), hojas: cache.hojas, solicitudes: cache.solicitudes });
  } catch (error) {
    if (!(error instanceof ErrorMotor)) console.error("Error leyendo la planilla de préstamos:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "No se pudo leer la planilla de préstamos." });
  }
});

// Se lee antes de reemplazar: si la planilla nueva no se puede leer, queda la que estaba.
router.post("/prestamos/planilla", (req, res, next) => {
  upload.single("archivo")(req, res, (error) => {
    if (error) {
      const mensaje = error.code === "LIMIT_FILE_SIZE" ? "La planilla es demasiado grande (máximo 30 MB)." : "No se pudo recibir el archivo.";
      return res.status(400).json({ error: mensaje });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Tiene que ser una planilla de Excel (.xlsx)." });
  const temporal = req.file.path;
  const borrarTemporal = () => fs.promises.unlink(temporal).catch(() => {});

  try {
    const datos = await leerPlanilla(temporal);
    if (!datos.ok) {
      borrarTemporal();
      return res.status(422).json({ error: datos.error });
    }
    if (!datos.solicitudes.length) {
      borrarTemporal();
      return res.status(422).json({ error: "La planilla no tiene ninguna hoja con la columna SOCIO: ¿es la de control de préstamos?" });
    }

    if (fs.existsSync(PLANILLA)) fs.copyFileSync(PLANILLA, ANTERIOR);
    fs.renameSync(temporal, PLANILLA);
    // multer entrega el nombre original en latin1 (el navegador lo manda en UTF-8).
    const comoUtf8 = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const nombre = comoUtf8.includes("�") ? req.file.originalname : comoUtf8;
    fs.writeFileSync(DATOS_SUBIDA, JSON.stringify({
      archivo: nombre,
      subidaPor: req.session.nombreCompleto || "",
      subidaEl: new Date().toISOString(),
    }));
    cache = datos;
    res.json({ ok: true, solicitudes: datos.solicitudes.length, hojas: datos.hojas.length });
  } catch (error) {
    borrarTemporal();
    if (!(error instanceof ErrorMotor)) console.error("Error subiendo la planilla de préstamos:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "No se pudo guardar la planilla." });
  }
});

module.exports = router;
