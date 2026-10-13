const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { sql, getPool } = require("../config/db");
const { ejecutarMotor, ErrorMotor } = require("../config/motor");
const { requiereConciliacion, permisoConciliacion } = require("../middleware/auth");
const datos = require("./conciliacion-datos");

// Montado en /api/conciliacion (con prefijo propio, no en /api a secas: así
// el requiereConciliacion de abajo no puede cortar requests de otros routers).
const router = express.Router();

const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
  "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const formatoPesos = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Los PDF subidos se dejan primero en una carpeta temporal; recién cuando se
// leyeron bien se mueven con el nombre que espera el lector.
const CARPETA_SUBIDAS = path.join(datos.CARPETA_BANCOS, "_subidas");
const CARPETA_REEMPLAZADOS = path.join(datos.CARPETA_BANCOS, "_reemplazados");
fs.mkdirSync(CARPETA_SUBIDAS, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CARPETA_SUBIDAS),
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + ".pdf"),
  }),
  limits: { fileSize: 40 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname)),
});

// Antes de requiereConciliacion: el menú lo usa para saber si mostrar la
// tarjeta, también para quien no tiene permiso.
router.get("/acceso", async (req, res) => {
  try {
    res.json(await permisoConciliacion(req));
  } catch (error) {
    console.error("Error consultando acceso a conciliación:", error);
    res.json({ acceso: false, puedeCerrar: false, esAdmin: false });
  }
});

router.use(requiereConciliacion);

function leerPeriodo(body) {
  const banco = String(body.banco || "").toUpperCase();
  const anio = Number(body.anio);
  const mes = Number(body.mes);
  if (!/^[A-Z]{2,20}$/.test(banco) || !Number.isInteger(anio) || anio < 2020 || anio > 2100
      || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return null;
  }
  return { banco, anio, mes };
}

async function bancoActivo(banco) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("codigo", sql.NVarChar, banco)
    .query("SELECT nombre FROM conc_bancos WHERE codigo = @codigo AND activo = 1");
  return r.recordset[0]?.nombre || null;
}

// Mes que se muestra por defecto: el último con algún mayor cargado (sin
// contar los bloqueados); si no hay ninguno, el primer mes del sistema.
async function mesPorDefecto() {
  const hoy = new Date();
  for (const anio of [hoy.getFullYear(), hoy.getFullYear() - 1]) {
    const archivos = await datos.listarArchivos(anio);
    for (let mes = 12; mes >= 1; mes--) {
      if (datos.mesBloqueado(anio, mes)) continue;
      if (Object.values(archivos.bancos || {}).some((b) => b.meses?.[mes]?.mayor)) return { anio, mes };
    }
  }
  return { ...datos.PRIMER_PERIODO };
}

// Una tarjeta por banco: qué PDF hay, en qué estado está el mes y cuánto falta.
async function tarjetasDelMes(anio, mes) {
  const pool = await getPool();
  await datos.liberarInterrumpidos(pool, anio);
  const ant = mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 };
  const [archivos, archivosAnt, resumen, rBancos] = await Promise.all([
    datos.listarArchivos(anio),
    ant.anio === anio ? null : datos.listarArchivos(ant.anio),
    datos.resumenDelMes(anio, mes),
    pool.request().query("SELECT codigo, nombre, moneda FROM conc_bancos WHERE activo = 1 ORDER BY orden"),
  ]);
  return rBancos.recordset.map((b) => {
    const delMes = archivos.bancos?.[b.codigo]?.meses?.[mes] || {};
    const delAnt = (archivosAnt || archivos).bancos?.[b.codigo]?.meses?.[ant.mes] || {};
    const p = resumen.get(b.codigo);
    // ¿Algún PDF es más nuevo que la última lectura? Entonces hay que volver a
    // leer. Importa también el resumen del mes anterior: ahí están los
    // movimientos de los asientos de los primeros días y los gastos del asiento
    // global. (Margen de 5 s por diferencias entre relojes.)
    const leidoMs = p?.fecha_proceso ? Date.now() - p.segundos_desde_lectura * 1000 + 5000 : null;
    const abierto = p && p.estado !== "cerrado" && leidoMs !== null;
    const mesNuevo = abierto && (delMes.modificado || 0) * 1000 > leidoMs;
    const anteriorNuevo = abierto && (delAnt.modificado || 0) * 1000 > leidoMs;
    const nombreAnt = `${MESES[ant.mes - 1].toLowerCase()}`;
    let avisoLectura = null;
    if (anteriorNuevo) {
      avisoLectura = `El resumen de ${nombreAnt} se cargó después de leer este mes, así que todavía no se usó: ` +
        "los asientos de los primeros días y el asiento de gastos pueden estar ahí. Volvé a leer los papeles.";
    } else if (mesNuevo) {
      avisoLectura = "Hay papeles de este mes más nuevos que la última lectura. Volvé a leerlos.";
    } else if (abierto && !p.hay_anterior && !(delAnt.resumen || []).length) {
      avisoLectura = `No está cargado el resumen de ${nombreAnt}. Sin él, los asientos de los primeros días que el banco ` +
        `registró a fines de ${nombreAnt} y el asiento global de gastos quedan sin par. Cargalo (con ◀ en el inicio) y volvé a leer.`;
    }
    return {
      codigo: b.codigo,
      nombre: b.nombre,
      moneda: b.moneda,
      mayor: delMes.mayor || null,
      resumen: delMes.resumen || [],
      periodo: p ? {
        id: p.id,
        estado: p.estado,
        mensajeError: p.mensaje_error,
        fechaProceso: p.fecha_proceso,
        fechaCierre: p.fecha_cierre,
        cerradoPor: p.cerrado_por,
        mayorTotal: p.mayor_total,
        mayorConciliados: p.mayor_conciliados,
        bancoTotal: p.banco_total,
        bancoConciliados: p.banco_conciliados,
        aRevisar: p.a_revisar,
        gastosSinConciliar: p.gastos_sin_conciliar,
        propuestas: p.propuestas,
        pdfNuevos: !!(mesNuevo || anteriorNuevo),
        avisoLectura,
      } : null,
    };
  });
}

// Pantalla de inicio: los bancos en un mes (por defecto, el que toca).
router.get("/inicio", async (req, res) => {
  try {
    let anio = Number(req.query.anio);
    let mes = Number(req.query.mes);
    if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      ({ anio, mes } = await mesPorDefecto());
    }
    res.json({
      anio,
      mes,
      bloqueado: datos.mesBloqueado(anio, mes),
      primerPeriodo: datos.PRIMER_PERIODO,
      bancos: await tarjetasDelMes(anio, mes),
    });
  } catch (error) {
    console.error("Error armando el inicio de conciliación:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "Error de servidor" });
  }
});

// Un banco en un mes (cabecera de la pantalla de trabajo).
router.get("/mes", async (req, res) => {
  const p = leerPeriodo(req.query);
  if (!p) return res.status(400).json({ error: "Banco o mes inválido" });
  try {
    const tarjeta = (await tarjetasDelMes(p.anio, p.mes)).find((b) => b.codigo === p.banco);
    if (!tarjeta) return res.status(404).json({ error: "No existe ese banco" });
    res.json({ anio: p.anio, mes: p.mes, bloqueado: datos.mesBloqueado(p.anio, p.mes), ...tarjeta });
  } catch (error) {
    console.error("Error trayendo el mes:", error);
    res.status(500).json({ error: error instanceof ErrorMotor ? error.message : "Error de servidor" });
  }
});

// Vuelve a leer los PDF del mes que ya están en la carpeta.
router.post("/procesar", async (req, res) => {
  const p = leerPeriodo(req.body);
  if (!p || !(await bancoActivo(p.banco))) return res.status(400).json({ error: "Banco o mes inválido" });
  try {
    const problema = await datos.encolarLectura(p.banco, p.anio, p.mes, req.session.usuarioId);
    if (problema) return res.status(409).json({ error: problema });
    res.status(202).json({ ok: true });
  } catch (error) {
    console.error("Error encolando lectura:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Sube un PDF (mayor o resumen) para un banco y mes: lo lee en el momento y,
// si cierra, lo guarda en la carpeta con el nombre que espera el lector.
router.post("/archivo", (req, res, next) => {
  upload.single("archivo")(req, res, (error) => {
    if (error) {
      const mensaje = error.code === "LIMIT_FILE_SIZE" ? "El PDF es demasiado grande (máximo 40 MB)." : "No se pudo recibir el archivo.";
      return res.status(400).json({ error: mensaje });
    }
    next();
  });
}, async (req, res) => {
  const temporal = req.file?.path;
  const borrarTemporal = () => temporal && fs.promises.unlink(temporal).catch(() => {});

  const p = leerPeriodo(req.body);
  const tipo = req.body.tipo;
  const parte = req.body.parte === "1" || req.body.parte === "2" ? Number(req.body.parte) : null;
  if (!req.file) return res.status(400).json({ error: "Tiene que ser un archivo PDF." });
  const nombreBanco = p && (await bancoActivo(p.banco));
  if (!p || !nombreBanco || !["mayor", "resumen"].includes(tipo)) {
    borrarTemporal();
    return res.status(400).json({ error: "Banco, mes o tipo de archivo inválido." });
  }
  // En un mes bloqueado sólo se puede completar el resumen del banco: hace
  // falta como "mes anterior" del primer mes que se concilia (p. ej. la 2da
  // quincena de Santa Fe). Ese mes no se cruza.
  const bloqueado = datos.mesBloqueado(p.anio, p.mes);
  if (bloqueado && tipo === "mayor") {
    borrarTemporal();
    return res.status(409).json({ error: datos.textoBloqueado() + " En esos meses sólo se puede cargar el resumen del banco." });
  }
  const queEs = tipo === "mayor" ? "el mayor" : "el resumen del banco";
  const periodoLegible = `${MESES[p.mes - 1]} ${p.anio}`;

  try {
    const pool = await getPool();
    const existente = await datos.buscarPeriodo(pool, p.banco, p.anio, p.mes);
    if (existente?.estado === "cerrado") {
      borrarTemporal();
      return res.status(409).json({ error: `${nombreBanco} de ${periodoLegible} ya está cerrado.` });
    }

    let v;
    try {
      v = await ejecutarMotor("validar", {
        base: datos.CARPETA_BANCOS,
        banco: p.banco,
        periodo: datos.periodoTexto(p.mes, p.anio),
        tipo,
        archivo: temporal,
        parte,
      }, 2 * 60 * 1000);
    } catch (error) {
      if (!(error instanceof ErrorMotor)) throw error;
      v = { ok: false, error: error.message, delServidor: error.delServidor };
    }
    if (!v.ok) {
      borrarTemporal();
      // Falta Python o una librería en el servidor: el PDF no tiene la culpa.
      if (v.delServidor) return res.status(500).json({ error: v.error });
      return res.status(422).json({
        error: `No se pudo usar este PDF como ${queEs} de ${nombreBanco}. ${v.error} ` +
          "Revisá que sea el archivo correcto y que no esté cortado.",
      });
    }

    // El PDF tiene que ser del mes de la columna donde se soltó.
    const primerDia = `${p.anio}-${String(p.mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(Date.UTC(p.anio, p.mes, 0)).toISOString().slice(0, 10);
    const fueraDeMes = tipo === "mayor"
      ? v.desde && (v.desde < primerDia || v.hasta > ultimoDia)
      : v.desde && (v.hasta < primerDia || v.desde > ultimoDia);
    if (fueraDeMes) {
      borrarTemporal();
      return res.status(422).json({
        error: `Este PDF tiene movimientos del ${v.desde.split("-").reverse().join("/")} al ` +
          `${v.hasta.split("-").reverse().join("/")}: no es de ${periodoLegible}.`,
      });
    }

    // Archivos que este reemplaza. En Santa Fe, una quincena no pisa la otra.
    const destino = v.destino;
    const carpetaDestino = path.join(datos.CARPETA_BANCOS, destino.carpeta);
    let pisados = destino.existentes.filter((n) =>
      !parte || !/QUINCENA/i.test(n) || n.toUpperCase() === destino.nombre.toUpperCase());

    // Santa Fe: si se sube una quincena y ya hay un archivo con nombre de "mes
    // completo" que en realidad es la OTRA quincena (pasó con agosto 2026), se
    // lo renombra como esa quincena en vez de reemplazarlo.
    const renombrados = [];
    if (parte) {
      const mesIso = `${p.anio}-${String(p.mes).padStart(2, "0")}`;
      const dia = (iso) => Number(iso.slice(8, 10));
      for (const n of pisados.filter((x) => !/QUINCENA/i.test(x))) {
        const existente = await ejecutarMotor("validar", {
          base: datos.CARPETA_BANCOS, banco: p.banco, periodo: datos.periodoTexto(p.mes, p.anio),
          tipo: "resumen", archivo: path.join(carpetaDestino, n),
        }, 2 * 60 * 1000).catch(() => null);
        if (!existente?.ok || !existente.desde) continue;
        const esLaOtra = parte === 2
          ? existente.hasta.startsWith(mesIso) && dia(existente.hasta) <= 16
          : existente.desde.startsWith(mesIso) && dia(existente.desde) >= 14;
        if (!esLaOtra) continue;
        const nuevoNombre = `${parte === 2 ? "PRIMER" : "SEGUNDA"} QUINCENA ${MESES[p.mes - 1].toUpperCase()} ${p.anio}.pdf`;
        await fs.promises.rename(path.join(carpetaDestino, n), path.join(carpetaDestino, nuevoNombre));
        renombrados.push(`${n} tenía sólo la ${parte === 2 ? "1ª" : "2ª"} quincena: se renombró como ${nuevoNombre}.`);
        pisados = pisados.filter((x) => x !== n);
      }
      if (renombrados.length) datos.olvidarArchivos();
    }
    if (pisados.length && req.body.reemplazar !== "1") {
      borrarTemporal();
      return res.status(409).json({
        confirmar: true,
        mensaje: `Ya hay ${queEs} de ${nombreBanco} de ${periodoLegible} cargado (${pisados.join(", ")}). ¿Reemplazarlo por este?`,
      });
    }

    await fs.promises.mkdir(carpetaDestino, { recursive: true });
    if (pisados.length) {
      await fs.promises.mkdir(CARPETA_REEMPLAZADOS, { recursive: true });
      const sello = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      for (const n of pisados) {
        await fs.promises.rename(
          path.join(carpetaDestino, n),
          path.join(CARPETA_REEMPLAZADOS, `${sello} ${p.banco} ${n}`)
        );
      }
    }
    await fs.promises.rename(temporal, path.join(carpetaDestino, destino.nombre));
    datos.olvidarArchivos();

    // No se cruza nada solo: lo hacen las contadoras con "▶ Cruzar" o "↻"
    // cuando quieren. La grilla les avisa qué meses tienen PDF nuevos.
    const archivos = await datos.listarArchivos(p.anio);
    const delMes = archivos.bancos[p.banco].meses[p.mes];
    const avisos = [];
    if (!bloqueado && delMes.mayor && delMes.resumen.length) {
      avisos.push(existente ? "Tocá ↻ en la grilla para volver a cruzar el mes con este PDF."
        : "Ya están los dos PDF del mes: tocá ▶ Cruzar cuando quieras.");
    }
    if (tipo === "resumen") {
      const sig = p.mes === 12 ? { anio: p.anio + 1, mes: 1 } : { anio: p.anio, mes: p.mes + 1 };
      const periodoSig = await datos.buscarPeriodo(pool, p.banco, sig.anio, sig.mes);
      if (periodoSig && periodoSig.estado !== "cerrado") {
        avisos.push(`Este resumen también se usa en ${MESES[sig.mes - 1]} ${sig.anio}: ` +
          "volvé a cruzar ese mes para que lo tome.");
      }
    }
    const procesando = false;
    const aviso = avisos.join(" ") || null;

    const detalle = tipo === "mayor" && v.cuenta ? ` Cuenta: ${v.cuenta}.` : "";
    res.json({
      ok: true,
      procesando,
      aviso,
      mensaje: `Se leyó bien ${queEs}: ${v.movimientos} movimientos, saldo inicial ` +
        `${formatoPesos.format(v.saldo_inicial)} y final ${formatoPesos.format(v.saldo_final)}.${detalle}` +
        (renombrados.length ? " " + renombrados.join(" ") : ""),
    });
  } catch (error) {
    borrarTemporal();
    console.error("Error subiendo PDF de conciliación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Muestra en el navegador un PDF de la carpeta. El nombre sale del listado
// del motor (no de lo que manda el navegador), así no se puede pedir
// cualquier archivo del disco. "n" elige entre varios resúmenes del mes.
router.get("/pdf", async (req, res) => {
  const p = leerPeriodo(req.query);
  const tipo = req.query.tipo;
  if (!p || !["mayor", "resumen"].includes(tipo)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const archivos = await datos.listarArchivos(p.anio);
    const banco = archivos.bancos?.[p.banco];
    const delMes = banco?.meses?.[p.mes];
    const nombre = tipo === "mayor" ? delMes?.mayor : delMes?.resumen?.[Number(req.query.n) || 0];
    if (!nombre) return res.status(404).json({ error: "No está ese PDF en la carpeta" });
    const carpeta = tipo === "mayor" ? "MAYOR" : banco.carpeta;
    res.type("application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(nombre)}"`);
    res.sendFile(path.join(datos.CARPETA_BANCOS, carpeta, nombre));
  } catch (error) {
    console.error("Error mostrando PDF de conciliación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/periodos/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Período inválido" });
  try {
    const resultado = await datos.cargarPeriodo(id);
    if (!resultado) return res.status(404).json({ error: "No existe ese período" });
    res.json({ ...resultado, permiso: req.permisoConciliacion });
  } catch (error) {
    console.error("Error trayendo período de conciliación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Conciliar a mano los movimientos tildados en el punteo.
router.post("/periodos/:id/cruces", async (req, res) => {
  const id = Number(req.params.id);
  const { movimientos, nota } = req.body;
  if (!Number.isInteger(id) || !Array.isArray(movimientos)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const cruceId = await datos.crearCruceManual(id, movimientos, req.session.usuarioId, nota);
    res.json({ ok: true, cruceId });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error conciliando a mano:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// aceptar / rechazar un cruce "para confirmar", o deshacer uno conciliado.
router.post("/cruces/:id/:accion", async (req, res) => {
  const id = Number(req.params.id);
  const { accion } = req.params;
  if (!Number.isInteger(id) || !["aceptar", "rechazar", "deshacer"].includes(accion)) {
    return res.status(400).json({ error: "Pedido inválido" });
  }
  try {
    await datos.resolverCruce(id, accion, req.session.usuarioId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error resolviendo cruce:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Cerrar el mes (pasa los pendientes al mes siguiente) y reabrirlo (sólo admin).
router.post("/periodos/:id/:accion", async (req, res, next) => {
  if (!["cerrar", "reabrir"].includes(req.params.accion)) return next(); // p. ej. /cruces, más abajo
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const accion = req.params.accion === "cerrar" ? datos.cerrarPeriodo : datos.reabrirPeriodo;
    await accion(id, req.session.usuarioId, req.permisoConciliacion);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error(`Error al ${req.params.accion} el mes:`, error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/periodos/:id/observaciones", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    res.json(await datos.observacionesDelPeriodo(id));
  } catch (error) {
    console.error("Error trayendo observaciones del período:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Detalle de un movimiento: observaciones, revisado y candidatos sugeridos.
router.get("/movimientos/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const detalle = await datos.detalleMovimiento(id);
    if (!detalle) return res.status(404).json({ error: "No existe ese movimiento" });
    res.json(detalle);
  } catch (error) {
    console.error("Error trayendo detalle de movimiento:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.post("/movimientos/:id/observaciones", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    await datos.agregarObservacion(id, req.body.texto, req.session.usuarioId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error guardando observación:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.put("/movimientos/:id/revisado", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || typeof req.body.revisado !== "boolean") {
    return res.status(400).json({ error: "Pedido inválido" });
  }
  try {
    await datos.marcarRevisado(id, req.body.revisado, req.session.usuarioId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error marcando revisado:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// "Se registra el mes siguiente" (ej. movimiento del banco del 30/09 que se asienta el 01/10).
router.post("/movimientos/:id/mes-siguiente", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    await datos.marcarMesSiguiente(id, req.session.usuarioId);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error marcando mes siguiente:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Conciliar de una vez las propuestas exactas que se ven en pantalla (lo
// aprieta la contadora; el servidor vuelve a controlar que sean exactas).
router.post("/periodos/:id/aceptar-exactas", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !Array.isArray(req.body.cruces)) return res.status(400).json({ error: "Pedido inválido" });
  try {
    const cantidad = await datos.aceptarExactas(id, req.body.cruces, req.session.usuarioId);
    res.json({ ok: true, cantidad });
  } catch (error) {
    if (error instanceof datos.ErrorConciliacion) return res.status(409).json({ error: error.message });
    console.error("Error aceptando propuestas exactas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
