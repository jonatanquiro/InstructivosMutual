const crypto = require("crypto");

// Cifra el texto de los mensajes de chat antes de guardarlo, para que
// alguien que abra la base de datos directamente (SSMS, un backup, etc.)
// no pueda leerlo. El resto de las columnas (usuario, fecha, a qué
// conversación pertenece) quedan en claro a propósito: solo el contenido
// del mensaje es lo que se pidió mantener privado.
//
// CHAT_CLAVE_CIFRADO tiene que ser un string hex de 64 caracteres (32
// bytes). Generar uno nuevo con:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const ALGORITMO = "aes-256-gcm";
const claveHex = process.env.CHAT_CLAVE_CIFRADO;

if (!claveHex || claveHex.length !== 64) {
  throw new Error(
    "CHAT_CLAVE_CIFRADO falta o es inválida en .env: debe ser un hex de 64 caracteres (32 bytes)."
  );
}

const clave = Buffer.from(claveHex, "hex");

function cifrarTexto(texto) {
  if (texto === null || texto === undefined) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITMO, clave, iv);
  const cifrado = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, cifrado]).toString("base64");
}

function descifrarTexto(valorCifrado) {
  if (valorCifrado === null || valorCifrado === undefined) return null;

  try {
    const datos = Buffer.from(valorCifrado, "base64");
    const iv = datos.subarray(0, 12);
    const authTag = datos.subarray(12, 28);
    const cifrado = datos.subarray(28);

    const decipher = crypto.createDecipheriv(ALGORITMO, clave, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(cifrado), decipher.final()]).toString("utf8");
  } catch (error) {
    // Mensajes guardados antes de tener cifrado están en texto plano y no
    // van a poder desencriptarse (el chequeo de integridad de GCM va a
    // fallar). En vez de ocultarlos, asumimos que es texto plano viejo y lo
    // devolvemos tal cual: así no se pierden mensajes ya escritos.
    return valorCifrado;
  }
}

module.exports = { cifrarTexto, descifrarTexto };
