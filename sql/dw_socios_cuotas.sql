-- Base DW (local) — bloque "Socios / Cuotas Sociales".
-- Refleja las tablas reales que ya se cargan mensualmente desde el sistema
-- de origen (ver TableroDinamico.xlsm, pestañas "CARTERA SOCIOS" y
-- "CUOTAS SOCIALES"). idtiempo siempre es AAAAMM (ej: 202004).
-- idsucursal es fijo en toda la DW: 0 Casa Central, 1 Rafaela, 2 Humberto,
-- 3 Moisés Ville.

USE DW;
GO

IF OBJECT_ID('ftasociados', 'U') IS NULL
CREATE TABLE ftasociados (
    idtiempo    INT NOT NULL,
    idsucursal  TINYINT NOT NULL,
    cantidad    INT NOT NULL,
    altas       INT NOT NULL,
    bajas       INT NOT NULL,
    CONSTRAINT PK_ftasociados PRIMARY KEY (idtiempo, idsucursal)
);
GO

IF OBJECT_ID('ftcuotasoc', 'U') IS NULL
CREATE TABLE ftcuotasoc (
    idtiempo        INT NOT NULL,
    idsucursal      TINYINT NOT NULL,
    cantidad        INT NOT NULL,
    importe         DECIMAL(14,2) NOT NULL,
    socios          INT NOT NULL,
    cuotas_al_dia   INT NOT NULL,
    CONSTRAINT PK_ftcuotasoc PRIMARY KEY (idtiempo, idsucursal)
);
GO
