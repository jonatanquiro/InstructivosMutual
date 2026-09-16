-- Ejecutar una sola vez en la base INFORMA. Suma edición/borrado individual
-- de mensajes y reacciones (estilo WhatsApp) al chat interno.

IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_chat_mensajes') AND name = 'editado'
)
BEGIN
    ALTER TABLE app_chat_mensajes ADD editado BIT NOT NULL DEFAULT 0;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_chat_mensajes') AND name = 'eliminado'
)
BEGIN
    ALTER TABLE app_chat_mensajes ADD eliminado BIT NOT NULL DEFAULT 0;
END
GO

-- Una reacción por usuario por mensaje (igual que WhatsApp: elegir otro
-- emoji reemplaza la reacción anterior en vez de sumar una nueva).
IF OBJECT_ID('app_chat_reacciones', 'U') IS NULL
BEGIN
    CREATE TABLE app_chat_reacciones (
        mensaje_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_mensajes(id),
        usuario_id INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
        emoji      NVARCHAR(20) NOT NULL,
        PRIMARY KEY (mensaje_id, usuario_id)
    );
END
GO
