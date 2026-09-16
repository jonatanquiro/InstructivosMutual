// Por defecto carga ".env" (producción). Para levantar una instancia de
// testeo en paralelo, sin tocar la de producción, se arranca con
// ENV_FILE=.env.test (ver npm run dev:test / start:test en package.json).
require("dotenv").config({ path: process.env.ENV_FILE || ".env" });
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");

const { requiereLogin, requiereAdmin } = require("./middleware/auth");
const { inicializar: inicializarSocket } = require("./config/socket");
const authRoutes = require("./routes/auth.routes");
const faqRoutes = require("./routes/faq.routes");
const faqAdminRoutes = require("./routes/faq-admin.routes");
const estadisticasRoutes = require("./routes/estadisticas.routes");
const cumpleaniosRoutes = require("./routes/cumpleanios.routes");
const usuariosRoutes = require("./routes/usuarios.routes");
const configRoutes = require("./routes/config.routes");
const bcraRoutes = require("./routes/bcra.routes");
const chatRoutes = require("./routes/chat.routes");

const app = express();

app.use(express.json());

// Se guarda en una variable (en vez de pasarla inline a app.use) porque el
// módulo de sockets (config/socket.js) necesita la MISMA instancia para
// poder leer la sesión de cada conexión por WebSocket.
const sessionMiddleware = session({
  // Nombre de cookie distinto en test (SESSION_COOKIE_NAME en .env.test):
  // los navegadores comparten cookies entre puertos del mismo host, así
  // que sin esto loguearte en el testeo (3001) pisaría la sesión de
  // producción (3000) si los probás desde el mismo navegador.
  name: process.env.SESSION_COOKIE_NAME || "connect.sid",
  secret: process.env.SESSION_SECRET || "cambiar-este-secreto-en-produccion",
  resave: false,
  saveUninitialized: false,
  // Sin maxAge: cookie de sesión de navegador. Se borra al cerrar el
  // navegador, así que si el usuario sale de la página tiene que volver
  // a loguearse, en vez de quedar con sesión abierta por horas.
});

app.use(sessionMiddleware);

// login.html queda accesible sin sesión; el resto de /api requiere login.
//
// OJO con el orden: "app.use(path, mw1, mw2, router)" registra mw1 y mw2
// para CUALQUIER request que matchee "path", no solo para las rutas que
// después matcheen dentro de "router". Por eso todas las rutas que debe
// poder usar cualquier logueado (no solo admins) van montadas ANTES que
// las rutas con requiereAdmin: si no, una request a, por ejemplo,
// /api/bcra/... quedaría cortada por el requiereAdmin de usuariosRoutes
// antes de llegar siquiera a bcraRoutes.
app.use("/api/auth", authRoutes);
app.use("/api", requiereLogin, faqRoutes);
app.use("/api", requiereLogin, cumpleaniosRoutes);
app.use("/api", requiereLogin, configRoutes);
app.use("/api", requiereLogin, bcraRoutes);
app.use("/api", requiereLogin, chatRoutes);
app.use("/api", requiereLogin, requiereAdmin, usuariosRoutes);
app.use("/api", requiereLogin, requiereAdmin, faqAdminRoutes);
app.use("/api", requiereLogin, requiereAdmin, estadisticasRoutes);

// Carpeta donde se guardan las imágenes adjuntadas al chat. Se sirve detrás
// de requiereLogin (antes del static general) porque son datos internos de
// la mutual, no contenido público como /img. CHAT_UPLOADS_DIR permite que
// la instancia de testeo use una carpeta separada de la de producción.
const CARPETA_UPLOADS_CHAT = path.join(__dirname, process.env.CHAT_UPLOADS_DIR || "uploads/chat");
fs.mkdirSync(CARPETA_UPLOADS_CHAT, { recursive: true });
app.use("/uploads/chat", requiereLogin, express.static(CARPETA_UPLOADS_CHAT));

// Fotos de perfil: mismo criterio que las del chat (no son públicas).
const CARPETA_UPLOADS_PERFILES = path.join(__dirname, process.env.PERFIL_UPLOADS_DIR || "uploads/perfiles");
fs.mkdirSync(CARPETA_UPLOADS_PERFILES, { recursive: true });
app.use("/uploads/perfiles", requiereLogin, express.static(CARPETA_UPLOADS_PERFILES));

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

// http.createServer(app) en vez de app.listen(...) directo: socket.io
// necesita el server HTTP "de abajo" para poder atender también conexiones
// WebSocket sobre el mismo puerto (así el chat recibe mensajes/vistos al
// instante en vez de esperar al próximo sondeo del navegador).
const servidorHttp = http.createServer(app);
inicializarSocket(servidorHttp, sessionMiddleware);

const PUERTO = process.env.PORT || 3000;
servidorHttp.listen(PUERTO, () => {
  console.log(`Servidor escuchando en http://localhost:${PUERTO}`);
});
