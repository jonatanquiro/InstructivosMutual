const { registrarActividad } = require("../config/presencia");
const { sql, getPool } = require("../config/db");
const { chatActivo } = require("../config/ajustes");

// Corta el paso si no hay sesión iniciada. Lo usamos delante de cualquier
// ruta (página o API) que solo deban ver usuarios logueados.
function requiereLogin(req, res, next) {
  if (req.session && req.session.usuarioId) {
    // Cualquier request autenticado cuenta como "está usando la app ahora":
    // así el chat puede mostrar "en línea" sin depender de que la persona
    // esté justo en la pantalla del chat.
    registrarActividad(req.session.usuarioId);
    return next();
  }

  // Si el pedido es a la API (fetch desde JS), devolvemos JSON.
  // Si es una navegación de página normal, mandamos al login.
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "No autenticado" });
  }
  return res.redirect("/login.html");
}

// Corta el paso si el usuario logueado no es admin. Se usa después de
// requiereLogin, así que para cuando esto corre ya sabemos que hay sesión.
function requiereAdmin(req, res, next) {
  if (req.session && req.session.rol === "admin") {
    return next();
  }

  if (req.originalUrl.startsWith("/api/")) {
    return res.status(403).json({ error: "No autorizado" });
  }
  return res.redirect("/");
}

// Permiso de conciliación bancaria: admins siempre; el resto sólo si figura
// en conc_permisos. Se consulta en cada request (no se guarda en la sesión)
// para que dar o quitar el permiso tenga efecto sin volver a loguearse.
async function permisoConciliacion(req) {
  const esAdmin = req.session.rol === "admin";
  const pool = await getPool();
  const resultado = await pool
    .request()
    .input("usuarioId", sql.Int, req.session.usuarioId)
    .query("SELECT puede_cerrar FROM conc_permisos WHERE usuario_id = @usuarioId");
  const fila = resultado.recordset[0];
  return {
    acceso: esAdmin || !!fila,
    puedeCerrar: esAdmin || !!fila?.puede_cerrar,
    esAdmin,
  };
}

// Se usa después de requiereLogin. Deja en req.permisoConciliacion el
// resultado para que las rutas no lo tengan que volver a consultar.
async function requiereConciliacion(req, res, next) {
  try {
    const permiso = await permisoConciliacion(req);
    if (permiso.acceso) {
      req.permisoConciliacion = permiso;
      return next();
    }
  } catch (error) {
    console.error("Error verificando permiso de conciliación:", error);
  }

  if (req.originalUrl.startsWith("/api/")) {
    return res.status(403).json({ error: "No autorizado" });
  }
  return res.redirect("/");
}

// El chat interno se puede apagar para todos desde Configuración (admin).
// Apagado, ni la página ni su API responden (no alcanza con esconder el botón).
async function requiereChatActivo(req, res, next) {
  if (await chatActivo()) return next();
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(404).json({ error: "El chat está desactivado" });
  }
  return res.redirect("/");
}

module.exports = { requiereLogin, requiereAdmin, requiereConciliacion, permisoConciliacion, requiereChatActivo };
