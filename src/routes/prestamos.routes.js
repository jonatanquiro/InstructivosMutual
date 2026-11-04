const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { sql, getPool } = require("../config/db");
const { ejecutarScript, ErrorMotor, RAIZ } = require("../config/motor");
const { volcarExcel, leerSolicitudes, faltanTablas } = require("./prestamos-datos");

const router = express.Router();

// Los datos viven en la base UNION (tablas PRPL*, ver prestamos-datos.js).
// La planilla de Excel que llevan a mano se sube desde la pestaña y se vuelca
// ahí; el archivo se guarda igual (el último y el anterior) como respaldo.
// PRESTAMOS_CARPETA puede ser absoluta (otro disco) o relativa a src/.
const CONFIGURADA = process.env.PRESTAMOS_CARPETA || "uploads/prestamos";
const CARPETA = path.isAbsolute(CONFIGURADA) ? CONFIGURADA : path.join(__dirname, "..", CONFIGURADA);
const PLANILLA = path.join(CARPETA, "planilla.xlsx");
const ANTERIOR = path.join(CARPETA, "planilla-anterior.xlsx");
const DATOS_SUBIDA = path.join(CARPETA, "planilla.json");
const SCRIPT = path.join(RAIZ, "motor", "prestamos.py");
fs.mkdirSync(CARPETA, { recursive: true });

const FALTAN_TABLAS = "Faltan las tablas de préstamos en la base UNION: hay que correr sql/union_prestamos_planilla.sql.";

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARPETA),
    filename: (req, file, cb) => cb(null, `subida-${crypto.randomUUID()}.xlsx`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.xlsx$/i.test(file.originalname)),
});

function datosSubida() {
  try {
    return JSON.parse(fs.readFileSync(DATOS_SUBIDA, "utf8"));
  } catch (error) {
    return {};
  }
}

// Se lee de la base en cada pedido (no hay caché): así aparece al instante
// lo que se cargue desde Fox.
router.get("/prestamos", async (req, res) => {
  try {
    const solicitudes = await leerSolicitudes(await getPool());
    if (!solicitudes.length) return res.json({ sinPlanilla: true });
    res.json({ ...datosSubida(), solicitudes });
  } catch (error) {
    if (faltanTablas(error)) return res.status(500).json({ error: FALTAN_TABLAS });
    console.error("Error leyendo préstamos de UNION:", error);
    res.status(500).json({ error: "No se pudieron leer los préstamos de la base." });
  }
});

// Se lee antes de tocar nada: si la planilla nueva no se puede leer, quedan los datos que estaban.
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
    const datos = await ejecutarScript(SCRIPT, [], { archivo: temporal }, 60 * 1000);
    if (!datos.ok) {
      borrarTemporal();
      return res.status(422).json({ error: datos.error });
    }
    if (!datos.solicitudes.length) {
      borrarTemporal();
      return res.status(422).json({ error: "La planilla no tiene ninguna hoja con la columna SOCIO: ¿es la de control de préstamos?" });
    }

    const pool = await getPool();
    // USUAPLIC en UNION guarda el usuario (no el nombre completo), como el resto del sistema.
    const { recordset } = await pool.request().input("id", sql.Int, req.session.usuarioId)
      .query("SELECT nombre_usuario FROM app_usuarios WHERE id = @id");
    const usuario = (recordset[0]?.nombre_usuario || req.session.nombreCompleto || "").toUpperCase();
    const resultado = await volcarExcel(pool, datos.solicitudes, usuario);

    if (fs.existsSync(PLANILLA)) fs.copyFileSync(PLANILLA, ANTERIOR);
    fs.renameSync(temporal, PLANILLA);
    // multer entrega el nombre original en latin1 (el navegador lo manda en UTF-8).
    const comoUtf8 = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const nombre = comoUtf8.includes("�") ? req.file.originalname : comoUtf8;
    fs.writeFileSync(DATOS_SUBIDA, JSON.stringify({
      archivo: nombre,
      subidaPor: req.session.nombreCompleto || "",
      subidaEl: new Date().toISOString(),
      hojas: datos.hojas.length,
    }));
    res.json({ ok: true, ...resultado });
  } catch (error) {
    borrarTemporal();
    if (faltanTablas(error)) return res.status(500).json({ error: FALTAN_TABLAS });
    if (!(error instanceof ErrorMotor)) console.error("Error subiendo la planilla de préstamos:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "No se pudo guardar la planilla en la base." });
  }
});

module.exports = router;
