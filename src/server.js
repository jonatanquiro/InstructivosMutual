require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const { requiereLogin, requiereAdmin } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const faqRoutes = require("./routes/faq.routes");
const faqAdminRoutes = require("./routes/faq-admin.routes");
const estadisticasRoutes = require("./routes/estadisticas.routes");
const cumpleaniosRoutes = require("./routes/cumpleanios.routes");
const usuariosRoutes = require("./routes/usuarios.routes");
const configRoutes = require("./routes/config.routes");
const bcraRoutes = require("./routes/bcra.routes");

const app = express();

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || "cambiar-este-secreto-en-produccion",
    resave: false,
    saveUninitialized: false,
    // Sin maxAge: cookie de sesión de navegador. Se borra al cerrar el
    // navegador, así que si el usuario sale de la página tiene que volver
    // a loguearse, en vez de quedar con sesión abierta por horas.
  })
);

// login.html queda accesible sin sesión; el resto de /api requiere login.
app.use("/api/auth", authRoutes);
app.use("/api", requiereLogin, faqRoutes);
app.use("/api", requiereLogin, cumpleaniosRoutes);
app.use("/api", requiereLogin, requiereAdmin, usuariosRoutes);
app.use("/api", requiereLogin, requiereAdmin, faqAdminRoutes);
app.use("/api", requiereLogin, configRoutes);
app.use("/api", requiereLogin, requiereAdmin, estadisticasRoutes);
app.use("/api", requiereLogin, bcraRoutes);

// usuarios.html, faq-admin.html y proyectos.html son solo para admins. Se
// definen ANTES del static middleware para interceptar el pedido y no
// dejar que se sirva el archivo sin control.
app.get("/usuarios.html", requiereLogin, requiereAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "usuarios.html"));
});

app.get("/faq-admin.html", requiereLogin, requiereAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "faq-admin.html"));
});

app.get("/proyectos.html", requiereLogin, requiereAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "proyectos.html"));
});

// Archivos estáticos (HTML/CSS/JS del frontend). "index: false" es clave:
// sin esto, Express serviría public/index.html automáticamente en "/"
// SIN pasar por requiereLogin, salteando el control de sesión.
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.use("/img", express.static(path.join(__dirname, "img")));

// Cualquier página que no sea login.html pide sesión iniciada.
app.get("/", requiereLogin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PUERTO = process.env.PORT || 3000;
app.listen(PUERTO, () => {
  console.log(`Servidor escuchando en http://localhost:${PUERTO}`);
});
