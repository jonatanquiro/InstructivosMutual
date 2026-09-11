-- Ejecutar una sola vez en la base INFORMA para crear la tabla de
-- configuración personal por usuario (tema claro/oscuro por ahora).
IF OBJECT_ID('app_config_usuario', 'U') IS NULL
BEGIN
    CREATE TABLE app_config_usuario (
        usuario_id  INT PRIMARY KEY FOREIGN KEY REFERENCES app_usuarios(id),
        tema        NVARCHAR(10) NOT NULL DEFAULT 'claro'
    );
END
GO
