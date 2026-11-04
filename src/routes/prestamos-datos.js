// Control de préstamos en la base UNION (tablas PRPL*, ver
// sql/union_prestamos_planilla.sql). Ahí conviven lo importado de la planilla
// de Excel (PLORIGEN = 'EXCEL') y lo que se cargue desde el sistema en Fox.
const { sql } = require("../config/db");

const U = "[UNION].dbo.";
const FILAS_POR_LOTE = 50; // ~20 parámetros por fila; SQL Server admite 2100 por consulta

// Las tablas no existen si no se corrió el script en la base.
function faltanTablas(error) {
  return /Invalid object name '\[?UNION\]?\.dbo\.PRPL/i.test(error?.message || "");
}

async function catalogo(pool, tabla, campo) {
  const { recordset } = await pool.request().query(`SELECT ID, ${campo} AS nombre FROM ${U}${tabla}`);
  return new Map(recordset.map((r) => [r.nombre, r.ID]));
}

// Reemplaza lo importado del Excel por la planilla nueva. Lo que se haya
// cargado desde Fox no se toca, ni tampoco las filas del Excel que alguien
// corrigió después desde Fox (USUMODIF): esas se conservan y la planilla
// nueva no las vuelve a insertar (misma hoja y mismo socio).
async function volcarExcel(pool, solicitudes, usuario) {
  const estados = await catalogo(pool, "PRPLESTADO", "ESNOMBRE");
  const motivos = await catalogo(pool, "PRPLMOTIVO", "MONOMBRE");
  const { recordset: alias } = await pool.request().query(`SELECT ALIAS, IDUSUARIO FROM ${U}PRPLVENALI`);
  const vendedores = new Map(alias.map((a) => [a.ALIAS, a.IDUSUARIO]));

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const { recordset: tocadas } = await new sql.Request(tx).query(
      `SELECT PLHOJA, PLSOCIO FROM ${U}PRPLANILLA WHERE PLORIGEN = 'EXCEL' AND USUMODIF IS NOT NULL`
    );
    const conservar = new Set(tocadas.map((t) => `${t.PLHOJA}|${t.PLSOCIO.toUpperCase()}`));
    await new sql.Request(tx).query(`DELETE FROM ${U}PRPLANILLA WHERE PLORIGEN = 'EXCEL' AND USUMODIF IS NULL`);

    const nuevas = solicitudes.filter((s) => s.periodo && !conservar.has(`${s.hoja}|${s.socio.toUpperCase()}`));
    for (let i = 0; i < nuevas.length; i += FILAS_POR_LOTE) {
      await insertarLote(tx, nuevas.slice(i, i + FILAS_POR_LOTE), { estados, motivos, vendedores, usuario });
    }
    await tx.commit();
    return { insertadas: nuevas.length, conservadas: tocadas.length };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function insertarLote(tx, lote, { estados, motivos, vendedores, usuario }) {
  const pedido = new sql.Request(tx);
  const valores = lote.map((s, i) => {
    const [anio, mes] = s.periodo.split("-").map(Number);
    const campos = {
      fecha: [sql.Date, s.fecha],
      anio: [sql.SmallInt, anio],
      mes: [sql.TinyInt, mes],
      socio: [sql.VarChar(120), s.socio.slice(0, 120)],
      conyuge: [sql.VarChar(120), s.conyuge.slice(0, 120) || null],
      garante: [sql.VarChar(200), s.garantia.slice(0, 200) || null],
      importe: [sql.Numeric(15, 2), s.importe],
      plazo: [sql.SmallInt, s.plazoMeses],
      plazotx: [sql.VarChar(20), s.plazoMeses == null ? s.plazo.slice(0, 20) || null : null],
      feclic: [sql.Date, s.fechaLiq],
      formapag: [sql.VarChar(100), s.formaPago.slice(0, 100) || null],
      vendedor: [sql.Int, vendedores.get(s.vendedorClave) ?? null],
      vendtxt: [sql.VarChar(40), s.vendedor.slice(0, 40) || null],
      estado: [sql.TinyInt, estados.get(s.estado)],
      coment: [sql.VarChar(1000), s.comentarios.slice(0, 1000) || null],
      envarch: [sql.Date, s.enviadoArchivo],
      hoja: [sql.VarChar(30), s.hoja.slice(0, 30)],
      fila: [sql.Int, s.fila],
    };
    for (const [nombre, [tipo, valor]] of Object.entries(campos)) pedido.input(`${nombre}${i}`, tipo, valor ?? null);
    return `(${Object.keys(campos).map((n) => `@${n}${i}`).join(", ")}, 'EXCEL', @usuario)`;
  });
  pedido.input("usuario", sql.VarChar(20), usuario.slice(0, 20));

  const { recordset: ids } = await pedido.query(`
    INSERT INTO ${U}PRPLANILLA (PLFECHA, PLANIO, PLMES, PLSOCIO, PLCONYUGE, PLGARANTE, PLIMPORTE, PLPLAZO,
      PLPLAZOTX, PLFECLIQ, PLFORMAPAG, PLVENDEDOR, PLVENDTXT, PLESTADO, PLCOMENT, PLENVARCH, PLHOJA, PLFILA,
      PLORIGEN, USUAPLIC)
    OUTPUT INSERTED.ID, INSERTED.PLHOJA, INSERTED.PLFILA
    VALUES ${valores.join(",\n")}`);

  // Motivos de los rechazados, enlazados por hoja y fila (únicos dentro del lote).
  const idPorFila = new Map(ids.map((r) => [`${r.PLHOJA}|${r.PLFILA}`, r.ID]));
  const pares = lote.flatMap((s) => s.motivos.map((m) => [idPorFila.get(`${s.hoja}|${s.fila}`), motivos.get(m)]))
    .filter(([id, motivo]) => id && motivo);
  if (pares.length) {
    await new sql.Request(tx).query(
      `INSERT INTO ${U}PRPLSOLMOT (IDPLANILLA, IDMOTIVO) VALUES ${pares.map(([id, m]) => `(${Number(id)}, ${Number(m)})`).join(", ")}`
    );
  }
}

function fechaIso(valor) {
  return valor ? valor.toISOString().slice(0, 10) : null;
}

// "ALEJANDRO BARETTA" -> "Alejandro Baretta", para mostrar.
function nombrePropio(texto) {
  return texto.toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase());
}

// Todas las solicitudes, con la misma forma que espera prestamos.html.
async function leerSolicitudes(pool) {
  const { recordset } = await pool.request().query(`
    SELECT p.ID, p.PLFECHA, p.PLANIO, p.PLMES, p.PLSOCIO, p.PLCONYUGE, p.PLGARANTE, p.PLIMPORTE, p.PLPLAZO,
           p.PLPLAZOTX, p.PLFECLIQ, p.PLFORMAPAG, p.PLVENDTXT, p.PLCOMENT, p.PLENVARCH, p.PLORIGEN,
           e.ESNOMBRE, u.nombrecomp,
           (SELECT STRING_AGG(m.MONOMBRE, '|') FROM ${U}PRPLSOLMOT sm
              JOIN ${U}PRPLMOTIVO m ON m.ID = sm.IDMOTIVO WHERE sm.IDPLANILLA = p.ID) AS motivos
    FROM ${U}PRPLANILLA p
    JOIN ${U}PRPLESTADO e ON e.ID = p.PLESTADO
    LEFT JOIN ${U}Usuarios u ON u.id = p.PLVENDEDOR`);

  return recordset.map((r) => ({
    id: r.ID,
    fecha: fechaIso(r.PLFECHA),
    periodo: `${r.PLANIO}-${String(r.PLMES).padStart(2, "0")}`,
    socio: r.PLSOCIO,
    conyuge: r.PLCONYUGE || "",
    garantia: r.PLGARANTE || "",
    importe: r.PLIMPORTE == null ? null : Number(r.PLIMPORTE),
    plazoMeses: r.PLPLAZO,
    plazo: r.PLPLAZO != null ? `${r.PLPLAZO} meses` : r.PLPLAZOTX || "",
    fechaLiq: fechaIso(r.PLFECLIQ),
    formaPago: r.PLFORMAPAG || "",
    // Sin usuario asignado queda lo que se escribió (o "Sin dato").
    vendedor: r.nombrecomp ? nombrePropio(r.nombrecomp.trim()) : r.PLVENDTXT ? `${r.PLVENDTXT} (sin asignar)` : "Sin dato",
    comentarios: r.PLCOMENT || "",
    enviadoArchivo: fechaIso(r.PLENVARCH),
    estado: r.ESNOMBRE,
    motivos: r.motivos ? r.motivos.split("|") : [],
    origen: r.PLORIGEN,
  }));
}

module.exports = { volcarExcel, leerSolicitudes, faltanTablas };
