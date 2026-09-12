-- Base DW (local) — bloques "Plazo Fijo" y "TMU / Tarjeta +Unión".
-- Ver TableroDinamico.xlsm, pestañas "PLAZO FIJO" y "USUARIO".

USE DW;
GO

-- Plazo Fijo: se ignoran tasa y moneda (moneda siempre ARS, tasa relativa
-- a cada colocación, no aporta al análisis agregado).
IF OBJECT_ID('ftpfijo', 'U') IS NULL
CREATE TABLE ftpfijo (
    idtiempo    INT NOT NULL,
    idsucursal  TINYINT NOT NULL,
    cantidad    INT NOT NULL,
    importe     DECIMAL(14,2) NOT NULL,
    dias        INT NOT NULL,
    tasa        DECIMAL(9,4) NULL,
    moneda      NVARCHAR(5) NULL,
    CONSTRAINT PK_ftpfijo PRIMARY KEY (idtiempo, idsucursal)
);
GO

-- TMU / Tarjeta +Unión: la tabla ft_usuarios ya existía cargada en la DW
-- con estas columnas reales (numeric, sin PK definida):
--   idtiempo, idsucursal, cantusuarios, cantusuconsumo, totalconsumo,
--   totalpago, canttitulares
-- Se hace hincapié en cantusuarios, cantusuconsumo, totalconsumo y
-- totalpago (canttitulares no se usa en la app). No hace falta crearla.
