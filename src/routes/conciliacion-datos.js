// Acceso a datos de la conciliación bancaria: correr el motor, guardar su
// resultado en conc_* y calcular el cuadre de saldos desde la base.
// Vive aparte de conciliacion.routes.js (mismo criterio que chat-datos.js)
// para que las rutas queden cortas y esto se pueda reusar desde scripts.
const fs = require("fs/promises");
const crypto = require("crypto");
const path = require("path");
const { sql, getPool } = require("../config/db");
const { ejecutarMotor, ErrorMotor, CARPETA_BANCOS } = require("../config/motor");

const REGLAS_MES_ANTERIOR = ["Mes anterior", "Gastos mes anterior"];
const NOTA_DUDOSA = /Diferencia|difiere|Fechas distantes/i;

const periodoTexto = (mes, anio) => `${String(mes).padStart(2, "0")}/${anio}`;

// Primer mes que se concilia con el sistema (MM/AAAA). Los anteriores quedan
// bloqueados: no se suben ni se cruzan, aunque sus resúmenes se siguen
// leyendo como "mes anterior" del primer mes.
const PRIMER_PERIODO = (() => {
  const m = /^(\d{1,2})\/(\d{4})$/.exec(process.env.CONC_PRIMER_PERIODO || "09/2026");
  return m ? { mes: Number(m[1]), anio: Number(m[2]) } : { mes: 9, anio: 2026 };
})();
const mesBloqueado = (anio, mes) => anio * 12 + mes < PRIMER_PERIODO.anio * 12 + PRIMER_PERIODO.mes;
const textoBloqueado = () =>
  `Los meses anteriores a ${periodoTexto(PRIMER_PERIODO.mes, PRIMER_PERIODO.anio)} están bloqueados.`;
const fechaIso = (f) => (f instanceof Date ? f.toISOString().slice(0, 10) : f);
// Sumas en centavos enteros para no arrastrar errores de coma flotante.
const centavos = (x) => Math.round(Number(x) * 100);
const pesos = (c) => c / 100;

// Estados de un cruce (conc_cruces.estado):
//   'a_confirmar'   PROPUESTA del sistema: no cuenta como conciliado hasta que
//                   la contadora la acepta (nada se concilia solo).
//   'conciliado'    aceptado o hecho a mano.
//   'rechazado'     propuesta descartada ("No es").
//   'mes_siguiente' un solo movimiento, marcado "Se registra el mes siguiente":
//                   no está conciliado (sigue pendiente en el cuadre y pasa al mes
//                   siguiente al cerrar) pero ya no figura entre lo que hay que revisar.
function estadoInicialCruce() {
  return "a_confirmar";
}

// Condiciones SQL sobre un movimiento "m".
//   CONCILIADO: está en un cruce aceptado.
//   SIN_CONCILIAR: no está en ninguno aceptado (es pendiente para el cuadre).
//   A_REVISAR: ni aceptado ni marcado "mes siguiente" (lo que tienen que mirar).
const EXISTE_CRUCE = (estados) => `EXISTS (SELECT 1 FROM conc_cruce_items ci JOIN conc_cruces c ON c.id = ci.cruce_id
  WHERE ci.movimiento_id = m.id AND c.deshecho = 0 AND c.estado IN (${estados}))`;
const SIN_CONCILIAR = `NOT ${EXISTE_CRUCE("'conciliado'")}`;
const A_REVISAR = `NOT ${EXISTE_CRUCE("'conciliado', 'mes_siguiente'")}`;
const SIN_CRUCE_VIGENTE = `NOT ${EXISTE_CRUCE("'conciliado', 'mes_siguiente', 'a_confirmar'")}`;

// Días hábiles (lunes a viernes) entre dos fechas, para ordenar propuestas: un
// asiento del viernes contra el banco del lunes está a 1 día hábil.
function diasHabiles(a, b) {
  let desde = new Date(a);
  let hasta = new Date(b);
  if (desde > hasta) [desde, hasta] = [hasta, desde];
  let n = 0;
  for (const d = new Date(desde); d < hasta; d.setUTCDate(d.getUTCDate() + 1)) {
    const siguiente = new Date(d);
    siguiente.setUTCDate(siguiente.getUTCDate() + 1);
    if (siguiente.getUTCDay() !== 0 && siguiente.getUTCDay() !== 6) n++;
  }
  return n;
}
const DIAS_HABILES_EXACTA = 2; // propuesta "exacta": mismo importe y hasta 2 días hábiles

// --------------------------------------------------------------- Archivos

// Listado de PDF por banco y mes. Leerlo implica lanzar Python, así que se
// guarda unos segundos para no repetirlo en cada refresco de la grilla.
const cacheArchivos = new Map();
async function listarArchivos(anio) {
  const enCache = cacheArchivos.get(anio);
  if (enCache && Date.now() - enCache.hora < 15000) return enCache.datos;
  const datos = await ejecutarMotor("archivos", { base: CARPETA_BANCOS, anio }, 60000);
  cacheArchivos.set(anio, { hora: Date.now(), datos });
  return datos;
}
function olvidarArchivos() {
  cacheArchivos.clear();
}

async function huellaArchivo(rutaAbsoluta) {
  const contenido = await fs.readFile(rutaAbsoluta);
  return {
    ruta: path.relative(CARPETA_BANCOS, rutaAbsoluta),
    tamanio: contenido.length,
    hash: crypto.createHash("sha256").update(contenido).digest("hex"),
  };
}

// --------------------------------------------------------------- Períodos

async function buscarPeriodo(pool, banco, anio, mes) {
  const r = await pool
    .request()
    .input("banco", sql.NVarChar, banco)
    .input("anio", sql.SmallInt, anio)
    .input("mes", sql.TinyInt, mes)
    .query("SELECT id, estado FROM conc_periodos WHERE banco = @banco AND anio = @anio AND mes = @mes");
  return r.recordset[0] || null;
}

// ------------------------------------------------------- Cola de lecturas

// Una lectura a la vez: cada una puede tardar casi un minuto y usa bastante
// CPU. La clave "BANCO-AAAA-MM" evita encolar dos veces el mismo período.
const enCurso = new Set();
let cola = Promise.resolve();

function estaProcesando(banco, anio, mes) {
  return enCurso.has(`${banco}-${anio}-${mes}`);
}

// Marca el período como "procesando" y encola la lectura. Devuelve un texto
// de error si no se puede (mes bloqueado o cerrado), o null.
async function encolarLectura(banco, anio, mes, usuarioId) {
  const clave = `${banco}-${anio}-${mes}`;
  if (mesBloqueado(anio, mes)) return textoBloqueado();
  if (enCurso.has(clave)) return null;

  const pool = await getPool();
  const existente = await buscarPeriodo(pool, banco, anio, mes);
  if (existente?.estado === "cerrado") {
    return "Ese mes ya está cerrado; no se puede volver a leer.";
  }

  await pool
    .request()
    .input("banco", sql.NVarChar, banco)
    .input("anio", sql.SmallInt, anio)
    .input("mes", sql.TinyInt, mes)
    .query(`
      MERGE conc_periodos AS destino
      USING (SELECT @banco AS banco, @anio AS anio, @mes AS mes) AS origen
        ON destino.banco = origen.banco AND destino.anio = origen.anio AND destino.mes = origen.mes
      WHEN MATCHED THEN UPDATE SET estado = 'procesando', mensaje_error = NULL
      WHEN NOT MATCHED THEN INSERT (banco, anio, mes, estado) VALUES (@banco, @anio, @mes, 'procesando');
    `);

  enCurso.add(clave);
  cola = cola
    .then(() => leerYGuardar(banco, anio, mes, usuarioId))
    .catch((error) => console.error(`Error leyendo ${clave}:`, error))
    .finally(() => enCurso.delete(clave));
  return null;
}

async function leerYGuardar(banco, anio, mes, usuarioId) {
  let resultado;
  try {
    resultado = await ejecutarMotor("conciliar", {
      base: CARPETA_BANCOS,
      banco,
      periodo: periodoTexto(mes, anio),
    });
  } catch (error) {
    if (!(error instanceof ErrorMotor)) throw error;
    resultado = { ok: false, error: error.message };
  }

  const pool = await getPool();
  const periodo = await buscarPeriodo(pool, banco, anio, mes);
  if (!resultado.ok) {
    await marcarError(pool, periodo.id, resultado.error, usuarioId);
    return;
  }
  try {
    await guardarResultado(pool, periodo.id, resultado, usuarioId);
    // Si el mes anterior está cerrado, se suman sus pendientes.
    await prepararArrastre(periodo.id, usuarioId);
  } catch (error) {
    console.error(`Error guardando la conciliación de ${banco} ${periodoTexto(mes, anio)}:`, error);
    await marcarError(pool, periodo.id, error.mensajeUsuario || "No se pudo guardar el resultado en la base.", usuarioId);
  }
}

async function marcarError(pool, periodoId, mensaje, usuarioId) {
  await pool
    .request()
    .input("id", sql.Int, periodoId)
    .input("mensaje", sql.NVarChar, String(mensaje).slice(0, 1000))
    .input("usuarioId", sql.Int, usuarioId)
    .query(`
      UPDATE conc_periodos
      SET estado = 'con_error', mensaje_error = @mensaje, procesado_por = @usuarioId, fecha_proceso = GETDATE()
      WHERE id = @id
    `);
}

// Si el servidor se reinició en medio de una lectura, el período quedó en
// "procesando" para siempre. Se detecta al pedir la grilla.
async function liberarInterrumpidos(pool, anio) {
  const r = await pool
    .request()
    .input("anio", sql.SmallInt, anio)
    .query("SELECT id, banco, mes FROM conc_periodos WHERE anio = @anio AND estado = 'procesando'");
  for (const p of r.recordset) {
    if (!estaProcesando(p.banco, anio, p.mes)) {
      await marcarError(pool, p.id, "La lectura se interrumpió (se reinició el servidor). Volvé a leerla.", null);
    }
  }
}

// Guarda el resultado del motor conservando el trabajo hecho a mano.
//
// Los movimientos se identifican por su clave (lado|fecha|importe|concepto|n),
// así una relectura de los mismos PDF mantiene los mismos ids, y con ellos
// las observaciones y marcas de revisado. Un movimiento que ya no está en el
// PDF nuevo (por ejemplo, un asiento corregido en el sistema) no se borra:
// pasa a lado 'X' y deja de mostrarse.
//
// Cruces:
// - Los tocados por una persona (manuales, aceptados, rechazados) se
//   conservan si todos sus movimientos siguen estando; si no, se deshacen con
//   una nota (se avisa en el punteo).
// - Los automáticos que nadie tocó se reemplazan por los de la lectura nueva.
// - Un cruce automático que alguien deshizo o rechazó no vuelve a aparecer.
// - Los cruces nuevos que usen movimientos ya cruzados a mano se descartan.
const NOTA_RELECTURA = "Deshecho al volver a leer los PDF: algún movimiento ya no está.";
// Un pendiente arrastrado del banco (lado 'Q') es el mismo movimiento que su
// "gemelo" del resumen anterior que lee el motor (lado 'A'): misma clave salvo
// la primera letra. Para comparar cruces se los trata como iguales.
const normalizar = (clave) => (clave.startsWith("Q|") ? "A" + clave.slice(1) : clave);
const firma = (claves) => claves.map(normalizar).sort().join("\n");

async function guardarResultado(pool, periodoId, r, usuarioId) {
  const archivos = [];
  archivos.push({ tipo: "mayor", ...(await huellaArchivo(r.archivos.mayor)) });
  for (const f of r.archivos.resumen) archivos.push({ tipo: "resumen", ...(await huellaArchivo(f)) });
  for (const f of r.archivos.resumen_anterior) {
    archivos.push({ tipo: "resumen_anterior", ...(await huellaArchivo(f)) });
  }
  const clave = (k) => k.slice(0, 250);
  const movPorClave = new Map(r.movimientos.map((m) => [clave(m.k), m]));

  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    const req = () => new sql.Request(transaccion).input("periodoId", sql.Int, periodoId);

    // --- Movimientos: se cargan en una tabla temporal y se "fusionan" por clave.
    const tablaMov = new sql.Table("#conc_nuevos");
    tablaMov.create = true;
    tablaMov.columns.add("lado", sql.Char(1), { nullable: false });
    tablaMov.columns.add("clave", sql.NVarChar(250), { nullable: false });
    tablaMov.columns.add("orden", sql.Int, { nullable: false });
    tablaMov.columns.add("fecha", sql.Date, { nullable: false });
    tablaMov.columns.add("concepto", sql.NVarChar(300), { nullable: false });
    tablaMov.columns.add("detalle", sql.NVarChar(1000), { nullable: true });
    tablaMov.columns.add("comprob", sql.NVarChar(50), { nullable: true });
    tablaMov.columns.add("nro", sql.NVarChar(30), { nullable: true });
    tablaMov.columns.add("suc", sql.NVarChar(10), { nullable: true });
    tablaMov.columns.add("importe", sql.Decimal(18, 2), { nullable: false });
    tablaMov.columns.add("saldo", sql.Decimal(18, 2), { nullable: true });
    tablaMov.columns.add("por_acreditar", sql.Decimal(18, 2), { nullable: false });
    tablaMov.columns.add("cuit", sql.Char(11), { nullable: true });
    tablaMov.columns.add("rubro_gasto", sql.NVarChar(60), { nullable: true });
    for (const m of r.movimientos) {
      tablaMov.rows.add(
        m.lado, clave(m.k), m.orden, new Date(m.fecha),
        m.concepto.slice(0, 300), m.detalle ? m.detalle.slice(0, 1000) : null,
        m.comprob ? m.comprob.slice(0, 50) : null, m.nro ? m.nro.slice(0, 30) : null,
        m.suc ? m.suc.slice(0, 10) : null, m.importe, m.saldo, m.por_acreditar || 0,
        m.cuit, m.rubro_gasto
      );
    }
    await req().bulk(tablaMov);
    await req().query(`
      -- Los pendientes arrastrados del mes anterior (Q/R) no vienen del motor: no se tocan.
      WITH destino AS (SELECT * FROM conc_movimientos WHERE periodo_id = @periodoId AND lado NOT IN ('Q', 'R'))
      MERGE destino
      USING #conc_nuevos AS n ON destino.clave = n.clave
      WHEN MATCHED THEN UPDATE SET
        lado = n.lado, orden = n.orden, fecha = n.fecha, concepto = n.concepto, detalle = n.detalle,
        comprob = n.comprob, nro = n.nro, suc = n.suc, importe = n.importe, saldo = n.saldo,
        por_acreditar = n.por_acreditar, cuit = n.cuit, rubro_gasto = n.rubro_gasto
      WHEN NOT MATCHED BY TARGET THEN
        INSERT (periodo_id, lado, clave, orden, fecha, concepto, detalle, comprob, nro, suc,
                importe, saldo, por_acreditar, cuit, rubro_gasto)
        VALUES (@periodoId, n.lado, n.clave, n.orden, n.fecha, n.concepto, n.detalle, n.comprob, n.nro, n.suc,
                n.importe, n.saldo, n.por_acreditar, n.cuit, n.rubro_gasto)
      WHEN NOT MATCHED BY SOURCE THEN UPDATE SET lado = 'X';
      DROP TABLE #conc_nuevos;
    `);

    const filasMov = await req().query("SELECT id, clave, lado FROM conc_movimientos WHERE periodo_id = @periodoId");
    const idsMov = new Map(filasMov.recordset.map((f) => [f.clave, f.id]));
    const claveDeId = new Map(filasMov.recordset.map((f) => [f.id, f.clave]));
    const inactivos = new Set(filasMov.recordset.filter((f) => f.lado === "X").map((f) => f.id));

    // --- Cruces existentes
    const rViejos = await req().query(`
      SELECT c.id, c.origen, c.estado, c.deshecho, c.resuelto_por, ci.movimiento_id
      FROM conc_cruces c JOIN conc_cruce_items ci ON ci.cruce_id = c.id
      WHERE c.periodo_id = @periodoId
    `);
    const viejos = new Map();
    for (const f of rViejos.recordset) {
      if (!viejos.has(f.id)) viejos.set(f.id, { ...f, items: [] });
      viejos.get(f.id).items.push(f.movimiento_id);
    }

    const aBorrar = [];       // automáticos que nadie tocó: los reemplaza la lectura nueva
    const aDeshacer = [];     // tocados a mano cuyos movimientos ya no están
    const firmasSuprimidas = new Set();
    const usados = new Set(); // claves (normalizadas) de movimientos en cruces que se conservan
    for (const c of viejos.values()) {
      const tocado = c.origen === "manual" || c.resuelto_por !== null;
      if (c.deshecho) {
        if (c.origen === "auto") firmasSuprimidas.add(firma(c.items.map((id) => claveDeId.get(id))));
        continue;
      }
      if (!tocado) {
        aBorrar.push(c.id);
      } else if (c.items.some((id) => inactivos.has(id))) {
        aDeshacer.push(c.id);
      } else if (c.estado === "rechazado") {
        firmasSuprimidas.add(firma(c.items.map((id) => claveDeId.get(id))));
      } else {
        c.items.forEach((id) => usados.add(normalizar(claveDeId.get(id))));
      }
    }
    if (aBorrar.length) {
      await req().query(`
        DELETE FROM conc_cruce_items WHERE cruce_id IN (${aBorrar.join(",")});
        DELETE FROM conc_cruces WHERE id IN (${aBorrar.join(",")});
      `);
    }
    if (aDeshacer.length) {
      await req()
        .input("usuarioId", sql.Int, usuarioId)
        .input("nota", sql.NVarChar, NOTA_RELECTURA)
        .query(`
          UPDATE conc_cruces
          SET deshecho = 1, deshecho_por = @usuarioId, fecha_deshecho = GETDATE(),
              nota = LEFT(@nota + ISNULL(' ' + nota, ''), 400)
          WHERE id IN (${aDeshacer.join(",")})
        `);
    }

    // --- Cruces nuevos del motor (numerados a continuación de los que quedan)
    const rNumero = await req().query("SELECT ISNULL(MAX(numero), 0) AS ultimo FROM conc_cruces WHERE periodo_id = @periodoId");
    let numero = rNumero.recordset[0].ultimo;
    const primerNumero = numero + 1;
    const nuevos = [];
    for (const g of r.grupos) {
      const claves = [...g.mayor, ...g.banco].map(clave);
      const ids = claves.map((k) => idsMov.get(k));
      if (firmasSuprimidas.has(firma(claves)) || claves.some((k) => usados.has(normalizar(k)))) continue;
      const suma = (lista) => lista.reduce((s, k) => s + centavos(movPorClave.get(clave(k)).importe), 0);
      const diferencia = g.mayor.length && g.banco.length ? pesos(suma(g.mayor) - suma(g.banco)) : 0;
      nuevos.push({ numero: ++numero, g, ids, diferencia });
    }

    if (nuevos.length) {
      const tablaCruces = new sql.Table("conc_cruces");
      tablaCruces.create = false;
      tablaCruces.columns.add("periodo_id", sql.Int, { nullable: false });
      tablaCruces.columns.add("numero", sql.Int, { nullable: false });
      tablaCruces.columns.add("origen", sql.NVarChar(10), { nullable: false });
      tablaCruces.columns.add("regla", sql.NVarChar(40), { nullable: false });
      tablaCruces.columns.add("nota", sql.NVarChar(400), { nullable: true });
      tablaCruces.columns.add("estado", sql.NVarChar(15), { nullable: false });
      tablaCruces.columns.add("diferencia", sql.Decimal(18, 2), { nullable: false });
      for (const n of nuevos) {
        tablaCruces.rows.add(periodoId, n.numero, "auto", n.g.tipo, n.g.nota || null, estadoInicialCruce(n.g), n.diferencia);
      }
      await req().bulk(tablaCruces);

      const filasCruces = await req()
        .input("desde", sql.Int, primerNumero)
        .query("SELECT id, numero FROM conc_cruces WHERE periodo_id = @periodoId AND numero >= @desde");
      const idsCruces = new Map(filasCruces.recordset.map((f) => [f.numero, f.id]));

      const tablaItems = new sql.Table("conc_cruce_items");
      tablaItems.create = false;
      tablaItems.columns.add("cruce_id", sql.Int, { nullable: false });
      tablaItems.columns.add("movimiento_id", sql.Int, { nullable: false });
      for (const n of nuevos) {
        for (const id of n.ids) tablaItems.rows.add(idsCruces.get(n.numero), id);
      }
      await req().bulk(tablaItems);
    }

    // --- Archivos usados y datos del período
    await req().query("DELETE FROM conc_archivos WHERE periodo_id = @periodoId");
    for (const a of archivos) {
      await req()
        .input("tipo", sql.NVarChar, a.tipo)
        .input("ruta", sql.NVarChar, a.ruta)
        .input("tamanio", sql.BigInt, a.tamanio)
        .input("hash", sql.Char(64), a.hash)
        .query(`
          INSERT INTO conc_archivos (periodo_id, tipo, ruta, tamanio, hash_sha256)
          VALUES (@periodoId, @tipo, @ruta, @tamanio, @hash)
        `);
    }

    await req()
      .input("cuenta", sql.NVarChar, (r.cuenta || "").slice(0, 200))
      .input("iniMayor", sql.Decimal(18, 2), r.saldos.ini_mayor)
      .input("finMayor", sql.Decimal(18, 2), r.saldos.fin_mayor)
      .input("iniBanco", sql.Decimal(18, 2), r.saldos.ini_banco)
      .input("finBanco", sql.Decimal(18, 2), r.saldos.fin_banco)
      .input("hayAnterior", sql.Bit, r.hay_anterior)
      // El aviso de "falta parte del resumen anterior" viaja junto al cuadre del motor.
      .input("cuadreMotor", sql.NVarChar(sql.MAX), JSON.stringify({ ...r.cuadre, aviso_anterior: r.aviso_anterior || null, lectura: r.lectura || null }))
      .input("valores", sql.NVarChar(sql.MAX), JSON.stringify(r.valores_a_acreditar))
      .input("usuarioId", sql.Int, usuarioId)
      .query(`
        UPDATE conc_periodos SET
          estado = 'abierto', mensaje_error = NULL, cuenta = @cuenta,
          saldo_ini_mayor = @iniMayor, saldo_fin_mayor = @finMayor,
          saldo_ini_banco = @iniBanco, saldo_fin_banco = @finBanco,
          hay_anterior = @hayAnterior, cuadre_motor = @cuadreMotor, valores_acreditar = @valores,
          procesado_por = @usuarioId, fecha_proceso = GETDATE()
        WHERE id = @periodoId
      `);

    await transaccion.commit();
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

// ------------------------------------------- Cierre de mes y arrastre

// Al cerrar un mes, lo que quedó pendiente pasa al mes siguiente:
//   lado 'R' = asiento del mayor que el banco todavía no registró (va del lado del mayor)
//   lado 'Q' = movimiento del banco todavía sin asiento (va del lado del banco)
// Su clave es la del original con otra primera letra; para 'Q' coincide con
// la del "gemelo" del resumen anterior que lee el motor (lado 'A').
const AVISO_YA_CONCILIADO = "El movimiento del banco ya estaba conciliado en el mes anterior.";
const NOTA_REAPERTURA = "Deshecho porque se reabrió el mes anterior.";
const DIAS_ARRASTRE = 5; // un arrastrado se cruza con movimientos desde 5 días antes de su fecha

const mesAnterior = (anio, mes) => (mes === 1 ? { anio: anio - 1, mes: 12 } : { anio, mes: mes - 1 });
const mesSiguiente = (anio, mes) => (mes === 12 ? { anio: anio + 1, mes: 1 } : { anio, mes: mes + 1 });

async function datosPeriodo(requestFactory, periodoId) {
  const r = await requestFactory().input("id", sql.Int, periodoId)
    .query("SELECT id, banco, anio, mes, estado FROM conc_periodos WHERE id = @id");
  return r.recordset[0] || null;
}

async function periodoVecino(requestFactory, p, delta) {
  const v = delta < 0 ? mesAnterior(p.anio, p.mes) : mesSiguiente(p.anio, p.mes);
  const r = await requestFactory()
    .input("banco", sql.NVarChar, p.banco).input("anio", sql.SmallInt, v.anio).input("mes", sql.TinyInt, v.mes)
    .query("SELECT id, banco, anio, mes, estado FROM conc_periodos WHERE banco = @banco AND anio = @anio AND mes = @mes");
  return r.recordset[0] || null;
}

// Trae los pendientes del mes anterior (si está cerrado) al período, une los
// cruces del motor con esos pendientes y cruza los que coinciden exacto.
// Se puede llamar varias veces: lo ya hecho no se repite.
async function prepararArrastre(periodoId, usuarioId) {
  const pool = await getPool();
  const p = await datosPeriodo(() => pool.request(), periodoId);
  if (!p || p.estado !== "abierto") return;
  const anterior = await periodoVecino(() => pool.request(), p, -1);
  if (!anterior || anterior.estado !== "cerrado") return;

  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    const req = () => new sql.Request(transaccion).input("p", sql.Int, periodoId);

    // 1) Copiar los pendientes del mes anterior (una sola vez).
    const rHay = await req().query("SELECT COUNT(*) AS n FROM conc_movimientos WHERE periodo_id = @p AND lado IN ('Q', 'R')");
    if (rHay.recordset[0].n === 0) {
      const rPend = await req().input("ant", sql.Int, anterior.id).query(`
        SELECT m.* FROM conc_movimientos m
        WHERE m.periodo_id = @ant AND m.lado IN ('M', 'B', 'Q', 'R') AND m.importe <> 0 AND ${SIN_CONCILIAR}
      `);
      if (rPend.recordset.length) {
        const tabla = new sql.Table("#conc_arrastre");
        tabla.create = true;
        tabla.columns.add("lado", sql.Char(1), { nullable: false });
        tabla.columns.add("clave", sql.NVarChar(250), { nullable: false });
        tabla.columns.add("orden", sql.Int, { nullable: false });
        tabla.columns.add("fecha", sql.Date, { nullable: false });
        tabla.columns.add("concepto", sql.NVarChar(300), { nullable: false });
        tabla.columns.add("detalle", sql.NVarChar(1000), { nullable: true });
        tabla.columns.add("comprob", sql.NVarChar(50), { nullable: true });
        tabla.columns.add("nro", sql.NVarChar(30), { nullable: true });
        tabla.columns.add("suc", sql.NVarChar(10), { nullable: true });
        tabla.columns.add("importe", sql.Decimal(18, 2), { nullable: false });
        tabla.columns.add("cuit", sql.Char(11), { nullable: true });
        tabla.columns.add("rubro_gasto", sql.NVarChar(60), { nullable: true });
        const vistas = new Set();
        for (const m of rPend.recordset) {
          const lado = m.lado === "M" || m.lado === "R" ? "R" : "Q";
          let clave = m.lado === "M" || m.lado === "B" ? lado + m.clave.slice(1) : m.clave;
          while (vistas.has(clave)) clave = (clave + "|+").slice(0, 250);
          vistas.add(clave);
          tabla.rows.add(lado, clave, m.orden, m.fecha, m.concepto, m.detalle, m.comprob, m.nro, m.suc,
            m.importe, m.cuit, m.rubro_gasto);
        }
        await req().bulk(tabla);
        // Si quedó una fila vieja con la misma clave (de una reapertura), se reactiva.
        await req().query(`
          WITH destino AS (SELECT * FROM conc_movimientos WHERE periodo_id = @p)
          MERGE destino
          USING #conc_arrastre AS n ON destino.clave = n.clave
          WHEN MATCHED THEN UPDATE SET lado = n.lado, fecha = n.fecha, importe = n.importe
          WHEN NOT MATCHED BY TARGET THEN
            INSERT (periodo_id, lado, clave, orden, fecha, concepto, detalle, comprob, nro, suc, importe,
                    por_acreditar, cuit, rubro_gasto)
            VALUES (@p, n.lado, n.clave, n.orden, n.fecha, n.concepto, n.detalle, n.comprob, n.nro, n.suc,
                    n.importe, 0, n.cuit, n.rubro_gasto);
          DROP TABLE #conc_arrastre;
        `);
      }
    }

    // 2) Donde el motor usó un movimiento del resumen anterior ('A') que quedó
    //    pendiente al cierre, el cruce pasa a usar el arrastrado ('Q').
    await req().query(`
      UPDATE ci SET movimiento_id = q.id
      FROM conc_cruce_items ci
      JOIN conc_cruces c ON c.id = ci.cruce_id AND c.deshecho = 0 AND c.estado <> 'rechazado' AND c.periodo_id = @p
      JOIN conc_movimientos a ON a.id = ci.movimiento_id AND a.lado = 'A'
      JOIN conc_movimientos q ON q.periodo_id = @p AND q.lado = 'Q' AND q.clave = 'Q' + SUBSTRING(a.clave, 2, 250)
      WHERE NOT EXISTS (SELECT 1 FROM conc_cruce_items ci2 JOIN conc_cruces c2 ON c2.id = ci2.cruce_id
                        WHERE ci2.movimiento_id = q.id AND c2.deshecho = 0 AND c2.estado <> 'rechazado')
    `);

    // 3) Si una propuesta todavía usa un 'A', ese movimiento ya estaba
    //    conciliado el mes anterior: se avisa en la nota.
    await req().input("aviso", sql.NVarChar, AVISO_YA_CONCILIADO)
      .input("avisoLike", sql.NVarChar, AVISO_YA_CONCILIADO + "%").query(`
      UPDATE c SET nota = LEFT(@aviso + ISNULL(' ' + c.nota, ''), 400)
      FROM conc_cruces c
      WHERE c.periodo_id = @p AND c.deshecho = 0 AND c.origen = 'auto' AND c.resuelto_por IS NULL
        AND c.estado = 'a_confirmar' AND ISNULL(c.nota, '') NOT LIKE @avisoLike
        AND EXISTS (SELECT 1 FROM conc_cruce_items ci JOIN conc_movimientos a ON a.id = ci.movimiento_id
                    WHERE ci.cruce_id = c.id AND a.lado = 'A')
    `);

    // 4) Pendientes arrastrados contra pendientes del mes, mismo importe exacto:
    //    asiento viejo (R) contra el banco (B), banco viejo (Q) contra el mayor (M).
    const rLibres = await req().query(`
      SELECT m.id, m.lado, m.fecha, m.importe FROM conc_movimientos m
      WHERE m.periodo_id = @p AND m.lado IN ('M', 'B', 'Q', 'R') AND m.importe <> 0 AND ${SIN_CRUCE_VIGENTE}
      ORDER BY m.fecha, m.orden
    `);
    const libres = rLibres.recordset.map((m) => ({ ...m, centavos: centavos(m.importe) }));
    const tomados = new Set();
    const nuevos = [];
    for (const viejo of libres.filter((m) => m.lado === "R" || m.lado === "Q")) {
      const buscado = viejo.lado === "R" ? "B" : "M";
      const desde = new Date(viejo.fecha.getTime() - DIAS_ARRASTRE * 86400000);
      const candidatos = libres
        .filter((m) => m.lado === buscado && !tomados.has(m.id) && m.centavos === viejo.centavos && m.fecha >= desde)
        .sort((a, b) => Math.abs(a.fecha - viejo.fecha) - Math.abs(b.fecha - viejo.fecha));
      if (!candidatos.length) continue;
      tomados.add(candidatos[0].id);
      nuevos.push({
        ids: [viejo.id, candidatos[0].id],
        estado: "a_confirmar",
        nota: candidatos.length === 1 ? "Quedó pendiente al cerrar el mes anterior."
          : `Quedó pendiente al cerrar el mes anterior. Había ${candidatos.length} movimientos con el mismo importe; se propone el de fecha más cercana.`,
      });
    }
    if (nuevos.length) {
      const rNumero = await req().query("SELECT ISNULL(MAX(numero), 0) AS ultimo FROM conc_cruces WHERE periodo_id = @p");
      let numero = rNumero.recordset[0].ultimo;
      for (const n of nuevos) {
        const rC = await req()
          .input("numero", sql.Int, ++numero)
          .input("estado", sql.NVarChar, n.estado)
          .input("nota", sql.NVarChar, n.nota)
          .query(`
            INSERT INTO conc_cruces (periodo_id, numero, origen, regla, nota, estado, diferencia)
            OUTPUT inserted.id
            VALUES (@p, @numero, 'auto', N'Pendiente del mes anterior', @nota, @estado, 0)
          `);
        await req().query(`INSERT INTO conc_cruce_items (cruce_id, movimiento_id) VALUES
          (${rC.recordset[0].id}, ${n.ids[0]}), (${rC.recordset[0].id}, ${n.ids[1]})`);
      }
    }
    await transaccion.commit();
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

// Saca del período los pendientes arrastrados del mes anterior (cuando ese
// mes se reabre). Corre dentro de la transacción de quien llama.
async function quitarArrastre(req, periodoId, usuarioId) {
  // Los cruces del motor vuelven a usar el movimiento del resumen anterior ('A').
  await req().input("p", sql.Int, periodoId).query(`
    UPDATE ci SET movimiento_id = a.id
    FROM conc_cruce_items ci
    JOIN conc_cruces c ON c.id = ci.cruce_id AND c.deshecho = 0 AND c.periodo_id = @p
    JOIN conc_movimientos q ON q.id = ci.movimiento_id AND q.lado = 'Q'
    JOIN conc_movimientos a ON a.periodo_id = @p AND a.lado = 'A' AND a.clave = 'A' + SUBSTRING(q.clave, 2, 250)
  `);
  // Cruces que siguen usando arrastrados: los automáticos se borran, los
  // tocados a mano se deshacen con una nota.
  const rCruces = await req().input("p", sql.Int, periodoId).query(`
    SELECT DISTINCT c.id, CASE WHEN c.origen = 'manual' OR c.resuelto_por IS NOT NULL THEN 1 ELSE 0 END AS tocado
    FROM conc_cruces c JOIN conc_cruce_items ci ON ci.cruce_id = c.id
    JOIN conc_movimientos m ON m.id = ci.movimiento_id
    WHERE c.periodo_id = @p AND c.deshecho = 0 AND m.lado IN ('Q', 'R')
  `);
  const borrar = rCruces.recordset.filter((c) => !c.tocado).map((c) => c.id);
  const deshacer = rCruces.recordset.filter((c) => c.tocado).map((c) => c.id);
  if (borrar.length) {
    await req().query(`
      DELETE FROM conc_cruce_items WHERE cruce_id IN (${borrar.join(",")});
      DELETE FROM conc_cruces WHERE id IN (${borrar.join(",")});
    `);
  }
  if (deshacer.length) {
    await req().input("usuarioId", sql.Int, usuarioId).input("nota", sql.NVarChar, NOTA_REAPERTURA).query(`
      UPDATE conc_cruces SET deshecho = 1, deshecho_por = @usuarioId, fecha_deshecho = GETDATE(),
             nota = LEFT(@nota + ISNULL(' ' + nota, ''), 400)
      WHERE id IN (${deshacer.join(",")})
    `);
  }
  // A las propuestas que tenían el aviso "ya conciliado el mes anterior" se les saca.
  const rMarcados = await req().input("p", sql.Int, periodoId).input("aviso", sql.NVarChar, AVISO_YA_CONCILIADO + "%").query(`
    SELECT c.id, c.nota FROM conc_cruces c
    WHERE c.periodo_id = @p AND c.deshecho = 0 AND c.nota LIKE @aviso
  `);
  for (const c of rMarcados.recordset) {
    const nota = c.nota.slice(AVISO_YA_CONCILIADO.length).trim() || null;
    await req().input("id", sql.Int, c.id).input("nota", sql.NVarChar, nota)
      .query("UPDATE conc_cruces SET nota = @nota WHERE id = @id");
  }
  // Los arrastrados que nadie usó se borran; los que tienen historia quedan como 'X'.
  await req().input("p", sql.Int, periodoId).query(`
    DELETE m FROM conc_movimientos m
    WHERE m.periodo_id = @p AND m.lado IN ('Q', 'R')
      AND NOT EXISTS (SELECT 1 FROM conc_cruce_items ci WHERE ci.movimiento_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM conc_observaciones o WHERE o.movimiento_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM conc_revisados v WHERE v.movimiento_id = m.id);
    UPDATE conc_movimientos SET lado = 'X' WHERE periodo_id = @p AND lado IN ('Q', 'R');
  `);
}

async function cerrarPeriodo(periodoId, usuarioId, permiso) {
  if (!permiso.puedeCerrar) throw new ErrorConciliacion("No tenés permiso para cerrar meses.");
  const pool = await getPool();
  const p = await datosPeriodo(() => pool.request(), periodoId);
  if (!p) throw new ErrorConciliacion("Ese mes no existe.");
  if (p.estado !== "abierto") throw new ErrorConciliacion("Sólo se puede cerrar un mes abierto.");

  const anterior = await periodoVecino(() => pool.request(), p, -1);
  const ant = mesAnterior(p.anio, p.mes);
  if (!mesBloqueado(ant.anio, ant.mes) && anterior?.estado !== "cerrado") {
    throw new ErrorConciliacion(`Primero hay que cerrar ${periodoTexto(ant.mes, ant.anio)} de este banco.`);
  }
  const rConf = await pool.request().input("id", sql.Int, periodoId).query(
    "SELECT COUNT(*) AS n FROM conc_cruces WHERE periodo_id = @id AND deshecho = 0 AND estado = 'a_confirmar'"
  );
  if (rConf.recordset[0].n) {
    throw new ErrorConciliacion(`Quedan ${rConf.recordset[0].n} propuestas sin revisar: conciliá o descartá cada una antes de cerrar.`);
  }

  await pool.request().input("id", sql.Int, periodoId).input("usuarioId", sql.Int, usuarioId).query(`
    UPDATE conc_periodos SET estado = 'cerrado', cerrado_por = @usuarioId, fecha_cierre = GETDATE()
    WHERE id = @id AND estado = 'abierto'
  `);
  const siguiente = await periodoVecino(() => pool.request(), p, 1);
  if (siguiente) await prepararArrastre(siguiente.id, usuarioId);
}

async function reabrirPeriodo(periodoId, usuarioId, permiso) {
  if (!permiso.esAdmin) throw new ErrorConciliacion("Sólo un administrador puede reabrir un mes.");
  const pool = await getPool();
  const p = await datosPeriodo(() => pool.request(), periodoId);
  if (!p || p.estado !== "cerrado") throw new ErrorConciliacion("Ese mes no está cerrado.");
  const siguiente = await periodoVecino(() => pool.request(), p, 1);
  if (siguiente?.estado === "cerrado") {
    throw new ErrorConciliacion(`Primero hay que reabrir ${periodoTexto(siguiente.mes, siguiente.anio)}.`);
  }
  if (siguiente?.estado === "procesando") {
    throw new ErrorConciliacion("El mes siguiente se está leyendo; esperá a que termine.");
  }

  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    const req = () => new sql.Request(transaccion);
    if (siguiente) await quitarArrastre(req, siguiente.id, usuarioId);
    await req().input("id", sql.Int, periodoId).query(`
      UPDATE conc_periodos SET estado = 'abierto', cerrado_por = NULL, fecha_cierre = NULL WHERE id = @id
    `);
    await transaccion.commit();
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

// Resumen de cada banco en un mes, para la pantalla de inicio. Consulta
// liviana (conteos), sin cargar todos los movimientos.
async function resumenDelMes(anio, mes) {
  const pool = await getPool();
  const r = await pool.request().input("anio", sql.SmallInt, anio).input("mes", sql.TinyInt, mes).query(`
    -- Primero el estado de cada movimiento (x) y después se suma: SQL Server no
    -- deja sumar directamente sobre una subconsulta.
    SELECT p.id, p.banco, p.estado, p.mensaje_error, p.fecha_proceso, p.fecha_cierre, p.hay_anterior,
      -- Hace cuántos segundos se leyó, medido con el reloj de la base: fecha_proceso
      -- es hora local sin zona, y compararla directo contra la hora de un archivo
      -- daba 3 horas de error.
      DATEDIFF(SECOND, p.fecha_proceso, GETDATE()) AS segundos_desde_lectura,
      u.nombre_completo AS cerrado_por,
      SUM(CASE WHEN x.lado = 'M' THEN 1 ELSE 0 END) AS mayor_total,
      SUM(CASE WHEN x.lado = 'M' AND x.conciliado = 1 THEN 1 ELSE 0 END) AS mayor_conciliados,
      SUM(CASE WHEN x.lado = 'B' AND x.importe <> 0 AND x.rubro_gasto IS NULL THEN 1 ELSE 0 END) AS banco_total,
      SUM(CASE WHEN x.lado = 'B' AND x.importe <> 0 AND x.rubro_gasto IS NULL AND x.conciliado = 1 THEN 1 ELSE 0 END) AS banco_conciliados,
      SUM(CASE WHEN x.lado IN ('M', 'R', 'B', 'Q') AND x.importe <> 0 AND x.rubro_gasto IS NULL AND x.a_revisar = 1 THEN 1 ELSE 0 END) AS a_revisar,
      SUM(CASE WHEN x.lado IN ('B', 'Q') AND x.rubro_gasto IS NOT NULL AND x.conciliado = 0 THEN 1 ELSE 0 END) AS gastos_sin_conciliar,
      (SELECT COUNT(*) FROM conc_cruces c WHERE c.periodo_id = p.id AND c.deshecho = 0 AND c.estado = 'a_confirmar') AS propuestas
    FROM conc_periodos p
    LEFT JOIN (
      SELECT m.periodo_id, m.lado, m.importe, m.rubro_gasto,
        CASE WHEN ${EXISTE_CRUCE("'conciliado'")} THEN 1 ELSE 0 END AS conciliado,
        -- "sin par": ni conciliado, ni marcado mes siguiente, ni en una propuesta
        CASE WHEN ${SIN_CRUCE_VIGENTE} THEN 1 ELSE 0 END AS a_revisar
      FROM conc_movimientos m
    ) x ON x.periodo_id = p.id
    LEFT JOIN app_usuarios u ON u.id = p.cerrado_por
    WHERE p.anio = @anio AND p.mes = @mes
    GROUP BY p.id, p.banco, p.estado, p.mensaje_error, p.fecha_proceso, p.fecha_cierre, p.hay_anterior, u.nombre_completo
  `);
  return new Map(r.recordset.map((f) => [f.banco, f]));
}

// Todas las observaciones del período (para el informe de auditoría).
async function observacionesDelPeriodo(periodoId) {
  const pool = await getPool();
  const r = await pool.request().input("id", sql.Int, periodoId).query(`
    SELECT o.movimiento_id, o.texto, o.fecha, u.nombre_completo AS usuario
    FROM conc_observaciones o
    JOIN conc_movimientos m ON m.id = o.movimiento_id
    JOIN app_usuarios u ON u.id = o.usuario_id
    WHERE m.periodo_id = @id ORDER BY o.fecha
  `);
  return r.recordset;
}

// ----------------------------------------------------------------- Cuadre

// Misma cuenta que cuadre() de motor/conciliar.py, pero desde la base: así
// refleja lo que las contadoras concilian, confirman o rechazan a mano.
//
// Con el mes anterior cerrado (conArrastre) la diferencia de saldos al inicio
// se explica con TODOS los pendientes arrastrados (lo que el banco tenía y el
// mayor no, menos lo que el mayor tenía y el banco no), y los que siguen
// pendientes entran en el cuadre del cierre como cualquier otro pendiente.
// Sin mes anterior cerrado (primer mes) se usa la cuenta del motor: sólo lo
// que la regla "mes anterior" encontró en el resumen del mes pasado.
const ES_MAYOR = (m) => m.lado === "M" || m.lado === "R";

function calcularCuadre(periodo, movimientos, cruces, conArrastre) {
  // Sólo cuenta como conciliado lo que la contadora aceptó o hizo a mano.
  const activos = cruces.filter((c) => !c.deshecho && c.estado === "conciliado");
  const cruzados = new Set(activos.flatMap((c) => c.items));
  const mesSiguiente = new Set(cruces.filter((c) => !c.deshecho && c.estado === "mes_siguiente").flatMap((c) => c.items));
  const enPropuesta = new Set(cruces.filter((c) => !c.deshecho && c.estado === "a_confirmar").flatMap((c) => c.items));
  const porId = new Map(movimientos.map((m) => [m.id, m]));
  const suma = (lista) => lista.reduce((s, m) => s + centavos(m.importe), 0);

  // Conteos para la pantalla: renglones de cada lado y en qué situación están.
  const contar = (lista) => ({
    total: lista.length,
    importe: pesos(suma(lista)),
    conciliados: lista.filter((m) => cruzados.has(m.id)).length,
    propuestos: lista.filter((m) => !cruzados.has(m.id) && enPropuesta.has(m.id)).length,
    mes_siguiente: lista.filter((m) => !cruzados.has(m.id) && mesSiguiente.has(m.id)).length,
    sin_par: lista.filter((m) => !cruzados.has(m.id) && !enPropuesta.has(m.id) && !mesSiguiente.has(m.id)).length,
  });
  const conImporte = (m) => Number(m.importe) !== 0;
  const conteo = {
    mayor: contar(movimientos.filter((m) => m.lado === "M")),
    banco: contar(movimientos.filter((m) => m.lado === "B" && conImporte(m) && !m.rubro_gasto)),
    gastos: contar(movimientos.filter((m) => m.lado === "B" && conImporte(m) && m.rubro_gasto)),
    arrastrados: contar(movimientos.filter((m) => (m.lado === "Q" || m.lado === "R") && conImporte(m))),
  };

  const mayor = movimientos.filter((m) => m.lado === "M");
  const deMayorPendientes = movimientos.filter((m) => (m.lado === "M" || m.lado === "R") && !cruzados.has(m.id));
  const deBancoPendientes = movimientos.filter((m) => (m.lado === "B" || m.lado === "Q")
    && !cruzados.has(m.id) && Number(m.importe) !== 0);
  const pendMayorDelMes = deMayorPendientes.filter((m) => m.lado === "M");
  const pendGastos = deBancoPendientes.filter((m) => m.rubro_gasto);
  const pendOtros = deBancoPendientes.filter((m) => !m.rubro_gasto);

  let totMesAnt = 0;
  let difs = 0;
  for (const c of activos) {
    const items = c.items.map((id) => porId.get(id)).filter(Boolean);
    const delMayor = items.filter(ES_MAYOR);
    const delBanco = items.filter((m) => !ES_MAYOR(m));
    // Sin arrastre, todo cruce de un asiento contra el resumen del mes anterior
    // (del motor o hecho a mano con un movimiento 'A') explica la diferencia inicial.
    const conMesAnterior = REGLAS_MES_ANTERIOR.includes(c.regla) || items.some((m) => m.lado === "A");
    if (!conArrastre && conMesAnterior) totMesAnt += suma(delMayor);
    else if (delMayor.length && delBanco.length) difs += suma(delMayor) - suma(delBanco);
  }
  if (conArrastre) {
    totMesAnt = suma(movimientos.filter((m) => m.lado === "Q")) - suma(movimientos.filter((m) => m.lado === "R"));
  }

  const iniMayor = centavos(periodo.saldo_ini_mayor);
  const finMayor = centavos(periodo.saldo_fin_mayor);
  const iniBanco = centavos(periodo.saldo_ini_banco);
  const finBanco = centavos(periodo.saldo_fin_banco);
  const difIni = iniBanco - iniMayor;
  const calculado = finMayor + suma(deBancoPendientes) - suma(deMayorPendientes) - difs;

  return {
    conteo,
    propuestas: cruces.filter((c) => !c.deshecho && c.estado === "a_confirmar").length,
    con_arrastre: !!conArrastre,
    asientos_mayor: mayor.length,
    conciliados: mayor.length - pendMayorDelMes.length,
    pend_mayor: deMayorPendientes.length,
    pend_banco: pendOtros.length,
    pend_gastos: pendGastos.length,
    pend_arrastrados: deMayorPendientes.length + deBancoPendientes.length
      - pendMayorDelMes.length - deBancoPendientes.filter((m) => m.lado === "B").length,
    a_confirmar: cruces.filter((c) => !c.deshecho && c.estado === "a_confirmar").length,
    ini_mayor: pesos(iniMayor),
    ini_banco: pesos(iniBanco),
    fin_mayor: pesos(finMayor),
    fin_banco: pesos(finBanco),
    dif_ini: pesos(difIni),
    tot_mes_ant: pesos(totMesAnt),
    sin_explicar_ini: pesos(difIni - totMesAnt),
    tot_pend_mayor: pesos(suma(deMayorPendientes)),
    tot_pend_banco: pesos(suma(pendOtros)),
    tot_gastos: pesos(suma(pendGastos)),
    difs: pesos(difs),
    calculado: pesos(calculado),
    dif_final: pesos(finBanco - calculado),
  };
}

// ----------------------------------------------------------------- Socios

// CUIT de la propia mutual: transferencias entre cuentas propias, percepciones
// de SIRCREB, etc. No se buscan como socio.
const CUIT_PROPIO = "30619630056";

// Busca en la base de socios (UNION.dbo.SOMAESGRAL, sólo lectura) los CUIT
// que aparecen en el detalle de los movimientos del banco. SONID es el CUIT
// como número; un mismo CUIT puede tener varios registros. Si la consulta
// falla (permisos, base caída) el punteo se muestra igual, sin esta marca.
async function buscarSocios(pool, cuits) {
  const lista = [...new Set(cuits)].filter((c) => /^\d{11}$/.test(c) && c !== CUIT_PROPIO);
  const socios = {};
  if (!lista.length) return socios;
  try {
    // Los CUIT ya están validados como 11 dígitos: se pueden poner literales
    // en el IN sin riesgo de inyección (y sin un parámetro por cada uno).
    for (let i = 0; i < lista.length; i += 1000) {
      const r = await pool.request().query(`
        SELECT CAST(SONID AS VARCHAR(11)) AS cuit, RTRIM(SONOMB) AS nombre, SOBSBAJA AS baja
        FROM [UNION].dbo.SOMAESGRAL
        WHERE SONID IN (${lista.slice(i, i + 1000).join(",")})
      `);
      for (const f of r.recordset) {
        if (!socios[f.cuit]) socios[f.cuit] = [];
        socios[f.cuit].push({ nombre: f.nombre, baja: f.baja ? fechaIso(f.baja) : null });
      }
    }
    return socios;
  } catch (error) {
    console.error("Error buscando socios en UNION.SOMAESGRAL:", error.message);
    return null;
  }
}

// ------------------------------------------- Detalle de un movimiento



// ¿Puede ser un error de tipeo? Mismo largo y un solo dígito distinto, dos
// dígitos vecinos invertidos, o diferencia de hasta $1 (ej. 55.817,61 contra
// 55.877,61). Recibe centavos positivos. Con importes redondos (60.000 contra
// 30.000) un dígito distinto es casualidad, no tipeo: se pide que alguno de
// los dos tenga al menos 4 cifras significativas.
function pareceTipeo(a, b) {
  if (a === b) return false;
  if (Math.abs(a - b) <= 100) return true;
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  const significativas = (s) => s.replace(/0+$/, "").length;
  if (Math.max(significativas(x), significativas(y)) < 4) return false;
  const distintos = [...x].map((c, i) => (c !== y[i] ? i : -1)).filter((i) => i >= 0);
  if (distintos.length === 1) return true;
  return distintos.length === 2 && distintos[1] === distintos[0] + 1
    && x[distintos[0]] === y[distintos[1]] && x[distintos[1]] === y[distintos[0]];
}

// Grupos de 2 a 4 candidatos que suman exactamente el objetivo (centavos).
function combinacionesQueSuman(objetivo, candidatos, maximo = 3) {
  const encontradas = [];
  const lista = candidatos.slice(0, 18);
  (function buscar(desde, suma, elegidos) {
    if (encontradas.length >= maximo) return;
    if (elegidos.length >= 2 && suma === objetivo) {
      encontradas.push([...elegidos]);
      return;
    }
    if (elegidos.length === 4) return;
    for (let i = desde; i < lista.length; i++) {
      elegidos.push(lista[i]);
      buscar(i + 1, suma + lista[i].centavos, elegidos);
      elegidos.pop();
    }
  })(0, 0, []);
  return encontradas;
}

const diasEntre = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

async function sugerencias(pool, mov, periodo) {
  // Del mayor (M, o R arrastrado) se buscan candidatos del banco (B, Q) y al revés.
  // Para un asiento del mes, también los últimos días del resumen anterior ('A'),
  // salvo que el mes anterior esté cerrado (ahí ya vienen como pendientes 'Q').
  const anterior = await periodoVecino(() => pool.request(), periodo, -1);
  const conArrastre = anterior?.estado === "cerrado";
  const ladosOpuestos = mov.lado === "M" || mov.lado === "R"
    ? ["B", "Q", ...(mov.lado === "M" && !conArrastre ? ["A"] : [])]
    : ["M", "R"];
  const rCand = await pool.request().input("p", sql.Int, mov.periodo_id).query(`
    SELECT m.id, m.lado, m.fecha, m.concepto, m.detalle, m.importe FROM conc_movimientos m
    WHERE m.periodo_id = @p AND m.lado IN (${ladosOpuestos.map((l) => `'${l}'`).join(",")})
      AND m.importe <> 0 AND ${A_REVISAR}
  `);
  const objetivo = centavos(mov.importe);
  const signo = Math.sign(objetivo);
  const candidatos = rCand.recordset
    .map((c) => ({ ...c, fecha: fechaIso(c.fecha), centavos: centavos(c.importe), dias: diasEntre(c.fecha, mov.fecha) }))
    .filter((c) => Math.sign(c.centavos) === signo)
    .sort((a, b) => Math.abs(a.dias) - Math.abs(b.dias));
  const resumen = ({ id, lado, fecha, concepto, detalle, importe, dias }) => ({ id, lado, fecha, concepto, detalle, importe, dias });

  const lista = [];
  for (const c of candidatos.filter((c) => c.centavos === objetivo)) {
    const enAnterior = c.lado === "A" ? " (en el resumen del mes anterior)" : "";
    lista.push({ tipo: "mismo_importe", texto: (c.dias ? `Mismo importe, ${Math.abs(c.dias)} días ${c.dias > 0 ? "después" : "antes"}` : "Mismo importe, mismo día") + enAnterior, movimientos: [resumen(c)] });
  }
  const parecidos = candidatos
    .filter((c) => Math.abs(c.dias) <= 10 && pareceTipeo(Math.abs(c.centavos), Math.abs(objetivo)))
    .slice(0, 3);
  for (const c of parecidos) {
    lista.push({ tipo: "parecido", texto: `Importe parecido (diferencia $ ${pesos(objetivo - c.centavos).toLocaleString("es-AR", { minimumFractionDigits: 2 })}): ¿error de tipeo?`, movimientos: [resumen(c)] });
  }
  // Sumas sólo con movimientos del mes: con los del resumen anterior ('A') salen
  // demasiadas combinaciones casuales.
  const cercanos = candidatos.filter((c) => Math.abs(c.dias) <= 5 && c.centavos !== objetivo && c.lado !== "A");
  for (const combo of combinacionesQueSuman(objetivo, cercanos)) {
    lista.push({ tipo: "suma", texto: `Suma de ${combo.length} movimientos`, movimientos: combo.map(resumen) });
  }

  // Mismo importe en otro banco del mismo mes (asiento cargado en la cuenta equivocada).
  const rOtros = await pool.request()
    .input("p", sql.Int, mov.periodo_id).input("anio", sql.SmallInt, periodo.anio).input("mes", sql.TinyInt, periodo.mes)
    .input("importe", sql.Decimal(18, 2), mov.importe)
    .query(`
      SELECT TOP 10 m.id, m.lado, m.fecha, m.concepto, m.importe, p.id AS periodo_id, b.nombre AS banco
      FROM conc_movimientos m
      JOIN conc_periodos p ON p.id = m.periodo_id
      JOIN conc_bancos b ON b.codigo = p.banco
      WHERE p.anio = @anio AND p.mes = @mes AND p.id <> @p AND m.importe = @importe
        AND m.lado IN ('M', 'B') AND ${A_REVISAR}
    `);
  // Bordes de mes: un asiento de los primeros días puede estar en el resumen
  // del mes anterior, y un movimiento del banco de los últimos días puede
  // aparecer en el mayor del mes siguiente.
  const fecha = new Date(mov.fecha);
  const dia = fecha.getUTCDate();
  const ultimoDia = new Date(Date.UTC(periodo.anio, periodo.mes, 0)).getUTCDate();
  const delMes = fecha.getUTCMonth() + 1 === periodo.mes;
  if (mov.lado === "M" && delMes && dia <= 5) {
    lista.push({ tipo: "borde", movimientos: [], texto: "Es de los primeros días del mes: el banco puede haberlo " +
      "registrado a fines del mes anterior. Si el resumen del mes anterior está incompleto (hay un aviso arriba), " +
      "cargá la parte que falta y se cruza solo." });
  }
  if (mov.lado === "B" && delMes && dia > ultimoDia - 5) {
    lista.push({ tipo: "borde", movimientos: [], texto: "Es de los últimos días del mes: puede estar asentado en " +
      "el mayor del mes siguiente. Al cerrar este mes pasa como pendiente y se cruza solo cuando aparezca." });
  }

  for (const o of rOtros.recordset) {
    lista.push({
      tipo: "otro_banco",
      texto: `Mismo importe pendiente en ${o.banco} (${o.lado === "M" ? "mayor" : "resumen del banco"})`,
      periodoId: o.periodo_id,
      movimientos: [{ id: o.id, lado: o.lado, fecha: fechaIso(o.fecha), concepto: o.concepto, importe: o.importe }],
    });
  }
  return lista;
}

// Estado de un movimiento para la pantalla, según el cruce vigente en que esté.
const ESTADO_MOVIMIENTO = `
  CASE
    WHEN ${EXISTE_CRUCE("'conciliado'")} THEN 'conciliado'
    WHEN ${EXISTE_CRUCE("'mes_siguiente'")} THEN 'mes_siguiente'
    WHEN ${EXISTE_CRUCE("'a_confirmar'")} THEN 'propuesto'
    ELSE 'sin_par'
  END`;

async function detalleMovimiento(movimientoId) {
  const pool = await getPool();
  const r = await pool.request().input("id", sql.Int, movimientoId).query(`
    SELECT m.*, p.banco, p.anio, p.mes, p.estado AS estado_periodo, ${ESTADO_MOVIMIENTO} AS estado_mov,
      (SELECT TOP 1 c.id FROM conc_cruce_items ci JOIN conc_cruces c ON c.id = ci.cruce_id
        WHERE ci.movimiento_id = m.id AND c.deshecho = 0 AND c.estado IN ('conciliado', 'mes_siguiente')) AS cruce_id
    FROM conc_movimientos m JOIN conc_periodos p ON p.id = m.periodo_id
    WHERE m.id = @id AND m.lado <> 'X'
  `);
  const mov = r.recordset[0];
  if (!mov) return null;

  const [rObs, rRev] = await Promise.all([
    pool.request().input("id", sql.Int, movimientoId).query(`
      SELECT o.id, o.texto, o.fecha, u.nombre_completo AS usuario
      FROM conc_observaciones o JOIN app_usuarios u ON u.id = o.usuario_id
      WHERE o.movimiento_id = @id ORDER BY o.fecha
    `),
    pool.request().input("id", sql.Int, movimientoId).query(`
      SELECT v.fecha, u.nombre_completo AS usuario
      FROM conc_revisados v JOIN app_usuarios u ON u.id = v.usuario_id
      WHERE v.movimiento_id = @id
    `),
  ]);

  // Se buscan candidatos para lo que todavía no está conciliado ni marcado.
  const pendiente = ["sin_par", "propuesto"].includes(mov.estado_mov) && ["M", "B", "Q", "R"].includes(mov.lado);
  return {
    movimiento: {
      id: mov.id, lado: mov.lado, fecha: fechaIso(mov.fecha), concepto: mov.concepto, detalle: mov.detalle,
      nro: mov.nro, importe: mov.importe, cuit: mov.cuit, rubroGasto: mov.rubro_gasto,
    },
    periodoId: mov.periodo_id,
    abierto: mov.estado_periodo === "abierto",
    estado: mov.estado_mov,
    cruceId: mov.cruce_id,
    pendiente,
    observaciones: rObs.recordset,
    revisado: rRev.recordset[0] || null,
    sugerencias: pendiente && Number(mov.importe) !== 0 ? await sugerencias(pool, mov, mov) : [],
  };
}

async function periodoAbiertoDeMovimiento(pool, movimientoId) {
  const r = await pool.request().input("id", sql.Int, movimientoId).query(`
    SELECT p.estado FROM conc_movimientos m JOIN conc_periodos p ON p.id = m.periodo_id WHERE m.id = @id
  `);
  if (!r.recordset[0]) throw new ErrorConciliacion("Ese movimiento no existe.");
  if (r.recordset[0].estado !== "abierto") throw new ErrorConciliacion("Este mes no está abierto: no se puede modificar.");
}

async function agregarObservacion(movimientoId, texto, usuarioId) {
  const limpio = String(texto || "").trim();
  if (!limpio) throw new ErrorConciliacion("La observación está vacía.");
  const pool = await getPool();
  await periodoAbiertoDeMovimiento(pool, movimientoId);
  await pool.request()
    .input("id", sql.Int, movimientoId)
    .input("texto", sql.NVarChar, limpio.slice(0, 1000))
    .input("usuarioId", sql.Int, usuarioId)
    .query("INSERT INTO conc_observaciones (movimiento_id, texto, usuario_id) VALUES (@id, @texto, @usuarioId)");
}

async function marcarRevisado(movimientoId, revisado, usuarioId) {
  const pool = await getPool();
  await periodoAbiertoDeMovimiento(pool, movimientoId);
  const req = pool.request().input("id", sql.Int, movimientoId).input("usuarioId", sql.Int, usuarioId);
  if (revisado) {
    await req.query(`
      IF NOT EXISTS (SELECT 1 FROM conc_revisados WHERE movimiento_id = @id)
        INSERT INTO conc_revisados (movimiento_id, usuario_id) VALUES (@id, @usuarioId)
    `);
  } else {
    await req.query("DELETE FROM conc_revisados WHERE movimiento_id = @id");
  }
}

// ------------------------------------------------- Conciliación a mano

class ErrorConciliacion extends Error {}

const listaIds = (ids) => ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
const NOTA_REEMPLAZADA = "Reemplazada por una conciliación hecha a mano.";

// Las propuestas (y marcas "mes siguiente") que usan alguno de estos
// movimientos se dejan de lado: ahora manda lo que hizo la contadora.
async function descartarPropuestasDe(req, ids, usuarioId) {
  await req().input("usuarioId", sql.Int, usuarioId).input("nota", sql.NVarChar, NOTA_REEMPLAZADA).query(`
    UPDATE c SET deshecho = 1, deshecho_por = @usuarioId, fecha_deshecho = GETDATE(),
           nota = LEFT(@nota + ISNULL(' ' + c.nota, ''), 400)
    FROM conc_cruces c
    WHERE c.deshecho = 0 AND c.estado IN ('a_confirmar', 'mes_siguiente')
      AND EXISTS (SELECT 1 FROM conc_cruce_items ci WHERE ci.cruce_id = c.id AND ci.movimiento_id IN (${ids.join(",")}))
  `);
}

async function insertarCruce(req, periodoId, datos) {
  const rNumero = await req().query("SELECT ISNULL(MAX(numero), 0) + 1 AS numero FROM conc_cruces WHERE periodo_id = @periodoId");
  const rCruce = await req()
    .input("numero", sql.Int, rNumero.recordset[0].numero)
    .input("regla", sql.NVarChar, datos.regla)
    .input("nota", sql.NVarChar, datos.nota ? String(datos.nota).slice(0, 400) : null)
    .input("estado", sql.NVarChar, datos.estado)
    .input("diferencia", sql.Decimal(18, 2), datos.diferencia || 0)
    .input("usuarioId", sql.Int, datos.usuarioId)
    .query(`
      INSERT INTO conc_cruces (periodo_id, numero, origen, regla, nota, estado, diferencia, creado_por)
      OUTPUT inserted.id
      VALUES (@periodoId, @numero, 'manual', @regla, @nota, @estado, @diferencia, @usuarioId)
    `);
  const cruceId = rCruce.recordset[0].id;
  await req().query(
    `INSERT INTO conc_cruce_items (cruce_id, movimiento_id) VALUES ${datos.ids.map((id) => `(${cruceId}, ${id})`).join(",")}`
  );
  return cruceId;
}

async function movimientosParaCruzar(req, ids) {
  // ids validados como enteros: van literales en el IN.
  const r = await req().query(`
    SELECT m.id, m.lado, m.importe, CASE WHEN ${SIN_CONCILIAR} THEN 0 ELSE 1 END AS conciliado
    FROM conc_movimientos m
    WHERE m.periodo_id = @periodoId AND m.id IN (${ids.join(",")})
  `);
  const movs = r.recordset;
  if (movs.length !== ids.length || movs.some((m) => !["M", "B", "Q", "R", "A"].includes(m.lado))) {
    throw new ErrorConciliacion("Algún movimiento no es de este mes.");
  }
  if (movs.some((m) => m.conciliado)) {
    throw new ErrorConciliacion("Algún movimiento ya está conciliado. Actualizá la pantalla.");
  }
  return movs;
}

async function enTransaccion(periodoId, accion) {
  const pool = await getPool();
  const transaccion = new sql.Transaction(pool);
  await transaccion.begin();
  try {
    const req = () => new sql.Request(transaccion).input("periodoId", sql.Int, periodoId);
    const rPeriodo = await req().query("SELECT estado FROM conc_periodos WITH (UPDLOCK) WHERE id = @periodoId");
    if (rPeriodo.recordset[0]?.estado !== "abierto") {
      throw new ErrorConciliacion("Este mes no está abierto: no se puede modificar.");
    }
    const resultado = await accion(req);
    await transaccion.commit();
    return resultado;
  } catch (error) {
    await transaccion.rollback().catch(() => {});
    throw error;
  }
}

// Concilia a mano los movimientos elegidos (uno o varios de cada lado). Si son
// de un solo lado, tienen que anularse entre sí (asiento y contraasiento).
async function crearCruceManual(periodoId, idsPedidos, usuarioId, nota) {
  const ids = [...new Set(listaIds(idsPedidos))];
  if (!ids.length) throw new ErrorConciliacion("No hay movimientos elegidos.");
  return enTransaccion(periodoId, async (req) => {
    const movs = await movimientosParaCruzar(req, ids);
    const suma = (lado) => movs.filter((m) => (lado === "M" ? ES_MAYOR(m) : !ES_MAYOR(m)))
      .reduce((s, m) => s + centavos(m.importe), 0);
    const hayMayor = movs.some(ES_MAYOR);
    const hayBanco = movs.some((m) => !ES_MAYOR(m));
    let diferencia = 0;
    if (hayMayor && hayBanco) {
      diferencia = pesos(suma("M") - suma("B"));
    } else if (suma(hayMayor ? "M" : "B") !== 0) {
      throw new ErrorConciliacion("Si elegís movimientos de un solo lado, tienen que anularse entre sí (sumar cero).");
    }
    await descartarPropuestasDe(req, ids, usuarioId);
    const regla = hayMayor && hayBanco
      ? (movs.some((m) => m.lado === "A") ? "Mes anterior (manual)" : "Manual")
      : hayMayor ? "Anulados en mayor (manual)" : "Anulados en banco (manual)";
    return insertarCruce(req, periodoId, { ids, regla, nota, estado: "conciliado", diferencia, usuarioId });
  });
}

// "Se registra el mes siguiente": un movimiento de los últimos días (ej. del
// banco del 30/09 que la mutual asienta el 01/10 porque entró después de
// hora). No queda conciliado: sigue pendiente en el cuadre y pasa al mes
// siguiente al cerrar, pero deja de figurar entre lo que hay que revisar.
async function marcarMesSiguiente(movimientoId, usuarioId) {
  const pool = await getPool();
  const r = await pool.request().input("id", sql.Int, movimientoId)
    .query("SELECT periodo_id, lado FROM conc_movimientos WHERE id = @id");
  const mov = r.recordset[0];
  if (!mov) throw new ErrorConciliacion("Ese movimiento no existe.");
  if (mov.lado !== "M" && mov.lado !== "B") {
    throw new ErrorConciliacion("Sólo se puede marcar un asiento o un movimiento del banco de este mes.");
  }
  return enTransaccion(mov.periodo_id, async (req) => {
    await movimientosParaCruzar(req, [movimientoId]);
    const rYa = await req().input("mov", sql.Int, movimientoId).query(`
      SELECT COUNT(*) AS n FROM conc_cruce_items ci JOIN conc_cruces c ON c.id = ci.cruce_id
      WHERE ci.movimiento_id = @mov AND c.deshecho = 0 AND c.estado = 'mes_siguiente'
    `);
    if (rYa.recordset[0].n) throw new ErrorConciliacion("Ese renglón ya está marcado para el mes siguiente.");
    await descartarPropuestasDe(req, [movimientoId], usuarioId);
    return insertarCruce(req, mov.periodo_id, {
      ids: [movimientoId], regla: "Se registra el mes siguiente", estado: "mes_siguiente", usuarioId,
    });
  });
}

// aceptar / rechazar una propuesta, o deshacer algo conciliado o marcado.
// Nada se borra: queda registrado quién lo hizo y cuándo.
async function resolverCruce(cruceId, accion, usuarioId) {
  const pool = await getPool();
  const r = await pool.request().input("id", sql.Int, cruceId)
    .query("SELECT periodo_id, estado, deshecho FROM conc_cruces WHERE id = @id");
  const cruce = r.recordset[0];
  if (!cruce || cruce.deshecho) throw new ErrorConciliacion("Eso ya no existe. Actualizá la pantalla.");

  return enTransaccion(cruce.periodo_id, async (req) => {
    const q = () => req().input("id", sql.Int, cruceId).input("usuarioId", sql.Int, usuarioId);
    if (accion === "aceptar" || accion === "rechazar") {
      if (cruce.estado !== "a_confirmar") throw new ErrorConciliacion("Esa propuesta ya se revisó. Actualizá la pantalla.");
      if (accion === "aceptar") {
        // Ninguno de sus movimientos puede estar ya conciliado por otro lado.
        const rOtro = await q().query(`
          SELECT COUNT(*) AS n FROM conc_cruce_items ci
          JOIN conc_cruce_items ci2 ON ci2.movimiento_id = ci.movimiento_id AND ci2.cruce_id <> ci.cruce_id
          JOIN conc_cruces c2 ON c2.id = ci2.cruce_id AND c2.deshecho = 0 AND c2.estado IN ('conciliado', 'mes_siguiente')
          WHERE ci.cruce_id = @id
        `);
        if (rOtro.recordset[0].n) throw new ErrorConciliacion("Algún movimiento de esta propuesta ya está conciliado o marcado.");
      }
      await q().input("estado", sql.NVarChar, accion === "aceptar" ? "conciliado" : "rechazado").query(`
        UPDATE conc_cruces SET estado = @estado, resuelto_por = @usuarioId, fecha_resuelto = GETDATE()
        WHERE id = @id AND estado = 'a_confirmar' AND deshecho = 0
      `);
    } else if (accion === "deshacer") {
      if (cruce.estado === "rechazado" || cruce.estado === "a_confirmar") {
        throw new ErrorConciliacion("Eso no está conciliado.");
      }
      await q().query(`
        UPDATE conc_cruces SET deshecho = 1, deshecho_por = @usuarioId, fecha_deshecho = GETDATE()
        WHERE id = @id AND deshecho = 0
      `);
    } else {
      throw new ErrorConciliacion("Acción inválida.");
    }
  });
}

// Propuesta "exacta": un asiento contra un movimiento del banco, mismo importe,
// a no más de DIAS_HABILES_EXACTA días hábiles. Son las que se pueden aceptar
// todas juntas con un botón (que aprieta la contadora).
function esExacta(cruce, porId) {
  if (cruce.estado !== "a_confirmar" || cruce.items.length !== 2) return false;
  const items = cruce.items.map((id) => porId.get(id));
  const mayor = items.find(ES_MAYOR);
  const banco = items.find((m) => m && !ES_MAYOR(m));
  if (!mayor || !banco || centavos(mayor.importe) !== centavos(banco.importe)) return false;
  return diasHabiles(mayor.fecha, banco.fecha) <= DIAS_HABILES_EXACTA;
}

async function aceptarExactas(periodoId, idsPedidos, usuarioId) {
  const ids = [...new Set(listaIds(idsPedidos || []))];
  if (!ids.length) return 0;
  const datos = await cargarPeriodo(periodoId);
  const porId = new Map(datos.movimientos.map((m) => [m.id, m]));
  const exactas = datos.cruces.filter((c) => ids.includes(c.id) && esExacta(c, porId)).map((c) => c.id);
  if (!exactas.length) return 0;
  await enTransaccion(periodoId, async (req) => {
    await req().input("usuarioId", sql.Int, usuarioId).query(`
      UPDATE conc_cruces SET estado = 'conciliado', resuelto_por = @usuarioId, fecha_resuelto = GETDATE()
      WHERE periodo_id = @periodoId AND id IN (${exactas.join(",")}) AND estado = 'a_confirmar' AND deshecho = 0
    `);
  });
  return exactas.length;
}

async function cargarPeriodo(periodoId) {
  const pool = await getPool();
  const rPeriodo = await pool
    .request()
    .input("id", sql.Int, periodoId)
    .query(`
      SELECT p.*, b.nombre AS banco_nombre, b.moneda,
             up.nombre_completo AS procesado_por_nombre, uc.nombre_completo AS cerrado_por_nombre
      FROM conc_periodos p
      JOIN conc_bancos b ON b.codigo = p.banco
      LEFT JOIN app_usuarios up ON up.id = p.procesado_por
      LEFT JOIN app_usuarios uc ON uc.id = p.cerrado_por
      WHERE p.id = @id
    `);
  const periodo = rPeriodo.recordset[0];
  if (!periodo) return null;

  const [rMov, rCruces, rItems, rArchivos, , rRelectura] = await Promise.all([
    pool.request().input("id", sql.Int, periodoId).query(`
      SELECT m.id, m.lado, m.orden, m.fecha, m.concepto, m.detalle, m.comprob, m.nro, m.suc, m.importe, m.saldo,
             m.por_acreditar, m.cuit, m.rubro_gasto,
             (SELECT COUNT(*) FROM conc_observaciones o WHERE o.movimiento_id = m.id) AS obs,
             CASE WHEN EXISTS (SELECT 1 FROM conc_revisados v WHERE v.movimiento_id = m.id) THEN 1 ELSE 0 END AS revisado
      FROM conc_movimientos m WHERE m.periodo_id = @id AND m.lado <> 'X' ORDER BY m.lado, m.orden
    `),
    pool.request().input("id", sql.Int, periodoId).query(`
      SELECT c.id, c.numero, c.origen, c.regla, c.nota, c.estado, c.diferencia, c.deshecho, c.resuelto_por,
             uc.nombre_completo AS creado_por_nombre, c.fecha_creacion,
             ur.nombre_completo AS resuelto_por_nombre, c.fecha_resuelto
      FROM conc_cruces c
      LEFT JOIN app_usuarios uc ON uc.id = c.creado_por
      LEFT JOIN app_usuarios ur ON ur.id = c.resuelto_por
      WHERE c.periodo_id = @id AND c.deshecho = 0 ORDER BY c.numero
    `),
    pool.request().input("id", sql.Int, periodoId).query(`
      SELECT ci.cruce_id, ci.movimiento_id
      FROM conc_cruce_items ci JOIN conc_cruces c ON c.id = ci.cruce_id
      WHERE c.periodo_id = @id AND c.deshecho = 0
    `),
    pool.request().input("id", sql.Int, periodoId).query(`
      SELECT tipo, ruta, fecha FROM conc_archivos WHERE periodo_id = @id ORDER BY tipo, ruta
    `),
    pool.request().input("id", sql.Int, periodoId).query(
      "SELECT COUNT(*) AS n FROM conc_cruces WHERE periodo_id = @id AND deshecho = 1"
    ),
    // Cruces hechos a mano que se deshicieron en la última relectura de los PDF.
    pool.request().input("id", sql.Int, periodoId).input("nota", sql.NVarChar, NOTA_RELECTURA + "%").query(`
      SELECT c.id, c.numero, c.regla, m.lado, m.fecha, m.concepto, m.importe
      FROM conc_cruces c
      JOIN conc_periodos p ON p.id = c.periodo_id
      JOIN conc_cruce_items ci ON ci.cruce_id = c.id
      JOIN conc_movimientos m ON m.id = ci.movimiento_id
      WHERE c.periodo_id = @id AND c.deshecho = 1 AND c.nota LIKE @nota
        AND c.fecha_deshecho >= DATEADD(MINUTE, -10, p.fecha_proceso)
      ORDER BY c.numero, m.lado, m.orden
    `),
  ]);
  const deshechosRelectura = [];
  for (const f of rRelectura.recordset) {
    let c = deshechosRelectura.find((x) => x.id === f.id);
    if (!c) deshechosRelectura.push((c = { id: f.id, numero: f.numero, regla: f.regla, movimientos: [] }));
    c.movimientos.push({ lado: f.lado, fecha: fechaIso(f.fecha), concepto: f.concepto, importe: f.importe });
  }

  const movimientos = rMov.recordset.map((m) => ({ ...m, fecha: fechaIso(m.fecha) }));
  const itemsPorCruce = new Map();
  for (const it of rItems.recordset) {
    if (!itemsPorCruce.has(it.cruce_id)) itemsPorCruce.set(it.cruce_id, []);
    itemsPorCruce.get(it.cruce_id).push(it.movimiento_id);
  }
  const porId = new Map(movimientos.map((m) => [m.id, m]));
  const cruces = rCruces.recordset.map((c) => {
    const cruce = { ...c, items: itemsPorCruce.get(c.id) || [] };
    // Días hábiles entre el asiento y el movimiento del banco, y si es una
    // propuesta "exacta" (se puede aceptar con el botón de todas juntas).
    const items = cruce.items.map((id) => porId.get(id)).filter(Boolean);
    const m = items.find(ES_MAYOR);
    const b = items.find((x) => !ES_MAYOR(x));
    cruce.dias_habiles = m && b ? diasHabiles(m.fecha, b.fecha) : null;
    cruce.exacta = esExacta(cruce, porId);
    return cruce;
  });

  // Con el mes anterior cerrado, la diferencia inicial se explica con lo arrastrado.
  const anterior = await periodoVecino(() => pool.request(), periodo, -1);
  const conArrastre = anterior?.estado === "cerrado";
  const cuadre = calcularCuadre(periodo, movimientos, cruces, conArrastre);
  const cuadreMotor = periodo.cuadre_motor ? JSON.parse(periodo.cuadre_motor) : null;

  return {
    periodo: {
      id: periodo.id,
      banco: periodo.banco,
      bancoNombre: periodo.banco_nombre,
      moneda: periodo.moneda,
      anio: periodo.anio,
      mes: periodo.mes,
      estado: periodo.estado,
      mensajeError: periodo.mensaje_error,
      cuenta: periodo.cuenta,
      hayAnterior: periodo.hay_anterior,
      procesadoPor: periodo.procesado_por_nombre,
      fechaProceso: periodo.fecha_proceso,
      cerradoPor: periodo.cerrado_por_nombre,
      fechaCierre: periodo.fecha_cierre,
    },
    archivos: rArchivos.recordset,
    movimientos,
    cuitPropio: CUIT_PROPIO,
    deshechosRelectura,
    socios: await buscarSocios(pool, movimientos.filter((m) => !ES_MAYOR(m) && m.cuit && !m.rubro_gasto).map((m) => m.cuit)),
    cruces: cruces.map(({ resuelto_por, deshecho, ...c }) => c),
    cuadre,
    valoresAAcreditar: periodo.valores_acreditar ? JSON.parse(periodo.valores_acreditar) : [],
    avisoAnterior: cuadreMotor?.aviso_anterior || null,
    // Qué se leyó de cada PDF (renglones, saldos, totales del mayor), para mostrarlo.
    lectura: cuadreMotor?.lectura || null,
  };
}

module.exports = {
  CARPETA_BANCOS,
  PRIMER_PERIODO,
  periodoTexto,
  mesBloqueado,
  textoBloqueado,
  listarArchivos,
  olvidarArchivos,
  buscarPeriodo,
  encolarLectura,
  estaProcesando,
  liberarInterrumpidos,
  cargarPeriodo,
  guardarResultado, // para scripts y pruebas: guarda un resultado del motor ya calculado
  crearCruceManual,
  resolverCruce,
  marcarMesSiguiente,
  aceptarExactas,
  detalleMovimiento,
  agregarObservacion,
  marcarRevisado,
  cerrarPeriodo,
  reabrirPeriodo,
  observacionesDelPeriodo,
  resumenDelMes,
  ErrorConciliacion,
};
