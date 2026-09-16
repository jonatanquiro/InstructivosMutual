-- Ejecutar una sola vez en la base INFORMA para sumar los campos de perfil
-- (teléfono, email, fecha de nacimiento, foto) a app_config_usuario, que
-- hasta ahora solo tenía el tema claro/oscuro. Idempotente: si ya corriste
-- schema.sql actualizado, estas columnas ya existen y esto no hace nada.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_config_usuario') AND name = 'telefono')
    ALTER TABLE app_config_usuario ADD telefono NVARCHAR(30) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_config_usuario') AND name = 'email')
    ALTER TABLE app_config_usuario ADD email NVARCHAR(150) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_config_usuario') AND name = 'fecha_nacimiento')
    ALTER TABLE app_config_usuario ADD fecha_nacimiento DATE NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_config_usuario') AND name = 'foto_archivo')
    ALTER TABLE app_config_usuario ADD foto_archivo NVARCHAR(100) NULL;
GO
