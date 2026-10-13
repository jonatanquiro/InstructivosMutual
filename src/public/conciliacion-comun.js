// Utilidades compartidas por las pantallas de conciliación bancaria
// (conciliacion.html y conciliacion-punteo.html).

const NOMBRES_MES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
  "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const formatoImporte = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function importe(valor) {
  return formatoImporte.format(Number(valor));
}

// "2026-09-01" → "01/09/2026"
function fechaCorta(iso) {
  return iso ? iso.split("-").reverse().join("/") : "";
}

// fetch + JSON con el mensaje de error del servidor como texto de la excepción.
async function pedirJson(url, opciones) {
  const respuesta = await fetch(url, opciones);
  if (respuesta.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Sesión vencida");
  }
  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) throw new Error(datos.error || "Error de servidor");
  return datos;
}

// Lados de un movimiento: M asiento del mayor, R asiento pendiente del mes
// anterior, B banco, Q banco pendiente del mes anterior, A resumen anterior.
const esMayor = (m) => m.lado === "M" || m.lado === "R";
const NOMBRE_LADO = { M: "Mayor", R: "Mayor (mes anterior)", B: "Banco", Q: "Banco (mes anterior)", A: "Resumen anterior" };

// Socio: el CUIT del detalle del banco está o no en la base de socios.
// Sin vueltas: si está, es socio (aunque tenga fecha de baja cargada).
function etiquetaSocio(m, datos) {
  if (esMayor(m) || !m.cuit || m.cuit === datos.cuitPropio || m.rubro_gasto || !datos.socios) return "";
  const registros = datos.socios[m.cuit];
  if (!registros) return `<span class="conc-socio conc-socio-no" title="CUIT ${m.cuit}">No figura como socio</span>`;
  return `<span class="conc-socio conc-socio-si" title="CUIT ${m.cuit}">Socio: ${esc(registros[0].nombre)}</span>`;
}

// Pregunta con botones propios (en vez de confirm() del navegador). Devuelve
// el "valor" del botón elegido. Usa el #modal que tiene cada pantalla.
function preguntar(texto, botones) {
  const modal = document.getElementById("modal");
  document.getElementById("modalTexto").textContent = texto;
  const contenedor = document.getElementById("modalBotones");
  contenedor.innerHTML = "";
  return new Promise((resolve) => {
    for (const b of botones) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.textContent = b.texto;
      if (b.secundario) boton.className = "secundario";
      boton.addEventListener("click", () => {
        modal.hidden = true;
        resolve(b.valor);
      });
      contenedor.appendChild(boton);
    }
    modal.hidden = false;
  });
}
