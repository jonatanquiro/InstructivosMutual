# Funcionamiento general de la app

> Este documento describe **qué hace la app y cómo se usa**, sin entrar en detalle técnico
> (para eso está [documentacion-tecnica.md](./documentacion-tecnica.md)). Se debe actualizar
> cada vez que se agrega o cambia una funcionalidad visible para el usuario.
>
> Última actualización: 2026-09-18.

## Qué es

Es la plataforma interna de la mutual: un sitio web al que entra cualquier empleado logueado,
con un menú principal desde el que se accede a preguntas frecuentes por módulo, un chat interno,
enlaces útiles, consulta de deudas en el BCRA, y (para los administradores) gestión de usuarios,
gestión del contenido de preguntas frecuentes y un panel de estadísticas/proyectos de la mutual.

Hay dos tipos de usuario:

- **Usuario común**: entra con su usuario/contraseña y ve el menú principal, preguntas
  frecuentes, chat, enlaces, cumpleaños de directivos y su propia configuración (tema
  claro/oscuro, y a futuro más preferencias — ver más abajo).
- **Administrador**: además de todo lo anterior, ve y puede entrar a "Usuarios",
  "Administrar preguntas" y "Proyectos" (estadísticas).

## Login

Pantalla de usuario/contraseña. Si falla, muestra un error genérico (no dice si el problema
fue el usuario o la contraseña, por seguridad). La sesión dura mientras el navegador esté
abierto: si el usuario cierra el navegador, tiene que volver a loguearse.

## Menú principal

Es la pantalla de aterrizaje después de loguearse. Muestra tarjetas de acceso a cada sección,
un saludo con el nombre del usuario, la tarjeta de "próximos cumpleaños" de directivos, y un
aviso (con contador y sonido) cuando hay mensajes de chat sin leer, aunque el usuario no esté
en la pantalla del chat — este último aviso en realidad aparece en **cualquier pantalla**, no
solo en el menú (ver "Barra de chat flotante" más abajo).

## Preguntas frecuentes ("Información")

No es un chatbot con inteligencia artificial: es un árbol de opciones. El usuario elige un
módulo (por ejemplo "Caja de Ahorro"), ve las preguntas de ese módulo como botones, y al
elegir una ve la respuesta ya escrita de antemano. Cada consulta queda registrada (qué
pregunta, quién, cuándo) para alimentar las estadísticas que ve el administrador.

**Cómo se actualiza el contenido**: las preguntas y respuestas no se editan directamente en
la base de datos a mano lo normal — se editan en el archivo `scripts/datos/preguntas.json` y
después se corre `actualizar-preguntas.bat` (doble clic), que reemplaza todo el contenido de
preguntas frecuentes por lo que hay en ese archivo. También se pueden crear/editar módulos y
preguntas directamente desde "Administrar preguntas" (solo admins), sin tocar el JSON.

## Chat interno

Chat de mensajería entre empleados, con:

- Una conversación grupal fija ("General") a la que entra cualquier usuario logueado.
- Conversaciones privadas 1 a 1.
- Grupos con nombre y participantes elegidos.
- Envío de texto e imágenes (hasta 5MB, jpg/png/webp/gif).
- Indicador de "en línea" (🟢) por usuario y por grupo (cuántos participantes están conectados).
- Doble check (✓✓) cuando el otro participante ya leyó el mensaje (no disponible en "General",
  no tiene sentido con muchos participantes a la vez).
- Contador de mensajes no leídos por conversación, con aviso sonoro y parpadeo del título de
  la pestaña cuando llega un mensaje nuevo y la pestaña no está siendo mirada.
- Los mensajes se guardan cifrados en la base (no se pueden leer directamente mirando la
  base de datos).
- Se puede borrar todo el historial de una conversación (acción manual, sin vuelta atrás).
- Selector de emojis (botón 😀 al lado del clip de adjuntar): panel con botón para cerrarlo,
  con una lista fija bastante amplia de emojis comunes — no depende de ningún servicio externo.
- Foto de perfil visible en el chat: en la lista de conversaciones (junto al nombre de cada
  DM), en cada mensaje de otra persona, y en los buscadores de "+ Chat"/"+ Grupo". Quien no
  cargó foto se ve con un círculo con la inicial de su nombre en vez de una foto en blanco.

**Estado actual (septiembre 2026)**: los mensajes y el "visto" llegan al instante por WebSocket
mientras el navegador esté abierto, aunque la pestaña del chat esté de fondo (minimizada, otra
ventana, o incluso otra pestaña del mismo navegador durante mucho tiempo — antes eso se
retrasaba bastante, ya no). Además, cuando hay mensajes sin leer aparece un número en el título
de la pestaña, tipo "Información Mutual (3)", como el Facebook viejo.

- Si se cierra completamente el navegador (o se apaga el celular), no van a llegar avisos —
  hace falta volver a abrir la página para ver lo nuevo. Notificaciones reales del sistema
  operativo con el navegador cerrado (como WhatsApp) necesitan HTTPS, que hoy no está disponible
  en la intranet — queda pendiente si en algún momento la app sale de la intranet.
- En celular, la pantalla de chat funciona como WhatsApp: se ve la lista de conversaciones a
  pantalla completa, y al tocar una se abre esa conversación a pantalla completa con una flecha
  para volver a la lista.

### Barra de chat flotante (estilo Facebook viejo)

Desde septiembre de 2026, mientras se navega por cualquier pantalla que no sea el chat completo
(Información, Enlaces, Proyectos, Configuración, etc.) aparece abajo a la derecha un botón 💬
con el total de mensajes sin leer. Al tocarlo se despliega la lista de conversaciones (igual que
la del chat, con avatar, último mensaje y punto verde de "en línea"), y elegir una abre una
ventanita de chat flotante abajo de la pantalla, sin necesidad de ir a la pantalla completa del
chat — se puede leer y responder mensajes de texto desde ahí mismo.

- **Minimizada**: solo se ve una tira angosta con el nombre. Si llega un mensaje nuevo mientras
  está así, la tira cambia de color (rojo, con un pulso) para avisar, pero no muestra el
  contenido del mensaje hasta que se abre.
- **Expandida**: se ve la conversación y se puede escribir y mandar mensajes de texto
  directamente. No tiene emojis, adjuntar imagen, editar ni reaccionar — para eso hay que ir al
  chat completo (el link "Ver todos los mensajes →" en la lista lleva directo).
- Se pueden tener hasta 3 ventanitas abiertas a la vez; si se abre una cuarta, se cierra sola la
  minimizada más antigua (nunca una que se esté mirando en ese momento).
- Las ventanitas que se dejaron abiertas quedan así al navegar a otra pantalla (se guardan en el
  navegador), así no hay que volver a abrirlas cada vez que se cambia de página.
- No aparece en la pantalla de chat completo (`/chat.html`), porque ahí ya se ve todo con más
  detalle — solaparía el mismo aviso dos veces.

## Cumpleaños

Tarjeta en el menú principal con los próximos cumpleaños de directivos. Los datos se cargan a
mano (no en tiempo real) corriendo `scripts/cargar-cumpleanios.js` con la lista actualizada en
`scripts/datos/cumpleanios.json`.

## Consulta BCRA

Permite buscar por CUIT/CUIL la situación crediticia de una persona/empresa en el Banco
Central (deudas de los últimos 24 meses y cheques rechazados), consultando la API pública del
BCRA en el momento — no guarda ni cachea esos datos.

## Enlaces

Página fija de accesos directos a sitios externos que usa habitualmente el personal (web de
la mutual, TMU, autogestión, correo, Crediware, consultas de CUIT/monotributo, etc.).

## Configuración

Permite elegir tema claro/oscuro y cargar datos personales: foto de perfil, teléfono, email y
fecha de nacimiento. Todo guardado por usuario (no por navegador, así que si el usuario se
loguea desde otra PC mantiene sus datos). La foto se sube apenas se elige un archivo (JPG/PNG/
WEBP, máx. 2MB); teléfono/email/fecha de nacimiento tienen su propio botón "Guardar". Los tres
campos de texto son opcionales, y se pueden borrar guardando el campo vacío.

La foto además se ve en el saludo del header (en todas las pantallas) y en el chat interno —
ver el detalle en "Chat interno" más abajo. Teléfono/email/fecha de nacimiento, por ahora,
solo se ven en la propia pantalla de Configuración.

## Administración de usuarios (solo admin)

Alta de usuarios, edición de nombre/rol/estado activo, y cambio de contraseña. Un admin no
se puede desactivar a sí mismo (para no quedar la mutual sin ningún admin activo por error).

## Administrar preguntas (solo admin)

Pantalla con tres pestañas:
- **Estadísticas**: qué preguntas se consultan más, consultas por módulo, y qué preguntas
  activas nunca consultó nadie (para detectar contenido que sobra o que no se encuentra).
- **Módulos**: alta/edición de módulos (categorías del menú de preguntas).
- **Preguntas**: alta/edición de preguntas y respuestas, con buscador.

## Proyectos (solo admin)

Panel de estadísticas de la mutual (Socios, Ayudas Económicas, Plazo Fijo, TMU, Comercios,
Home Mutual, Trámites, Óptica, Prácticas, Panteones), con gráficos, filtros por sucursal y por
rango de meses, y exportación a PDF. Incluye un "Modo Presentación" pensado para mostrarlo en
reuniones de comisión directiva (pantalla completa, letra grande, sin controles a la vista).
Los datos salen de un data warehouse separado, actualizado por procesos aparte de esta app
(esta app solo lee y muestra, no carga esos datos).

## Preguntas abiertas / pendientes de decisión

Estos son puntos comentados pero todavía no resueltos, para no perderlos de vista:

- Notificaciones reales de sistema operativo con el navegador cerrado: depende de que la app
  tenga HTTPS (hoy no lo tiene, es intranet). Si en algún momento sale de la intranet, se puede
  retomar.
- Convertir la app en PWA (instalable en el celular/PC): mismo bloqueo de HTTPS que el punto
  anterior para las partes más útiles (offline, notificaciones); el manifest/ícono solos se
  pueden dejar preparados en cualquier momento sin que dependa de eso.
- GIFs/stickers en el chat: descartado por ahora (no vale la pena el esfuerzo de sumar un
  servicio externo tipo GIPHY, o mantener un set fijo de imágenes propio, para lo que aporta).
- Panel de "usuarios conectados" a la vista (tipo la lista de contactos online que tenía el
  Facebook viejo a la derecha): quedó afuera de la barra de chat flotante a propósito, para una
  eventual segunda vuelta. El dato de presencia ya existe (`estaEnLinea()` en `presencia.js`) y
  ya se usa como punto verde en listas puntuales — falta nada más que un panel dedicado.
