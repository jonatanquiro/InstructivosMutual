const path = require("path");
const { spawn } = require("child_process");

// Motor de conciliación en Python (motor/procesar.py): lee los PDF y cruza.
// Node lo ejecuta como un proceso aparte y recibe el resultado en JSON por
// la salida estándar. PYTHON_PATH permite apuntar a un python.exe puntual en
// el servidor si "python" no está en el PATH del usuario que corre Node.
const RAIZ = path.join(__dirname, "..", "..");
const SCRIPT = path.join(RAIZ, "motor", "procesar.py");
const PYTHON = process.env.PYTHON_PATH || "python";

// Carpeta con los PDF (MAYOR/ y "RSM <BANCO>/"). Relativa a la raíz del
// proyecto o absoluta (por ejemplo una unidad de red).
const CARPETA_CONFIGURADA = process.env.CONC_CARPETA_BANCOS || "docs/Bancos";
const CARPETA_BANCOS = path.isAbsolute(CARPETA_CONFIGURADA)
  ? CARPETA_CONFIGURADA
  : path.join(RAIZ, CARPETA_CONFIGURADA);

// "delServidor": el problema no es el PDF sino la instalación (falta Python o
// alguna librería). Quien llama lo usa para no decirle a la contadora que
// revise el archivo cuando no tiene nada que ver.
class ErrorMotor extends Error {
  constructor(mensaje, delServidor = false) {
    super(mensaje);
    this.delServidor = delServidor;
  }
}

const COMO_ARREGLAR = "En el servidor, corré actualizar-servidor.bat (instala lo que falta) y reiniciá el servidor.";

// Python terminó mal: se mira lo que escribió para decir qué pasó de verdad.
function errorSegunSalida(codigo, errores) {
  const texto = String(errores || "");
  const modulo = /No module named '?([\w.]+)'?/.exec(texto);
  if (modulo) {
    return new ErrorMotor(`Al servidor le falta la librería de Python «${modulo[1]}», que se usa para leer los PDF. ${COMO_ARREGLAR}`, true);
  }
  // 9009 = "no se reconoce como un comando"; el otro texto es el aviso del
  // acceso directo de la Tienda de Windows cuando Python no está instalado.
  if (codigo === 9009 || /Python was not found|no se encontr[oó] Python|Microsoft Store/i.test(texto)) {
    return new ErrorMotor("Python no está instalado en el servidor (o no está en el PATH), y hace falta para leer los PDF. " +
      "Instalalo desde python.org tildando «Add python.exe to PATH». " + COMO_ARREGLAR, true);
  }
  const ultima = texto.trim().split(/\r?\n/).pop() || "";
  return new ErrorMotor("El PDF no se pudo leer (no tiene el formato esperado)." +
    (ultima ? ` Detalle técnico: ${ultima.slice(0, 200)}` : ""));
}

// Corre "python procesar.py <accion> --clave valor ..." y devuelve el JSON.
// Si el lector detecta que la lectura no cierra, el JSON trae ok:false con el
// mensaje para mostrar; eso NO es una excepción acá, lo decide quien llama.
function ejecutarMotor(accion, opciones, timeoutMs = 5 * 60 * 1000) {
  const args = [SCRIPT, accion];
  for (const [clave, valor] of Object.entries(opciones)) {
    if (valor !== undefined && valor !== null) args.push(`--${clave}`, String(valor));
  }

  return new Promise((resolve, reject) => {
    const proceso = spawn(PYTHON, args, { cwd: path.dirname(SCRIPT), windowsHide: true });
    let salida = "";
    let errores = "";
    const reloj = setTimeout(() => {
      proceso.kill();
      reject(new ErrorMotor("La lectura tardó demasiado y se cortó."));
    }, timeoutMs);

    proceso.stdout.on("data", (d) => (salida += d));
    proceso.stderr.on("data", (d) => (errores += d));
    proceso.on("error", (error) => {
      clearTimeout(reloj);
      console.error("No se pudo ejecutar Python:", error);
      reject(new ErrorMotor("No se pudo ejecutar Python en el servidor, y hace falta para leer los PDF. Instalalo desde " +
        "python.org tildando «Add python.exe to PATH» (o indicá dónde está con PYTHON_PATH en el .env). " + COMO_ARREGLAR, true));
    });
    proceso.on("close", (codigo) => {
      clearTimeout(reloj);
      if (codigo !== 0) {
        console.error(`Motor de conciliación terminó con código ${codigo}:\n${errores}`);
        return reject(errorSegunSalida(codigo, errores));
      }
      try {
        resolve(JSON.parse(salida));
      } catch (error) {
        console.error("Respuesta inválida del motor:", salida.slice(0, 500), errores);
        reject(new ErrorMotor("El lector de PDF devolvió una respuesta inválida."));
      }
    });
  });
}

module.exports = { ejecutarMotor, ErrorMotor, CARPETA_BANCOS };
