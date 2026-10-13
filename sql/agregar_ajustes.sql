-- Ajustes generales de la aplicación (valen para todos los usuarios), que
-- cambia un administrador desde Configuración. Por ahora: chat habilitado o no.
-- No modifica ninguna tabla existente. Idempotente.

IF OBJECT_ID('app_ajustes', 'U') IS NULL
CREATE TABLE app_ajustes (
    clave              NVARCHAR(50)  NOT NULL PRIMARY KEY,   -- ej. 'chat_activo'
    valor              NVARCHAR(200) NOT NULL,               -- ej. '1' / '0'
    modificado_por     INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
    fecha_modificacion DATETIME      NOT NULL DEFAULT GETDATE()
);
GO

-- El chat arranca apagado para todos.
IF NOT EXISTS (SELECT 1 FROM app_ajustes WHERE clave = 'chat_activo')
    INSERT INTO app_ajustes (clave, valor) VALUES ('chat_activo', '0');
GO
