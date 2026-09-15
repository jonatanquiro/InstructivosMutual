const { registrarActividad } = require("../config/presencia");

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

module.exports = { requiereLogin, requiereAdmin };
