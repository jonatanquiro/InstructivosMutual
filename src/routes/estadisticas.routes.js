const express = require("express");
const { sql, getPoolDW } = require("../config/db-dw");
const { SUCURSALES } = require("../config/sucursales");
const { PROFESIONES } = require("../config/profesiones");

const router = express.Router();

// Todo idtiempo es AAAAMM. La DW arranca en abril 2020: nunca mostramos
// nada anterior a ese mes, sin importar qué filtros mande el front.
const MES_INICIO = 202004;

router.get("/estadisticas/sucursales", (req, res) => {
  const lista = Object.entries(SUCURSALES).map(([id, datos]) => ({
    id: Number(id),
    nombre: datos.nombre,
    color: datos.color,
  }));
  res.json(lista);
});

// El front usa esto para saber hasta qué mes hay datos cargados de verdad,
// y arrancar el filtro "Hasta" ahí en vez del mes calendario actual (que
// puede no tener carga todavía).
router.get("/estadisticas/rango-fechas", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const resultado = await pool.request().query(`
      SELECT MAX(maximo) AS maximo FROM (
        SELECT MAX(idtiempo) AS maximo FROM ftasociados
        UNION ALL
        SELECT MAX(idtiempo) FROM ftcuotasoc
        UNION ALL
        SELECT MAX(idtiempo) FROM ftprestamos
        UNION ALL
        SELECT MAX(idtiempo) FROM ftpfijo
        UNION ALL
        SELECT MAX(idtiempo) FROM ft_usuarios
        UNION ALL
        SELECT MAX(idtiempo) FROM ft_comercios
        UNION ALL
        SELECT MAX(idtiempo) FROM fthomemutual
        UNION ALL
        SELECT MAX(idtiempo) FROM ftoptica
        UNION ALL
        SELECT MAX(idtiempo) FROM fttramites
        UNION ALL
        SELECT MAX(idtiempo) FROM FTPRACTICAS
        UNION ALL
        SELECT MAX(idtiempo) FROM ftpanteones
      ) t
    `);
    const maximo = resultado.recordset[0].maximo || MES_INICIO;
    res.json({ desde: MES_INICIO, hasta: maximo });
  } catch (error) {
    console.error("Error trayendo rango de fechas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Todos los endpoints de este archivo devuelven el desglose completo por
// sucursal (nunca agregado): el front decide qué sucursales mostrar/sumar
// según los checkboxes tildados, sin necesidad de volver a pedir datos.
// "desde"/"hasta" acotan el rango de meses (AAAAMM); "desde" nunca baja de
// MES_INICIO.
function construirFiltroFechas(req, pool) {
  const desdeParam = Number(req.query.desde) || MES_INICIO;
  const desde = Math.max(desdeParam, MES_INICIO);
  const hasta = Number(req.query.hasta) || 999999;

  const request = pool
    .request()
    .input("desde", sql.Int, desde)
    .input("hasta", sql.Int, hasta);

  return { request, filtroSql: "idtiempo >= @desde AND idtiempo <= @hasta" };
}

router.get("/estadisticas/socios", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(altas) AS altas,
             SUM(bajas) AS bajas
      FROM ftasociados
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de socios:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

router.get("/estadisticas/cuotas-sociales", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(importe) AS importe,
             SUM(socios) AS socios,
             SUM(cuotas_al_dia) AS cuotas_al_dia
      FROM ftcuotasoc
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de cuotas sociales:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Préstamos totales por mes y sucursal (suma todos los tipos y cuotas).
router.get("/estadisticas/prestamos", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(importe) AS importe
      FROM ftprestamos
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de préstamos:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Plazo Fijo: se ignoran tasa y moneda (ver sql/dw_plazofijo_tarjetas.sql).
router.get("/estadisticas/plazo-fijo", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(importe) AS importe,
             SUM(dias * cantidad) AS diasPonderados
      FROM ftpfijo
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de plazo fijo:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// TMU / Tarjeta +Unión: hacemos hincapié en cantusuario, cantusuconsumos,
// totalconsumo y totalpago (cantitulares no se usa en la app).
router.get("/estadisticas/tarjetas", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantusuarios) AS cantusuario,
             SUM(cantusuconsumo) AS cantusuconsumos,
             SUM(totalconsumo) AS totalconsumo,
             SUM(totalpago) AS totalpago
      FROM ft_usuarios
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de tarjetas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Comercios: a diferencia del resto, ft_comercios no tiene idsucursal (es
// un dato global de la mutual, no por sucursal).
router.get("/estadisticas/comercios", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo,
             SUM(cantcomtotal) AS cantcomtotal,
             SUM(cantcomconsumo) AS cantcomconsumo,
             SUM(totalcomconsumo) AS totalcomconsumo
      FROM ft_comercios
      WHERE ${filtroSql}
      GROUP BY idtiempo
      ORDER BY idtiempo
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de comercios:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Home Mutual: tampoco tiene idsucursal. En vez de sucursal, cada fila
// trae "descrip" (tipo de consulta realizada). descrip es CHAR de ancho
// fijo en el origen, por eso el RTRIM.
router.get("/estadisticas/home-mutual", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, RTRIM(descrip) AS descrip,
             SUM(cantidad) AS cantidad,
             SUM(cantidadsocios) AS cantidadsocios
      FROM fthomemutual
      WHERE ${filtroSql}
      GROUP BY idtiempo, RTRIM(descrip)
      ORDER BY idtiempo
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de Home Mutual:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Óptica: patrón estándar por sucursal.
router.get("/estadisticas/optica", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(total) AS total,
             SUM(reintegro) AS reintegro
      FROM ftoptica
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de óptica:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Trámites: idsucursal es la sucursal de origen. sucursaldestino existe en
// la tabla pero no se usa todavía (queda para un análisis cruzado futuro).
router.get("/estadisticas/tramites", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, idsucursal,
             SUM(cantidad) AS cantidad,
             SUM(total) AS total
      FROM fttramites
      WHERE ${filtroSql}
      GROUP BY idtiempo, idsucursal
      ORDER BY idtiempo, idsucursal
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de trámites:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Prácticas: PROFESIONAL/PROFESION son ids sin tabla de referencia todavía
// (pendiente), así que por ahora solo se agrega por sucursal.
router.get("/estadisticas/practicas", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, SUCURSAL AS idsucursal,
             SUM(CANTIDAD) AS cantidad,
             SUM(TOTAL) AS total
      FROM FTPRACTICAS
      WHERE ${filtroSql}
      GROUP BY idtiempo, SUCURSAL
      ORDER BY idtiempo, SUCURSAL
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de prácticas:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Prácticas por profesión: PROFESION es un id fijo (1 a 5), la etiqueta
// sale de config/profesiones.js, no hace falta ir a buscarla a la base.
router.get("/estadisticas/practicas/por-profesion", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT PROFESION AS profesion,
             SUM(CANTIDAD) AS cantidad,
             SUM(TOTAL) AS total
      FROM FTPRACTICAS
      WHERE ${filtroSql}
      GROUP BY PROFESION
    `);
    const conEtiqueta = resultado.recordset.map((fila) => ({
      ...fila,
      etiqueta: PROFESIONES[fila.profesion] || `Profesión ${fila.profesion}`,
    }));
    res.json(conEtiqueta);
  } catch (error) {
    console.error("Error trayendo prácticas por profesión:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Prácticas por profesional: PROFESIONAL en FTPRACTICAS (DW) se cruza con
// ID_dbf en UNION.dbo.PROFESIONALES (otra base, misma instancia) para
// traer el nombre.
router.get("/estadisticas/practicas/por-profesional", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT f.PROFESIONAL AS profesionalId,
             p.NOMBRE AS nombre,
             SUM(f.CANTIDAD) AS cantidad,
             SUM(f.TOTAL) AS total
      FROM FTPRACTICAS f
      LEFT JOIN [UNION].dbo.PROFESIONALES p ON p.ID_dbf = f.PROFESIONAL
      WHERE ${filtroSql}
      GROUP BY f.PROFESIONAL, p.NOMBRE
      ORDER BY SUM(f.CANTIDAD) DESC
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo prácticas por profesional:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

// Panteones: sin idsucursal. Se desglosa por tipo (Simple/Doble/Urnario) y
// forma de pago (Contado/Financiación Interna/Financiación Préstamo
// Mutual). tipo y formapago son CHAR de ancho fijo, de ahí el RTRIM.
router.get("/estadisticas/panteones", async (req, res) => {
  try {
    const pool = await getPoolDW();
    const { request, filtroSql } = construirFiltroFechas(req, pool);

    const resultado = await request.query(`
      SELECT idtiempo, RTRIM(tipo) AS tipo, RTRIM(formapago) AS formapago,
             SUM(cantidad) AS cantidad,
             SUM(importe) AS importe
      FROM ftpanteones
      WHERE ${filtroSql}
      GROUP BY idtiempo, RTRIM(tipo), RTRIM(formapago)
      ORDER BY idtiempo
    `);
    res.json(resultado.recordset);
  } catch (error) {
    console.error("Error trayendo estadísticas de panteones:", error);
    res.status(500).json({ error: "Error de servidor" });
  }
});

module.exports = router;
