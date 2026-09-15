-- Ejecutar una sola vez en la base INFORMA para pasar el chat a guardar el
-- texto de los mensajes cifrado (AES-256-GCM, ver src/config/cifrado.js)
-- en vez de texto plano.
--
-- Los mensajes que ya existan en app_chat_mensajes quedan en texto plano
-- (son de antes de este cambio) y no se convierten retroactivamente. La
-- app los sigue mostrando igual: si no puede descifrar un valor, asume que
-- es texto plano viejo y lo muestra tal cual (ver descifrarTexto en
-- src/config/cifrado.js). Los mensajes nuevos sí quedan cifrados.

ALTER TABLE app_chat_mensajes ALTER COLUMN texto NVARCHAR(MAX) NULL;
GO
