// Carga inicial de app_usuarios / app_config_usuario a partir de la tabla
// USUARIOS de la base UNION (mismo server que INFORMA). Es de UNA SOLA VEZ:
// crea las cuentas que todavía no existen y completa datos de perfil de las
// que ya existen, sin pisar nada que la persona ya haya cargado a mano.
//
// Solo LEE de [UNION].dbo.USUARIOS. Nunca escribe ahí ni toca la contraseña
// original (pasword) en esa tabla: la contraseña se hashea acá (bcrypt) y el
// hash se guarda únicamente en app_usuarios.password_hash.
//
// Por defecto corre en modo "dry run" (no escribe nada, solo muestra qué
// haría). Para aplicar los cambios de verdad:
//
//   node scripts/importar-usuarios-union.js --aplicar
//
// Reglas:
// - Solo se importan cuentas ACTIVAS en UNION (usbaja IS NULL). Las dadas de
//   baja se ignoran por completo, no se crean ni se cuentan.
// - Usuario nuevo (nombre_usuario no existe todavía en app_usuarios):
//   se crea con rol "usuario", activo = 1, y
//   password_hash = bcrypt(UNION.pasword).
// - Usuario que ya existe: NO se toca app_usuarios (ni password, ni rol, ni
//   activo). Solo se completan en app_config_usuario los campos que estén
//   vacíos (telefono, email, fecha_nacimiento); si ya tienen un valor
//   cargado, se dejan como están.
// - Si en UNION hay dos filas con el mismo nombre de usuario (pasa con
//   "CAROLINA"), se usa la de id más alto (la más reciente) y se avisa por
//   consola cuál se descartó.
// - Si en UNION la contraseña está vacía, no se puede loguear con ella, así
//   que esa cuenta se salta (se lista al final para crearla a mano después
//   con scripts/generar-usuario.js si corresponde).

require("dotenv").config();
const bcrypt = require("bcrypt");
const { sql, getPool } = require("../src/config/db");

const APLICAR = process.argv.includes("--aplicar");
const ROL_POR_DEFECTO = "usuario";

function limpiar(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === "" ? null : texto;
}

function dedupePorNombre(filas) {
  const porNombre = new Map();
  const duplicados = [];

  for (const fila of filas) {
    const clave = fila.nombre.trim().toLowerCase();
    const anterior = porNombre.get(clave);
    if (!anterior) {
      porNombre.set(clave, fila);
      continue;
    }
    const ganador = fila.id > anterior.id ? fila : anterior;
    const perdedor = ganador === fila ? anterior : fila;
    duplicados.push({ nombre: clave, idUsado: ganador.id, idDescartado: perdedor.id });
    porNombre.set(clave, ganador);
  }

  return { filas: [...porNombre.values()], duplicados };
}

async function main() {
  const pool = await getPool();

  const union = await pool.request().query(`
    SELECT id, nombre, pasword, nombrecomp, nacim, mailaboral, telefono, usbaja
    FROM [UNION].dbo.USUARIOS
    WHERE usbaja IS NULL
    ORDER BY id
  `);
  const { filas, duplicados } = dedupePorNombre(union.recordset);

  const existentes = await pool.request().query(`SELECT id, nombre_usuario FROM app_usuarios`);
  const idPorUsuario = new Map(existentes.recordset.map((u) => [u.nombre_usuario.toLowerCase(), u.id]));

  const config = await pool.request().query(`
    SELECT usuario_id, telefono, email, fecha_nacimiento FROM app_config_usuario
  `);
  const configPorUsuarioId = new Map(config.recordset.map((c) => [c.usuario_id, c]));

  const resumen = { creados: [], configCompletada: [], sinCambios: [], sinPassword: [] };

  for (const fila of filas) {
    const nombreUsuario = fila.nombre.trim().toLowerCase();
    const telefono = limpiar(fila.telefono);
    const email = limpiar(fila.mailaboral);
    const fechaNacimiento = fila.nacim;
    const idExistente = idPorUsuario.get(nombreUsuario);

    if (idExistente) {
      const configActual = configPorUsuarioId.get(idExistente);
      const cambios = {};

      if (!configActual) {
        if (telefono !== null) cambios.telefono = telefono;
        if (email !== null) cambios.email = email;
        if (fechaNacimiento !== null) cambios.fecha_nacimiento = fechaNacimiento;
      } else {
        if (configActual.telefono === null && telefono !== null) cambios.telefono = telefono;
        if (configActual.email === null && email !== null) cambios.email = email;
        if (configActual.fecha_nacimiento === null && fechaNacimiento !== null) {
          cambios.fecha_nacimiento = fechaNacimiento;
        }
      }

      if (Object.keys(cambios).length === 0) {
        resumen.sinCambios.push(nombreUsuario);
        continue;
      }

      resumen.configCompletada.push({ nombreUsuario, cambios, esNueva: !configActual });

      if (APLICAR) {
        if (!configActual) {
          await pool
            .request()
            .input("usuarioId", sql.Int, idExistente)
            .input("telefono", sql.NVarChar, cambios.telefono ?? null)
            .input("email", sql.NVarChar, cambios.email ?? null)
            .input("fechaNacimiento", sql.Date, cambios.fecha_nacimiento ?? null)
            .query(`
              INSERT INTO app_config_usuario (usuario_id, telefono, email, fecha_nacimiento)
              VALUES (@usuarioId, @telefono, @email, @fechaNacimiento)
            `);
        } else {
          const request = pool.request().input("usuarioId", sql.Int, idExistente);
          const sets = Object.keys(cambios).map((campo) => {
            request.input(campo, cambios[campo]);
            return `${campo} = @${campo}`;
          });
          await request.query(`UPDATE app_config_usuario SET ${sets.join(", ")} WHERE usuario_id = @usuarioId`);
        }
      }
      continue;
    }

    const pasword = limpiar(fila.pasword);
    if (!pasword) {
      resumen.sinPassword.push(nombreUsuario);
      continue;
    }

    const nombreCompleto = limpiar(fila.nombrecomp) || fila.nombre.trim();
    const activo = true;

    resumen.creados.push({ nombreUsuario, nombreCompleto, activo, telefono, email, fechaNacimiento });

    if (APLICAR) {
      const hash = await bcrypt.hash(pasword, 10);
      const insertado = await pool
        .request()
        .input("nombreUsuario", sql.VarChar, nombreUsuario)
        .input("nombreCompleto", sql.NVarChar, nombreCompleto)
        .input("hash", sql.VarChar, hash)
        .input("rol", sql.VarChar, ROL_POR_DEFECTO)
        .input("activo", sql.Bit, activo)
        .query(`
          INSERT INTO app_usuarios (nombre_usuario, nombre_completo, password_hash, rol, activo)
          OUTPUT INSERTED.id
          VALUES (@nombreUsuario, @nombreCompleto, @hash, @rol, @activo)
        `);
      const nuevoId = insertado.recordset[0].id;

      await pool
        .request()
        .input("usuarioId", sql.Int, nuevoId)
        .input("telefono", sql.NVarChar, telefono)
        .input("email", sql.NVarChar, email)
        .input("fechaNacimiento", sql.Date, fechaNacimiento)
        .query(`
          INSERT INTO app_config_usuario (usuario_id, telefono, email, fecha_nacimiento)
          VALUES (@usuarioId, @telefono, @email, @fechaNacimiento)
        `);
    }
  }

  console.log(`Modo: ${APLICAR ? "APLICANDO CAMBIOS" : "dry run (no se escribió nada, usá --aplicar para confirmar)"}\n`);

  if (duplicados.length > 0) {
    console.log(`Usuarios duplicados en UNION (se usó el id más reciente):`);
    for (const d of duplicados) {
      console.log(`  ${d.nombre}: se usa id ${d.idUsado}, se descarta id ${d.idDescartado}`);
    }
    console.log("");
  }

  console.log(`Cuentas nuevas a crear (${resumen.creados.length}):`);
  for (const u of resumen.creados) {
    console.log(`  ${u.nombreUsuario} — ${u.nombreCompleto} — activo=${u.activo}`);
  }

  console.log(`\nCuentas existentes con datos de perfil a completar (${resumen.configCompletada.length}):`);
  for (const u of resumen.configCompletada) {
    console.log(`  ${u.nombreUsuario}: ${JSON.stringify(u.cambios)}`);
  }

  console.log(`\nCuentas existentes sin cambios (ya tenían todo cargado o UNION no aporta nada nuevo): ${resumen.sinCambios.length}`);

  if (resumen.sinPassword.length > 0) {
    console.log(`\nUsuarios de UNION SIN contraseña cargada (no se crean, hacelo a mano con generar-usuario.js si hace falta):`);
    for (const u of resumen.sinPassword) console.log(`  ${u}`);
  }

  await sql.close();
}

main().catch((err) => {
  console.error("Error importando usuarios:", err);
  process.exit(1);
});
