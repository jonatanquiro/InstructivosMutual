// Genera el INSERT SQL para crear un usuario, con la contraseña ya hasheada.
// No se conecta a la base — solo imprime el SQL para que lo corras vos en
// SSMS (útil justamente porque desde acá no hay conexión a la base real).
//
// Uso: node scripts/generar-usuario.js <nombre_usuario> <password> "<Nombre Completo>" [rol]
// Ej:  node scripts/generar-usuario.js jbarrionuevo "miClaveSegura123" "Jonathan Barrionuevo" admin

const bcrypt = require("bcrypt");

async function main() {
  const [nombreUsuario, password, nombreCompleto, rol] = process.argv.slice(2);

  if (!nombreUsuario || !password || !nombreCompleto) {
    console.error('Uso: node generar-usuario.js <usuario> <password> "<Nombre Completo>" [rol]');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const rolFinal = rol || "usuario";

  console.log("\n-- Copiá y ejecutá esto en SSMS:\n");
  console.log(
    `INSERT INTO app_usuarios (nombre_usuario, nombre_completo, password_hash, rol, activo)\n` +
      `VALUES (N'${nombreUsuario}', N'${nombreCompleto}', N'${hash}', N'${rolFinal}', 1);`
  );
  console.log("");
}

main();
