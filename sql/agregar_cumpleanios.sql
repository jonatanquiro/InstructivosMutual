-- Ejecutar una sola vez en la base INFORMA para crear la tabla de cumpleaños.
-- (sql/schema.sql ya quedó actualizado con esta tabla para el caso de un
-- setup nuevo desde cero, pero como la base ya existe con datos cargados,
-- no conviene volver a correr todo schema.sql — alcanza con este script.)

IF OBJECT_ID('app_cumpleanios', 'U') IS NULL
BEGIN
    CREATE TABLE app_cumpleanios (
        id                INT IDENTITY(1,1) PRIMARY KEY,
        nombre            NVARCHAR(150) NOT NULL,
        fecha_nacimiento  DATE NOT NULL
    );
END
GO
