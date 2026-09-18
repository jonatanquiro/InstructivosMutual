// Barra de chat flotante estilo "viejo Facebook": un globito lanzador abajo
// a la derecha con el total de no leídos, que despliega la lista de
// conversaciones, y ventanitas por conversación que se pueden minimizar
// (queda solo la tira con el nombre, cambia de color si llega algo nuevo) o
// expandir (se ve la conversación y se puede responder sin ir a /chat.html).
// Se inyecta desde comun.js en todas las páginas logueadas salvo chat.html,
// que ya tiene su propia experiencia completa.
(function () {
  const MAX_VENTANAS_ABIERTAS = 3;
  const CLAVE_LOCALSTORAGE = "chatFlotanteVentanas";

  let usuarioId = null;
  let conversaciones = [];
  let socket = null;
  const ventanas = new Map(); // conversacionId -> item

  let noLeidosPrevio = 0;
  let primeraCarga = true;
  const tituloOriginal = document.title;

  function reproducirBeep() {
    try {
      const contexto = new (window.AudioContext || window.webkitAudioContext)();
      const oscilador = contexto.createOscillator();
      const volumen = contexto.createGain();
      oscilador.frequency.value = 880;
      volumen.gain.setValueAtTime(0.15, contexto.currentTime);
      volumen.gain.exponentialRampToValueAtTime(0.001, contexto.currentTime + 0.25);
      oscilador.connect(volumen).connect(contexto.destination);
      oscilador.start();
      oscilador.stop(contexto.currentTime + 0.25);
    } catch (error) {
      // Sin interacción previa del usuario el navegador puede bloquear el audio.
    }
  }

  function avatarHtml(fotoUrl, nombre, chico) {
    const clase = "chat-avatar" + (chico ? " chat-avatar-chico" : "");
    if (fotoUrl) return `<img src="${fotoUrl}" class="${clase}" alt="" />`;
    const inicial = (nombre || "?").trim().charAt(0).toUpperCase() || "?";
    return `<span class="${clase}">${inicial}</span>`;
  }

  function avatarConv(conv, chico) {
    if (conv.tipo === "privada") return avatarHtml(conv.otro_foto_url, conv.otro_nombre_completo, chico);
    const clase = "chat-avatar" + (chico ? " chat-avatar-chico" : "");
    return `<span class="${clase}">👥</span>`;
  }

  function tituloConv(conv) {
    return conv.tipo === "privada" ? conv.otro_nombre_completo : conv.nombre;
  }

  function previewConv(conv) {
    if (conv.ultimo_texto) return conv.ultimo_texto;
    if (conv.ultimo_imagen_archivo) return "📷 Imagen";
    return "Sin mensajes todavía";
  }

  // --- Construcción del layout base (una sola vez) ---

  const cfBarra = document.createElement("div");
  cfBarra.className = "cf-barra";

  const cfBubbles = document.createElement("div");
  cfBubbles.className = "cf-bubbles";

  const cfLauncher = document.createElement("button");
  cfLauncher.type = "button";
  cfLauncher.className = "cf-launcher";
  cfLauncher.title = "Chats";
  cfLauncher.innerHTML = `💬<span class="cf-launcher-badge" id="cfLauncherBadge" hidden></span>`;
  const cfLauncherBadge = cfLauncher.querySelector("#cfLauncherBadge");

  cfBarra.append(cfBubbles, cfLauncher);

  const cfPanelLista = document.createElement("div");
  cfPanelLista.className = "cf-panel-lista";
  cfPanelLista.hidden = true;
  cfPanelLista.innerHTML = `
    <div class="cf-panel-lista-header">Conversaciones</div>
    <div class="cf-panel-lista-items" id="cfPanelListaItems"></div>
    <a href="/chat.html" class="cf-panel-lista-footer">Ver todos los mensajes →</a>
  `;
  const cfPanelListaItems = cfPanelLista.querySelector("#cfPanelListaItems");

  document.body.append(cfBarra, cfPanelLista);

  cfLauncher.addEventListener("click", () => {
    cfPanelLista.hidden = !cfPanelLista.hidden;
    if (!cfPanelLista.hidden) pintarPanelLista();
  });

  document.addEventListener("click", (evento) => {
    if (!cfPanelLista.hidden && !cfPanelLista.contains(evento.target) && evento.target !== cfLauncher) {
      cfPanelLista.hidden = true;
    }
  });

  function pintarPanelLista() {
    cfPanelListaItems.innerHTML = "";
    if (conversaciones.length === 0) {
      cfPanelListaItems.innerHTML = `<div class="cf-panel-vacio">Todavía no tenés conversaciones</div>`;
      return;
    }
    for (const conv of conversaciones) {
      const fila = document.createElement("button");
      fila.type = "button";
      fila.className = "cf-panel-item";
      const punto = conv.tipo === "privada" && conv.otro_en_linea ? "🟢 " : "";
      fila.innerHTML = `
        ${avatarConv(conv, false)}
        <span class="cf-panel-item-textos">
          <span class="cf-panel-item-titulo">${punto}${tituloConv(conv)}</span>
          <span class="cf-panel-item-preview">${previewConv(conv)}</span>
        </span>
      `;
      if (conv.no_leidos > 0) {
        const badge = document.createElement("span");
        badge.className = "cf-panel-item-badge";
        badge.textContent = conv.no_leidos > 9 ? "9+" : conv.no_leidos;
        fila.appendChild(badge);
      }
      fila.addEventListener("click", () => {
        cfPanelLista.hidden = true;
        crearOAbrirVentana(conv.id);
      });
      cfPanelListaItems.appendChild(fila);
    }
  }

  // --- Ventanitas de conversación ---

  function obtenerConversacion(id) {
    return conversaciones.find((c) => c.id === id);
  }

  function construirVentanaDom(conv) {
    const el = document.createElement("div");
    el.className = "cf-item cf-minimizada";
    el.dataset.id = conv.id;

    const header = document.createElement("div");
    header.className = "cf-item-header";
    header.innerHTML = `${avatarConv(conv, true)}<span class="cf-item-nombre">${tituloConv(conv)}</span>`;

    const btnMin = document.createElement("button");
    btnMin.type = "button";
    btnMin.className = "cf-item-btn";
    btnMin.title = "Minimizar";
    btnMin.textContent = "─";

    const btnCerrar = document.createElement("button");
    btnCerrar.type = "button";
    btnCerrar.className = "cf-item-btn";
    btnCerrar.title = "Cerrar";
    btnCerrar.textContent = "✕";

    header.append(btnMin, btnCerrar);

    const body = document.createElement("div");
    body.className = "cf-item-body";
    const mensajesEl = document.createElement("div");
    mensajesEl.className = "cf-item-mensajes";

    const form = document.createElement("form");
    form.className = "cf-item-form";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Escribí un mensaje…";
    input.className = "cf-item-input";
    input.autocomplete = "off";
    const btnEnviar = document.createElement("button");
    btnEnviar.type = "submit";
    btnEnviar.className = "cf-item-enviar";
    btnEnviar.title = "Enviar";
    btnEnviar.textContent = "➤";
    form.append(input, btnEnviar);

    body.append(mensajesEl, form);
    el.append(header, body);
    cfBubbles.appendChild(el);

    const item = {
      id: conv.id,
      esGrupal: conv.tipo !== "privada",
      el,
      mensajesEl,
      input,
      minimizada: true,
      mensajesIds: new Set(),
      ultimoMensajeId: 0,
      intervalo: null,
    };

    header.addEventListener("click", (evento) => {
      if (evento.target === btnMin || evento.target === btnCerrar) return;
      if (item.minimizada) expandirVentana(item);
      else minimizarVentana(item);
    });
    btnMin.addEventListener("click", (evento) => {
      evento.stopPropagation();
      minimizarVentana(item);
    });
    btnCerrar.addEventListener("click", (evento) => {
      evento.stopPropagation();
      cerrarVentana(item);
    });

    let enviando = false;
    form.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const texto = input.value.trim();
      if (!texto || enviando) return;
      enviando = true;
      input.value = "";
      try {
        const datos = new FormData();
        datos.append("texto", texto);
        const respuesta = await fetch(`/api/chat/conversaciones/${item.id}/mensajes`, {
          method: "POST",
          body: datos,
        });
        if (respuesta.ok) {
          const mensaje = await respuesta.json();
          agregarMensajeVentana(item, mensaje);
          item.mensajesEl.scrollTop = item.mensajesEl.scrollHeight;
          cargarConversaciones();
        }
      } finally {
        enviando = false;
        input.focus();
      }
    });

    return item;
  }

  function agregarMensajeVentana(item, mensaje) {
    if (item.mensajesIds.has(mensaje.id)) return;
    item.mensajesIds.add(mensaje.id);
    item.ultimoMensajeId = Math.max(item.ultimoMensajeId, mensaje.id);

    const esPropio = mensaje.usuario_id === usuarioId;
    const burbuja = document.createElement("div");
    burbuja.className = "burbuja cf-burbuja " + (esPropio ? "burbuja-usuario" : "burbuja-bot");

    if (mensaje.eliminado) {
      burbuja.classList.add("cf-burbuja-eliminada");
      burbuja.textContent = "Mensaje eliminado";
    } else {
      if (!esPropio && item.esGrupal) {
        const autor = document.createElement("div");
        autor.className = "cf-burbuja-autor";
        autor.textContent = mensaje.nombre_completo;
        burbuja.appendChild(autor);
      }
      if (mensaje.texto) {
        const texto = document.createElement("div");
        texto.style.whiteSpace = "pre-wrap";
        texto.textContent = mensaje.texto;
        burbuja.appendChild(texto);
      }
      if (mensaje.imagen_archivo) {
        const imagen = document.createElement("img");
        imagen.src = `/uploads/chat/${mensaje.imagen_archivo}`;
        imagen.className = "cf-burbuja-imagen";
        burbuja.appendChild(imagen);
      }
    }

    item.mensajesEl.appendChild(burbuja);
  }

  async function cargarMensajesVentana(item) {
    try {
      const respuesta = await fetch(`/api/chat/conversaciones/${item.id}/mensajes?despuesDe=${item.ultimoMensajeId}`);
      if (!respuesta.ok) return;
      const mensajes = await respuesta.json();
      if (mensajes.length === 0) return;
      mensajes.forEach((m) => agregarMensajeVentana(item, m));
      item.mensajesEl.scrollTop = item.mensajesEl.scrollHeight;
    } catch (error) {
      // Sin conexión: se reintenta en el próximo sondeo.
    }
  }

  async function expandirVentana(item) {
    item.minimizada = false;
    item.el.classList.remove("cf-minimizada", "cf-nuevo");
    guardarEstado();
    await cargarMensajesVentana(item);
    if (item.intervalo) clearInterval(item.intervalo);
    item.intervalo = setInterval(() => cargarMensajesVentana(item), 3000);
  }

  function minimizarVentana(item) {
    item.minimizada = true;
    item.el.classList.add("cf-minimizada");
    if (item.intervalo) {
      clearInterval(item.intervalo);
      item.intervalo = null;
    }
    guardarEstado();
  }

  function cerrarVentana(item) {
    if (item.intervalo) clearInterval(item.intervalo);
    item.el.remove();
    ventanas.delete(item.id);
    guardarEstado();
  }

  // No dejamos que se acumulen ventanas minimizadas sin límite: si ya hay
  // MAX_VENTANAS_ABIERTAS y llega una nueva, se cierra la minimizada más
  // vieja (nunca una que el usuario tenga expandida, esa la dejamos).
  function aplicarLimiteVentanas(idAExcluir) {
    if (ventanas.size <= MAX_VENTANAS_ABIERTAS) return;
    for (const [id, item] of ventanas) {
      if (id === idAExcluir || !item.minimizada) continue;
      cerrarVentana(item);
      break;
    }
  }

  function crearOAbrirVentana(id) {
    const existente = ventanas.get(id);
    if (existente) {
      expandirVentana(existente);
      return;
    }
    const conv = obtenerConversacion(id);
    if (!conv) return;
    const item = construirVentanaDom(conv);
    ventanas.set(id, item);
    aplicarLimiteVentanas(id);
    guardarEstado();
    expandirVentana(item);
  }

  function guardarEstado() {
    try {
      const datos = [...ventanas.values()].map((v) => ({ id: v.id, minimizada: v.minimizada }));
      localStorage.setItem(CLAVE_LOCALSTORAGE, JSON.stringify(datos));
    } catch (error) {
      // localStorage puede fallar en modo privado: no persiste, no rompe nada.
    }
  }

  // Restaura las ventanas que quedaron abiertas al navegar a otra página
  // (esto no es una SPA: cada página es una carga nueva, así que sin esto
  // las ventanitas desaparecerían cada vez que cambiás de pantalla).
  function restaurarEstado() {
    let datos = [];
    try {
      datos = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE) || "[]");
    } catch (error) {
      datos = [];
    }
    for (const { id, minimizada } of datos) {
      const conv = obtenerConversacion(id);
      if (!conv) continue;
      const item = construirVentanaDom(conv);
      ventanas.set(id, item);
      if (minimizada) {
        item.minimizada = true;
        item.el.classList.add("cf-minimizada");
      } else {
        expandirVentana(item);
      }
    }
  }

  // --- Sondeo de conversaciones (badges, título, beep de respaldo) ---

  // Cuenta solo lo no-leído en conversaciones SIN una ventana expandida en
  // este momento: lo de una ventana expandida ya lo avisa manejarMensajeNuevoSocket
  // directamente, así que si también entrara acá sonaría el beep dos veces.
  function totalNoLeidoRelevante() {
    return conversaciones
      .filter((c) => {
        const item = ventanas.get(c.id);
        return !(item && !item.minimizada);
      })
      .reduce((suma, c) => suma + (c.no_leidos || 0), 0);
  }

  function actualizarLauncherBadge(total) {
    cfLauncherBadge.hidden = total === 0;
    if (total > 0) cfLauncherBadge.textContent = total > 99 ? "99+" : total;
  }

  // El menú principal (index.html) tiene su propia tarjeta de Chat con
  // badge numérico: si existe en la página, la mantenemos sincronizada acá
  // para no duplicar el sondeo ni el beep en ese archivo.
  function actualizarBadgeTarjeta(total) {
    const badge = document.getElementById("badgeChatNoLeidos");
    const titulo = document.getElementById("tituloChat");
    if (badge) {
      badge.hidden = total === 0;
      if (total > 0) badge.textContent = total > 9 ? "9+" : total;
    }
    if (titulo) titulo.classList.toggle("tiene-no-leidos", total > 0);
  }

  async function cargarConversaciones() {
    try {
      const respuesta = await fetch("/api/chat/conversaciones");
      if (!respuesta.ok) return;
      conversaciones = await respuesta.json();

      const totalGeneral = conversaciones.reduce((suma, c) => suma + (c.no_leidos || 0), 0);
      document.title = totalGeneral > 0 ? `${tituloOriginal} (${totalGeneral > 99 ? "99+" : totalGeneral})` : tituloOriginal;
      actualizarLauncherBadge(totalGeneral);
      actualizarBadgeTarjeta(totalGeneral);

      const totalRelevante = totalNoLeidoRelevante();
      if (!primeraCarga && totalRelevante > noLeidosPrevio) reproducirBeep();
      noLeidosPrevio = totalRelevante;
      primeraCarga = false;

      if (!cfPanelLista.hidden) pintarPanelLista();
    } catch (error) {
      // Sin conexión o sin sesión: se reintenta en el próximo sondeo.
    }
  }

  // --- Socket.io: llegada de mensajes en tiempo real ---

  function cargarClienteSocketIo(callback) {
    if (window.io) return callback();
    const script = document.createElement("script");
    script.src = "/socket.io/socket.io.js";
    script.onload = callback;
    document.head.appendChild(script);
  }

  async function manejarMensajeNuevoSocket(mensaje) {
    const id = mensaje.conversacion_id;
    let item = ventanas.get(id);

    if (item && !item.minimizada) {
      // Ventana expandida: se ve el mensaje al toque, como pidió el usuario.
      agregarMensajeVentana(item, mensaje);
      item.mensajesEl.scrollTop = item.mensajesEl.scrollHeight;
      if (mensaje.usuario_id !== usuarioId) {
        reproducirBeep();
        socket.emit("marcarLeido", { conversacionId: id, mensajeId: mensaje.id });
      }
    } else if (mensaje.usuario_id !== usuarioId) {
      // Ventana minimizada o inexistente: solo un cambio de color (o la
      // creamos recién ahora), nada de mostrar el texto sin que la abran.
      if (!obtenerConversacion(id)) await cargarConversaciones();
      if (!item) {
        const conv = obtenerConversacion(id);
        if (conv) {
          item = construirVentanaDom(conv);
          ventanas.set(id, item);
          aplicarLimiteVentanas(id);
        }
      }
      if (item) {
        item.el.classList.add("cf-nuevo");
        guardarEstado();
      }
    }

    cargarConversaciones();
  }

  function conectarSocket() {
    socket = io();
    socket.on("mensajeNuevo", manejarMensajeNuevoSocket);
    socket.on("conversacionNueva", () => cargarConversaciones());
  }

  // --- Arranque ---

  (async function iniciar() {
    const respuestaMe = await fetch("/api/auth/me");
    if (!respuestaMe.ok) return; // sin sesión: no mostramos nada
    const me = await respuestaMe.json();
    usuarioId = me.usuarioId;

    await cargarConversaciones();
    restaurarEstado();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") cargarConversaciones();
    });

    setInterval(cargarConversaciones, 5000);
    cargarClienteSocketIo(conectarSocket);
  })();
})();
