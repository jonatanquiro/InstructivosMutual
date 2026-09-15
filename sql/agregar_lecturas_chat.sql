-- Ejecutar una sola vez en la base INFORMA. Agrega la tabla que trackea
-- hasta qué mensaje leyó cada usuario en cada conversación del chat, base
-- para el badge de no-leídos y el "visto" estilo WhatsApp.

IF OBJECT_ID('app_chat_lecturas', 'U') IS NULL
BEGIN
    CREATE TABLE app_chat_lecturas (
        conversacion_id   INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
        usuario_id        INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
        ultimo_mensaje_id INT NOT NULL DEFAULT 0,
        PRIMARY KEY (conversacion_id, usuario_id)
    );
END
GO
