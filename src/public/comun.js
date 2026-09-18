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

// --- Barra de chat flotante (avisa mensajes nuevos en cualquier página) ---
// Antes, si te llegaba un mensaje mientras estabas en Proyectos,
// Información, etc., no te enterabas hasta volver al chat. Como comun.js se
// carga en todas las páginas logueadas, sumar acá la carga de
// chat-flotante.js hace que la barra de chat (con sonido, cambio de título
// y ventanitas tipo "viejo Facebook") aparezca en cualquier pantalla. Solo
// chat.html queda afuera porque esa página YA ES el chat completo.
(function () {
  if (location.pathname === "/chat.html") return;
  const script = document.createElement("script");
  script.src = "/chat-flotante.js";
  document.body.appendChild(script);
})();
