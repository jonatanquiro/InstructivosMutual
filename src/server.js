require("dotenv").config();
const path = require("path");
const express = require("express");
const session = require("express-session");

const { requiereLogin, requiereAdmin } = require("./middleware/auth");
const authRoutes = require("./routes/auth.routes");
const faqRoutes = require("./routes/faq.routes");
const cumpleaniosRoutes = require("./routes/cumpleanios.routes");
const usuariosRoutes = require("./routes/usuarios.routes");
const configRoutes = require("./routes/config.routes");

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
app.use("/api", requiereLogin, configRoutes);

// usuarios.html es solo para admins. Se define ANTES del static middleware
// para interceptar el pedido y no dejar que se sirva el archivo sin control.
app.get("/usuarios.html", requiereLogin, requiereAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "usuarios.html"));
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
