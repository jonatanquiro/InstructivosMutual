# Documentación técnica por carpetas

> Qué hace cada carpeta y cada archivo importante, y cómo se conectan. Pensado para alguien
> nuevo en el proyecto. Se debe actualizar cuando se agreguen/rename/eliminen archivos o
> cambie su responsabilidad — no hace falta detallar cada línea, alcanza con que quede claro
> el propósito y las conexiones con el resto.
>
> Para una descripción de qué hace la app desde el punto de vista de un usuario, ver
> [funcionamiento-general.md](./funcionamiento-general.md).
>
> Última actualización: 2026-09-18.

## Stack y arranque

Node.js + Express 5, sin frontend framework (HTML/CSS/JS planos servidos como estáticos).
Base de datos SQL Server vía el driver `mssql`, en dos instancias separadas: `INFORMA` (datos
propios de la app) y `DW` (data warehouse de estadísticas, otro origen de datos, solo lectura).

```
npm start        # producción → node src/server.js
npm run dev      # desarrollo → node --watch src/server.js (reinicia solo)
npm run start:test / dev:test   # igual pero con ENV_FILE=.env.test, instancia de testeo aparte
```

`iniciar-servidor.bat` en la raíz hace `npm start` con un `pause` final, para arrancar el
servidor con doble clic sin usar una terminal.

## src/server.js — entrypoint

- Carga variables de entorno desde `.env` (o `ENV_FILE` si está seteada, para levantar una
  instancia de testeo en paralelo sin pisar la de producción — ver `.env.test`).
- Registra `express.json()` y `express-session` (cookie sin `maxAge` → sesión de navegador,
  se pierde al cerrarlo; nombre de cookie configurable por `SESSION_COOKIE_NAME` para poder
  tener sesión de test y de producción al mismo tiempo en el mismo navegador). **No hay
  session store configurado**: usa el `MemoryStore` por defecto de `express-session`, en
  memoria del proceso — se pierde si el servidor reinicia, y no serviría para correr más de
  una instancia del servidor en paralelo detrás de un balanceador.
- Monta las rutas bajo `/api`. **El orden importa**: `/api/auth` va sin protección (login),
  después van las rutas que puede usar cualquier logueado (`faq`, `cumpleanios`, `config`,
  `bcra`, `chat`) con `requiereLogin`, y al final las de admin (`usuarios`, `faq-admin`,
  `estadisticas`) con `requiereLogin + requiereAdmin` — si se montaran antes, un
  `app.use("/api", requiereAdmin, ...)` cortaría de rebote cualquier otra request a `/api/...`
  que matchee ese prefijo, aunque sea de otro router.
- Sirve `/uploads/chat` como estático pero protegido por `requiereLogin` (son imágenes internas,
  no contenido público). La carpeta es configurable por `CHAT_UPLOADS_DIR` (separar test/prod).
- Intercepta `usuarios.html`, `faq-admin.html` y `proyectos.html` con rutas explícitas
  `requiereLogin + requiereAdmin` **antes** del middleware de estáticos, para que no se puedan
  pedir esos HTML directamente sin pasar el control de acceso.
- Sirve el resto de `src/public` como estático con `{ index: false }` — clave: sin eso, Express
  serviría `index.html` en `/` sin pasar por `requiereLogin`.
- `GET /` (protegida) sirve `index.html`. Escucha en `PORT` (default 3000).

## src/middleware/auth.js

- `requiereLogin(req,res,next)`: si `req.session.usuarioId` existe, llama
  `registrarActividad(usuarioId)` (marca al usuario "en línea", ver `presencia.js`) y sigue.
  Si no hay sesión: `401 JSON` en rutas `/api/*`, redirect a `/login.html` en navegación normal.
- `requiereAdmin(req,res,next)`: exige `req.session.rol === "admin"`; se usa siempre después de
  `requiereLogin`. `403 JSON` en `/api/*`, redirect a `/` en navegación normal.
- No se aplica de forma global: cada grupo de rutas en `server.js` decide si lo necesita.

## src/config/ — configuración e infraestructura compartida

- **db.js**: conexión a la base **INFORMA** (usuarios, FAQ, chat, cumpleaños, configuración).
  Cachea la *promesa* de conexión (no el pool ya resuelto) para no crear pools duplicados con
  requests concurrentes; si falla, resetea la promesa para reintentar en el próximo request.
  Exporta `{ sql, getPool }`.
- **db-dw.js**: conexión aparte a la base **DW** (variables `DW_DB_*`), usada solo por
  `estadisticas.routes.js`. Usa `new sql.ConnectionPool(...)` explícito (no `sql.connect()`)
  para no compartir/pisar el pool global de `db.js`. Pensada como solo lectura. Exporta
  `{ sql, getPoolDW }`.
- **cifrado.js**: cifra/descifra el campo `texto` de los mensajes de chat con **AES-256-GCM**
  (módulo `crypto` nativo de Node, sin librerías externas). Clave en `CHAT_CLAVE_CIFRADO` (hex
  de 64 caracteres = 32 bytes), validada al cargar el módulo. `cifrarTexto` genera un IV random
  de 12 bytes por mensaje y guarda `IV + authTag + cifrado` en un solo string base64.
  `descifrarTexto` separa esas tres partes, descifra y valida el tag; si falla (por ejemplo,
  mensajes viejos guardados en texto plano antes de que existiera el cifrado), devuelve el
  valor tal cual en vez de romper — retrocompatibilidad. **Importante**: la clave no se puede
  cambiar una vez que hay mensajes guardados, quedarían ilegibles.
- **presencia.js**: "en línea" en memoria del proceso (`Map` de `usuarioId → timestamp`),
  sin tabla propia. `estaEnLinea(usuarioId)` es `true` si tuvo actividad en los últimos 45s.
  `registrarActividad` se llama desde `requiereLogin` en **cualquier** request autenticado, y
  también cada 30s mientras un usuario tenga un socket conectado (ver `socket.js`) — por eso el
  estado "en línea" no depende de estar mirando el chat ni de mandar requests HTTP sueltos
  mientras solo se está chateando. Se resetea si el servidor reinicia (no hay sesiones activas
  contra el proceso nuevo).
- **socket.js**: pone en marcha el servidor de WebSockets (librería `socket.io`), compartiendo
  la misma cookie de sesión que usa Express (`io.engine.use(sessionMiddleware)`) para saber qué
  usuario es cada conexión sin inventar otro login. Al conectar, cada socket entra a una sala
  `usuario:<id>` y a una sala `conversacion:<id>` por cada conversación en la que ya participa
  (grupal + sus privadas/grupos). Expone `emitirAConversacion(id, evento, datos)` y
  `emitirAUsuario(id, evento, datos)` para que las rutas HTTP avisen en tiempo real, y
  `unirUsuarioAConversacion(usuarioId, conversacionId)` para sumar de una a los sockets ya
  conectados de un usuario a una conversación recién creada (sin que el cliente tenga que
  pedirlo, y sin re-validar acceso: la decisión la toma el servidor en el momento de crear la
  fila en `app_chat_participantes`). También atiende el evento `marcarLeido` que manda el
  cliente cuando ve en pantalla, en el momento, un mensaje que le llegó por socket.
- **profesiones.js**: objeto fijo `PROFESIONES` (id 1–5 → nombre), usado por
  `estadisticas.routes.js` para etiquetar el módulo "Prácticas" por profesión.
- **sucursales.js**: objeto fijo `SUCURSALES` (id 0–3 → `{ nombre, color }`), usado en todo el
  data warehouse y en los gráficos de "Proyectos" para tener el mismo color/nombre siempre que
  se referencia una sucursal.

## src/routes/ — endpoints Express

Todos se registran en `server.js` bajo `/api` (ver más arriba el detalle de protección).

- **auth.routes.js** (`/api/auth`, público): `POST /login` (valida contra `app_usuarios` con
  bcrypt, mismo error genérico si el usuario no existe o si está inactivo, guarda
  `usuarioId/nombreCompleto/rol` en sesión), `POST /logout` (destruye sesión), `GET /me`
  (datos de la sesión actual + `fotoUrl` del perfil — por eso pasó de sync a async, la foto no
  viaja en la sesión — usado por el frontend para el saludo con avatar y para mostrar/ocultar
  secciones de admin).
- **chat.routes.js** (`requiereLogin`): ver detalle completo más abajo, es el módulo más
  grande e intrincado.
- **config.routes.js** (`requiereLogin`): tema y perfil personal, todo contra
  `app_config_usuario` (upsert vía `MERGE` en cada endpoint). `GET /config` trae todo junto
  (tema + telefono + email + fechaNacimiento + fotoUrl). `PUT /config` guarda solo el tema (se
  llama al toque desde los botones de tema). `PUT /config/perfil` guarda teléfono/email/fecha
  de nacimiento (los tres opcionales — mandar `""` borra el que ya tenía guardado; valida
  formato de teléfono y email con regex simples, y que la fecha no sea futura). `POST
  /config/foto` (multipart, `multer`, igual patrón que el chat: jpg/png/webp, máx. 2MB, nombre
  random en disco) sube/reemplaza la foto y borra el archivo viejo si había uno. `DELETE
  /config/foto` la saca. Las fotos se guardan en `src/uploads/perfiles/`, servidas como
  estático protegido por `requiereLogin` (mismo criterio que `/uploads/chat`).
- **cumpleanios.routes.js** (`requiereLogin`): `GET /cumpleanios`, trae los próximos 4 desde
  `app_cumpleanios`, calculando si la fecha ya pasó este año para mostrar la del año que viene.
- **bcra.routes.js** (`requiereLogin`): `GET /bcra/deudas/:cuit`, consulta en paralelo la API
  pública del BCRA (deudas de 24 meses + cheques rechazados), sin credenciales propias contra
  el BCRA. Valida formato de CUIT, traduce el código de situación crediticia (1–6) a texto,
  ajusta montos (vienen en miles). No persiste nada, es consulta directa en el momento.
- **usuarios.routes.js** (`requiereLogin + requiereAdmin`): `GET /usuarios`, `POST /usuarios`
  (hash bcrypt, rechaza usuario duplicado), `PUT /usuarios/:id` (nombre/rol/activo — bloquea
  que un admin se desactive a sí mismo), `POST /usuarios/:id/password` (mínimo 4 caracteres).
- **faq.routes.js** (`requiereLogin`, para cualquier usuario): `GET /modulos` (módulos +
  preguntas activas anidadas, alimenta la pantalla de preguntas frecuentes), `POST
  /preguntas/:id/consulta` (loguea en `app_consultas_log` que alguien vio esa respuesta).
- **faq-admin.routes.js** (`requiereLogin + requiereAdmin`): CRUD de `app_modulos` y
  `app_preguntas` (sin DELETE — se desactivan con el flag `activo`), más endpoints de
  estadísticas de uso (`/estadisticas/resumen`, `/estadisticas/top-preguntas`,
  `/estadisticas/por-modulo`, `/estadisticas/sin-consultas`) leyendo `app_consultas_log`.
- **estadisticas.routes.js** (`requiereLogin + requiereAdmin`, usa `db-dw.js`): un endpoint por
  módulo de "Proyectos" (`/socios`, `/cuotas-sociales`, `/prestamos`, `/plazo-fijo`,
  `/tarjetas`, `/comercios`, `/home-mutual`, `/optica`, `/tramites`, `/practicas` y sus
  variantes por profesión/profesional, `/panteones`), todos con filtro `desde/hasta` en
  formato `AAAAMM` (nunca antes de abril 2020), más `/sucursales` (catálogo fijo) y
  `/rango-fechas` (último mes con datos reales cargados). Devuelven datos crudos sin sumarizar
  por sucursal; el frontend decide qué agregar según los checkboxes de sucursal elegidos.

### chat-datos.js

`verificarAcceso`, `marcarLeido` y `obtenerLecturasDeOtros`: helpers puros de acceso a datos
que usan tanto `chat.routes.js` como `config/socket.js`. Viven en su propio archivo (y no
dentro de `chat.routes.js`) justamente para que `socket.js` los pueda importar sin generar una
dependencia circular entre esos dos módulos (`chat.routes.js` sí importa cosas de `socket.js`,
así que no puede ser al revés).

### chat.routes.js en detalle

Monta en `/api`. Modelo de datos: una conversación "grupal" fija (tipo `'grupal'`, libre para
cualquier logueado) + conversaciones privadas/grupos (tipo `'privada'`/`'grupo'`, requieren fila
en `app_chat_participantes`). `verificarAcceso()` (de `chat-datos.js`) centraliza ese chequeo
antes de leer/escribir.

- `GET /chat/conversaciones`: lista todas las conversaciones del usuario (grupal + las suyas),
  con último mensaje, contador de no leídos, presencia (🟢 online / cuántos del grupo) y — para
  privadas — la foto de perfil del otro participante (`otro_foto_url`, `LEFT JOIN
  app_config_usuario`; `NULL` si no cargó foto, el frontend cae en la inicial del nombre).
- `POST /chat/grupos`, `GET /chat/usuarios`, `POST /chat/conversaciones`: alta de grupo, listado
  de usuarios activos para armar un chat nuevo (con su `foto_url`), y búsqueda/creación de
  conversación privada.
- `GET /chat/conversaciones/:id/mensajes` (con `?despuesDe=`): trae hasta 50 mensajes (los
  últimos, no los primeros, si hay muchos), los descifra, suma la foto de perfil de cada
  remitente (`foto_url`, mismo `LEFT JOIN`), calcula `visto` para los mensajes propios
  (comparando contra la lectura de todos los demás participantes) y **marca como leído** hasta
  el último mensaje devuelto (`marcarLeido`) — abrir/refrescar la conversación cuenta como
  "leerla".
- `GET /chat/conversaciones/:id/lecturas`: endpoint liviano que el frontend consulta junto con
  el polling de mensajes nuevos, solo para refrescar el check de "visto" sin volver a traer y
  descifrar toda la conversación.
- `POST /chat/conversaciones/:id/mensajes` (multipart, `multer`): inserta texto (cifrado) y/o
  imagen (máx. 5MB, jpg/png/webp/gif, nombre random en disco). Enviar también cuenta como
  "leído" para quien envía. Antes de armar la respuesta busca la foto de perfil del remitente
  (consulta aparte, chica: no viaja en la sesión) y arma un único objeto `mensaje` que sirve
  tanto de respuesta HTTP como de payload del evento de socket `mensajeNuevo` (mismo formato en
  los dos lados, no hay dos formas distintas de representar un mensaje dando vueltas — así el
  avatar también le llega a quien recibe el mensaje por socket, no solo a quien lo mandó).
- `DELETE /chat/conversaciones/:id/mensajes`: borra todos los mensajes de la conversación (y
  sus imágenes en disco). Acción manual, sin borrado automático por antigüedad.

**Tiempo real (desde septiembre 2026)**: los mensajes y el "visto" ya no dependen solo de que
el navegador pregunte — `config/socket.js` los empuja por WebSocket apenas pasan:
- Al mandar un mensaje (`POST .../mensajes`), se emite `mensajeNuevo` a la sala
  `conversacion:<id>` (todos los participantes conectados, remitente incluido).
- Al marcar como leído (`marcarLeidoYAvisar`, usado tanto desde `GET .../mensajes` como desde
  el evento de socket `marcarLeido` que manda el cliente al ver un mensaje en pantalla en el
  momento en que llega), se emite `lecturaActualizada` a la misma sala, para que el doble check
  del remitente se actualice al instante.
- Al crear un grupo o un DM (`POST /chat/grupos`, `POST /chat/conversaciones`), se emite
  `conversacionNueva` a la sala `usuario:<id>` de cada participante nuevo (no a quien lo crea,
  que ya lo sabe por la respuesta HTTP), y se los suma de una a la sala de esa conversación
  (`unirUsuarioAConversacion`) para que reciban mensajes en tiempo real desde el primer momento.

El sondeo por HTTP (`chat.html` cada 2s para mensajes, cada 10s para la lista de conversaciones)
se dejó como respaldo — sigue funcionando igual si el socket se cae, y el cliente se cuida de no
duplicar un mensaje que ya llegó por el otro camino (compara contra `ultimoMensajeId`). Esto
resuelve el caso concreto de "la pestaña del chat queda de fondo mucho tiempo (otra pestaña del
mismo navegador, no solo otra ventana)": un WebSocket no depende del *throttling* que los
navegadores le aplican a los `setInterval` de pestañas ocultas, así que los mensajes siguen
llegando con la pestaña de fondo sin el límite de "como mucho una vez por minuto" que tenía el
solo-polling. Sigue habiendo un límite real: con el navegador **cerrado** no llega nada (no hay
notificación de sistema operativo) — eso solo se resuelve con Push API + Service Worker, que
además requiere HTTPS (hoy la app corre HTTP plano en la intranet), así que queda pendiente.

**Contador en el título de la pestaña**: `chat.html` actualiza `document.title` a
`"Información Mutual (N)"` mientras haya N mensajes sin leer en otras conversaciones (estilo
Facebook viejo), en vez del parpadeo que había antes. Se recalcula cada vez que se refresca la
lista de conversaciones (por sondeo o por los eventos de socket de arriba), así que también
funciona con la pestaña de fondo. En el resto de las páginas, el mismo comportamiento (título +
beep + badges) lo maneja `chat-flotante.js` — ver detalle en `src/public/` más abajo.

## src/public/ — frontend (HTML + JS + CSS planos, sin build ni framework)

- **comun.js** (se carga en todas las páginas logueadas): aplica el tema (consultando
  `/api/config`; localStorage solo se usa para evitar el flash visual antes de tener la
  confirmación del servidor — por eso cada HTML tiene además un script inline en el `<head>`
  que lee `localStorage` de forma síncrona antes de pintar), conecta el botón de "Cerrar
  sesión" (`POST /api/auth/logout`) y completa el saludo con `GET /api/auth/me`, incluyendo el
  avatar (`fotoUrl`) si el usuario cargó una foto de perfil. También inyecta dinámicamente
  `<script src="/chat-flotante.js">` (`document.createElement("script")` +
  `document.body.appendChild`) en cualquier página salvo `chat.html`, que ya tiene su propia
  experiencia completa — ver detalle de `chat-flotante.js` más abajo.
- **login.html**: formulario de usuario/contraseña contra `POST /api/auth/login`.
- **index.html**: menú principal, tarjetas hacia el resto de las pantallas (oculta las de
  admin según `GET /api/auth/me`), tarjeta de cumpleaños, y la tarjeta de "Chat" con badge
  numérico de no leídos (`#badgeChatNoLeidos`) — el sondeo, el beep y la actualización de ese
  badge los hace `chat-flotante.js` desde afuera (busca esos IDs en el DOM si existen), index.html
  no tiene lógica propia de chat.
- **preguntas.html**: pantalla de preguntas frecuentes (árbol de opciones, no IA) — módulos vía
  `GET /api/modulos`, registra cada consulta vista con `POST /api/preguntas/:id/consulta`.
- **chat.html**: chat interno completo (ver detalle en `chat.routes.js` de arriba). En celular
  usa vista "estilo WhatsApp" (una pantalla a la vez: lista o conversación, con botón de
  volver) mediante la clase `chat-conversacion-abierta` en `.chat-app`, controlada
  íntegramente en JS (`abrirConversacion()` / `btnVolverLista`), no por media query sola.
  Selector de emojis (botón 😀 junto al clip): lista fija `EMOJIS` en el propio HTML, sin
  librería ni servicio externo — inserta en la posición del cursor de `inputTexto` vía
  `selectionStart/selectionEnd`, no simplemente al final. El panel tiene un botón "✕" para
  cerrarlo explícitamente, además de cerrarse solo al tocar afuera o al volver a tocar el 😀.
  Avatares: `avatarHtml(fotoUrl, nombre, chico)` es la función compartida (foto si hay,
  si no la inicial del nombre en un círculo) que se reusa en la lista de conversaciones
  (`pintarListaConversaciones`), el nombre de cada mensaje ajeno (`agregarMensaje`) y los
  buscadores de "+ Chat"/"+ Grupo" — todos consumen el `foto_url`/`otro_foto_url` que ya viene
  en la respuesta de `chat.routes.js`, no piden nada aparte.
- **chat-flotante.js** (inyectado por `comun.js` en toda página salvo `chat.html`): la barra de
  chat flotante estilo "viejo Facebook" (Messenger de escritorio) — avisa mensajes nuevos sin
  tener que estar en `/chat.html`, con ventanitas propias para responder al toque. Es un único
  IIFE autocontenido, sin dependencias del HTML de la página donde corre (arma todo su DOM por
  JS y lo appendea a `document.body`).
  - **Layout**: un botón lanzador circular (`.cf-launcher`, 💬 con badge de total no leídos) fijo
    abajo a la derecha (`.cf-barra`). Al clickearlo despliega `.cf-panel-lista`, un flyout con
    todas las conversaciones (mismo formato que la lista de `chat.html`: avatar, título, preview,
    punto verde de en línea, badge de no leídos) y un link "Ver todos los mensajes →" a
    `/chat.html`. Clickear una fila abre/crea su ventanita.
  - **Ventanitas (`.cf-item`)**: cada conversación abierta es una tira con el nombre siempre
    visible (`.cf-item-header`), que se expande hacia arriba con `flex-direction: column-reverse`
    en vez de mover la tira de lugar. Minimizada, solo se ve esa tira. Si llega un mensaje nuevo
    estando minimizada, la tira se pinta de rojo con un pulso (clase `.cf-nuevo`) — el "cambio de
    color" en vez de mostrar el contenido. Expandida, se ven los últimos mensajes
    (`GET /chat/conversaciones/:id/mensajes`, que de paso marca como leído) y hay un input propio
    para responder (`POST /chat/conversaciones/:id/mensajes`, solo texto — sin adjuntar imagen,
    emojis, editar ni reaccionar: eso sigue siendo exclusivo de `chat.html`).
  - **Persistencia entre páginas**: como esto no es una SPA (cada `.html` es una carga nueva), qué
    ventanitas están abiertas/minimizadas se guarda en `localStorage`
    (`chatFlotanteVentanas`, array de `{id, minimizada}`) y se reconstruye al cargar cada página
    (`restaurarEstado()`), así no desaparecen al navegar de una pantalla a otra.
  - **Límite de ventanas**: como mucho `MAX_VENTANAS_ABIERTAS` (3) al mismo tiempo — al abrir una
    de más se cierra la minimizada más vieja (nunca una que el usuario tenga expandida en ese
    momento), para no llenar la pantalla de tiras.
  - **Tiempo real y sondeo**: se suscribe a los mismos eventos de socket que `chat.html`
    (`mensajeNuevo`, `conversacionNueva`), cargando `/socket.io/socket.io.js` dinámicamente si
    hace falta (mismo patrón que tenía antes el globo simple de `comun.js`). Sondea
    `/api/chat/conversaciones` cada 5s de respaldo, y cada ventanita expandida sondea sus propios
    mensajes nuevos cada 3s mientras esté abierta (se corta el intervalo al minimizarla, para no
    pedir de más).
  - **Un solo origen para el beep**: para no sonar dos veces por el mismo mensaje, el beep de
    "ventana expandida mirando la conversación en el momento" sale directo del handler del socket
    (igual que en `chat.html`), y el beep de "subió el total de no leídos en otra conversación"
    sale de `cargarConversaciones()` comparando contra la carga anterior — pero esa comparación
    **excluye** las conversaciones con ventana expandida (`totalNoLeidoRelevante()`), así ninguna
    conversación puede disparar los dos beeps a la vez.
  - **Cuidado con `hidden` + CSS de autor**: igual que ya pasó una vez con `.chat-picker-item`
    (ver más abajo), si una regla de autor le pone `display` a un elemento que se esconde con el
    atributo `hidden`, esa regla le gana al `[hidden]` del navegador aunque tengan la misma
    especificidad (el origen "autor" siempre le gana al "user agent"). Por eso `.cf-panel-lista`
    tiene el `display: flex` en una regla aparte `.cf-panel-lista:not([hidden])`, no en la
    regla base.
- **configuracion.html**: selector de tema claro/oscuro (`GET/PUT /api/config`) + sección
  "Datos personales" (foto, teléfono, email, fecha de nacimiento) contra los endpoints de
  `config.routes.js` descriptos arriba. La foto se manda apenas se elige el archivo (sin botón
  aparte); los otros tres campos tienen su propio "Guardar".
- **bcra.html**: formulario de CUIT/CUIL contra `GET /api/bcra/deudas/:cuit`, con tablas de
  deudas (filtrables por entidad/período), totales por período y cheques rechazados.
- **enlaces.html**: página estática de accesos directos externos, sin llamadas propias al
  backend (aparte de `comun.js`).
- **usuarios.html** (admin): tabla editable de usuarios + alta de usuario nuevo + cambio de
  clave (usa `prompt()` del navegador).
- **faq-admin.html** (admin): tabs de Estadísticas / Módulos / Preguntas, contra los endpoints
  de `faq-admin.routes.js`.
- **proyectos.html** (admin): dashboard de estadísticas con **Chart.js** (gráficos, vía CDN) y
  **jsPDF + jspdf-autotable** (exportar a PDF, vía CDN); 10 módulos con filtro de sucursales y
  de rango de meses, "Modo Presentación" (fullscreen para reuniones), cachea en memoria los
  datos crudos para no repetir pedidos al servidor solo por cambiar un checkbox de sucursal.
- **style.css**: variables CSS de tema (`--verde`, `--bg`, `--texto`, etc.), tema claro por
  default con overrides bajo `:root[data-theme="oscuro"]`. Organizado en bloques comentados por
  pantalla (Login, Menú principal, Preguntas frecuentes, Usuarios, BCRA, Configuración, Chat
  de preguntas, Panel admin FAQ, Proyectos, Modo Presentación, Chat interno, Chat flotante). El
  bloque "Chat flotante" (clases `.cf-*`) es el único que no vive dentro de una sola pantalla:
  se aplica en todas las páginas salvo `chat.html`, reusando las mismas variables de tema (nada
  de colores hardcodeados) para que la barra y las ventanitas respeten claro/oscuro solas.

## src/uploads/

- **chat/**: imágenes subidas al chat en producción.
- **chat-test/**: misma carpeta pero para la instancia de testeo (`CHAT_UPLOADS_DIR` en
  `.env.test`), para no mezclar archivos de prueba con los reales.
- **perfiles/**: fotos de perfil de usuario (ver `config.routes.js`), mismo criterio de
  nombre random y carpeta configurable (`PERFIL_UPLOADS_DIR`, opcional) que el chat.

## src/doc-fuentes/

Documentos Word/Excel de origen (no código) usados como insumo para redactar las preguntas
frecuentes y algún análisis puntual. No se sirven desde la app ni se leen por código.

## scripts/ — utilidades de mantenimiento (se corren a mano con `node`)

Todos (salvo `generar-usuario.js`) se conectan a la base real vía `src/config/db.js`, así que
hace falta tener el `.env` apuntando a la base correcta antes de correrlos.

- **cargar-preguntas.js**: reemplaza **todo** el contenido de `app_modulos`/`app_preguntas` por
  lo que hay en `scripts/datos/preguntas.json` (borra en orden por las FK y reinserta con
  `orden` explícito). Es lo que corre `actualizar-preguntas.bat`.
- **cargar-cumpleanios.js**: mismo patrón "todo o nada" para `app_cumpleanios` desde
  `scripts/datos/cumpleanios.json` (con `DBCC CHECKIDENT RESEED` al reinsertar).
- **exportar-bd.js**: exporta el contenido (no el esquema) de las tablas propias de la app a
  `scripts/datos/export-bd.json`, para migrar datos a otro servidor sin permisos de
  `BACKUP DATABASE`.
- **importar-bd.js**: contraparte — importa `export-bd.json` a una base nueva que ya tiene el
  esquema creado, preservando los IDs originales (`SET IDENTITY_INSERT`).
- **generar-usuario.js**: no toca ninguna base. Recibe usuario/password/nombre/rol por línea de
  comandos, hashea la contraseña y solo imprime el `INSERT` para pegarlo a mano en SSMS —
  pensado para cuando no hay conexión directa a la base real desde la máquina donde se corre.

`scripts/datos/*.json` son los archivos fuente que consumen esos scripts (no se generan solos,
alguien los edita a mano salvo `export-bd.json` que lo genera `exportar-bd.js`).

## sql/ — definición de la base

- **schema.sql**: esquema principal (dropea primero un esquema viejo pensado para RAG que ya
  no se usa: `app_documentos`, `app_chunks`, `app_preguntas_frecuentes`). Crea `app_modulos`,
  `app_preguntas`, `app_config_usuario`, `app_cumpleanios`, `app_consultas_log`. **No define
  `app_usuarios`** — esa tabla ya existe de antes y el script asume que sigue ahí.
- **agregar_chat.sql**: crea las tablas de chat (`app_chat_conversaciones`,
  `app_chat_participantes`, `app_chat_mensajes`) de forma idempotente, para bases que no
  corrieron `schema.sql` completo de nuevo.
- **agregar_lecturas_chat.sql**: crea `app_chat_lecturas` (base de "no leídos"/"visto").
- **cifrar_mensajes_chat.sql**: amplía `app_chat_mensajes.texto` a `NVARCHAR(MAX)` para poder
  guardar el texto cifrado en base64 (más largo que el texto plano original).
- **agregar_config_usuario.sql** / **agregar_cumpleanios.sql**: creación idempotente de esas
  tablas para bases existentes que no corrieron el `schema.sql` nuevo.
- **agregar_perfil_usuario.sql**: agrega (idempotente, `ALTER TABLE ADD` si la columna no
  existe) las columnas de perfil — `telefono`, `email`, `fecha_nacimiento`, `foto_archivo` — a
  `app_config_usuario` para bases que ya tenían esa tabla solo con `tema`. **Hay que correrlo a
  mano una vez contra la base INFORMA real** antes de que la sección "Datos personales" de
  Configuración funcione ahí; en una base nueva alcanza con el `schema.sql` actualizado.
- **agregar_indices_analitica.sql**: índices sobre `app_consultas_log` para el panel de
  estadísticas de preguntas.
- **desplegar_servidor.sql**: script "maestro" para poner al día el servidor real de
  producción; documenta que la mayoría de las tablas del DW ya existen ahí con datos reales.
- **profesionales.sql**: crea `UNION.dbo.PROFESIONALES` (nombres de profesionales, usados en
  el módulo "Prácticas" de Proyectos).
- **dw_socios_cuotas.sql**, **dw_prestamos.sql**, **dw_plazofijo_tarjetas.sql**: creación de las
  tablas de hechos del data warehouse (`ftasociados`, `ftprestamos`, `ftpfijo`) que alimentan
  los módulos de Socios/Ayudas Económicas/Plazo Fijo de "Proyectos".

## Variables de entorno (`.env`, `.env.test`; ver `.env.example` para la lista sin valores)

- `DB_*`: conexión a la base principal **INFORMA**.
- `DW_DB_*`: conexión a la base **DW** (recomendado un usuario de solo lectura).
- `PORT`: puerto del servidor Express (default 3000).
- `SESSION_SECRET`: secreto para firmar la cookie de sesión.
- `CHAT_CLAVE_CIFRADO`: clave hex de 32 bytes para AES-256-GCM del chat — **no cambiar una vez
  que hay mensajes guardados**, quedarían ilegibles.
- `SESSION_COOKIE_NAME` / `CHAT_UPLOADS_DIR` / `PERFIL_UPLOADS_DIR` (opcionales, los dos
  últimos usados en `.env.test`): permiten correr una instancia de testeo en paralelo a
  producción sin pisar sesiones ni archivos subidos.

`.env` y `.env.test` tienen valores reales y no se suben a git (ver `.gitignore`) — la
descripción de variables de arriba sale de `.env.example`.

## Otros archivos en la raíz

- **actualizar-preguntas.bat**: corre `node scripts/cargar-preguntas.js` con doble clic, para
  que alguien no técnico pueda recargar el contenido de preguntas frecuentes tras editar el
  JSON.
- **iniciar-servidor.bat**: corre `npm start` con doble clic.
