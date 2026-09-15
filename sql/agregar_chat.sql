-- Ejecutar una sola vez en la base INFORMA para crear las tablas del chat
-- interno (canal grupal "General" + conversaciones privadas 1 a 1, con
-- adjuntos de imagen). Los mensajes se purgan solos a las 48hs desde el
-- job de limpieza del servidor (src/jobs/limpieza-chat.js), así que estas
-- tablas se mantienen chicas.

IF OBJECT_ID('app_chat_mensajes', 'U') IS NULL
BEGIN
    CREATE TABLE app_chat_conversaciones (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        tipo           NVARCHAR(10) NOT NULL,   -- 'grupal' | 'privada'
        nombre         NVARCHAR(150) NULL,      -- solo para 'grupal'
        fecha_creacion DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE TABLE app_chat_participantes (
        conversacion_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
        usuario_id      INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
        PRIMARY KEY (conversacion_id, usuario_id)
    );
    -- Solo se usan filas acá para conversaciones 'privada'. La 'grupal' es
    -- implícita: cualquier usuario logueado puede leer/escribir en ella.

    CREATE TABLE app_chat_mensajes (
        id              INT IDENTITY(1,1) PRIMARY KEY,
        conversacion_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
        usuario_id      INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
        texto           NVARCHAR(2000) NULL,
        imagen_archivo  NVARCHAR(300) NULL,   -- nombre de archivo en /uploads/chat
        fecha           DATETIME NOT NULL DEFAULT GETDATE()
    );

    CREATE INDEX IX_chat_mensajes_conversacion ON app_chat_mensajes(conversacion_id, fecha);

    INSERT INTO app_chat_conversaciones (tipo, nombre) VALUES ('grupal', 'General');
END
GO
