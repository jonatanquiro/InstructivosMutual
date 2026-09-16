// Cargado en todas las páginas ya logueadas: aplica el tema guardado,
// completa el saludo del header y engancha el botón de cerrar sesión.
// El tema se cachea en localStorage solo para evitar el flash de tema claro
// mientras se confirma el valor real contra el servidor (ver snippet inline
// en el <head> de cada página).

(async function confirmarTema() {
  try {
    const respuesta = await fetch("/api/config");
    if (!respuesta.ok) return;
    const { tema } = await respuesta.json();
    document.documentElement.setAttribute("data-theme", tema);
    localStorage.setItem("tema", tema);
  } catch (error) {
    // Sin conexión o sin sesión: se queda con lo que haya en localStorage.
  }
})();

document.addEventListener("DOMContentLoaded", () => {
  const btnSalir = document.getElementById("btnSalir");
  if (btnSalir) {
    btnSalir.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.href = "/login.html";
    });
  }

  const saludoEl = document.getElementById("saludo");
  if (saludoEl) {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((datos) => {
        if (!datos || !datos.nombreCompleto) return;
        saludoEl.innerHTML = "";
        if (datos.fotoUrl) {
          const avatar = document.createElement("img");
          avatar.src = datos.fotoUrl;
          avatar.alt = "";
          avatar.className = "saludo-avatar";
          saludoEl.appendChild(avatar);
        }
        saludoEl.appendChild(document.createTextNode(`Hola, ${datos.nombreCompleto}`));
      })
      .catch(() => {});
  }
});

// --- Aviso global de mensajes de chat sin leer ---
// Antes, si te llegaba un mensaje mientras estabas en Proyectos,
// Información, etc., no te enterabas hasta volver al menú principal o al
// chat (las únicas dos pantallas que revisaban no-leídos). Como comun.js
// se carga en todas las páginas logueadas, corriendo esto acá se entera
// en cualquier pantalla. chat.html y el menú principal quedan afuera
// porque ya muestran lo mismo con más detalle (lista de conversaciones /
// tarjeta de Chat), sumar esto ahí sería duplicar el aviso y el sonido.
(function () {
  const RUTAS_CON_AVISO_PROPIO = ["/chat.html", "/", "/index.html"];
  if (RUTAS_CON_AVISO_PROPIO.includes(location.pathname)) return;

  let noLeidosPrevio = 0;
  let primeraCarga = true;
  const tituloOriginal = document.title;
  let globo = null;

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

  function actualizarGlobo(total) {
    if (total === 0) {
      if (globo) globo.remove();
      globo = null;
      return;
    }
    if (!globo) {
      globo = document.createElement("a");
      globo.href = "/chat.html";
      globo.className = "globo-chat-flotante";
      document.body.appendChild(globo);
    }
    globo.textContent = `💬 ${total > 99 ? "99+" : total}`;
  }

  async function revisarNoLeidos() {
    try {
      const respuesta = await fetch("/api/chat/conversaciones");
      if (!respuesta.ok) return;
      const conversaciones = await respuesta.json();
      const total = conversaciones.reduce((suma, c) => suma + (c.no_leidos || 0), 0);

      document.title = total > 0 ? `${tituloOriginal} (${total > 99 ? "99+" : total})` : tituloOriginal;
      actualizarGlobo(total);

      // No avisamos en la primerísima carga: si ya tenías mensajes sin leer
      // de antes, no tiene sentido que suene apenas entrás a la página.
      if (!primeraCarga && total > noLeidosPrevio) reproducirBeep();
      noLeidosPrevio = total;
      primeraCarga = false;
    } catch (error) {
      // Sin conexión o sin sesión: no se muestra nada, se reintenta solo en
      // el próximo sondeo.
    }
  }

  // El cliente de socket.io solo está incluido de entrada en chat.html e
  // index.html; en el resto de las páginas se suma dinámicamente para no
  // tener que tocar el <head> de cada una a mano.
  function cargarClienteSocketIo(callback) {
    if (window.io) return callback();
    const script = document.createElement("script");
    script.src = "/socket.io/socket.io.js";
    script.onload = callback;
    document.head.appendChild(script);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revisarNoLeidos();
  });

  revisarNoLeidos();
  setInterval(revisarNoLeidos, 5000);
  cargarClienteSocketIo(() => {
    const socket = io();
    socket.on("mensajeNuevo", revisarNoLeidos);
    socket.on("conversacionNueva", revisarNoLeidos);
  });
})();
