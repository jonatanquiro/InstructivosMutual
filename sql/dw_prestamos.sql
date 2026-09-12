-- Base DW (local) — bloque "Ayudas Económicas / Préstamos".
-- Refleja ftprestamos tal como se carga mensualmente desde el sistema de
-- origen (ver TableroDinamico.xlsm, pestaña "PRESTAMOS"). idtiempo es
-- AAAAMM. Cada fila ya viene agrupada por cuotas + tipo (no es un préstamo
-- individual, es la agregación de ese mes/sucursal/cuotas/tipo).
-- tasaprom no se usa en la app por ahora, pero se guarda por si hace falta.

USE DW;
GO

IF OBJECT_ID('ftprestamos', 'U') IS NULL
CREATE TABLE ftprestamos (
    idtiempo    INT NOT NULL,
    idsucursal  TINYINT NOT NULL,
    cuotas      INT NOT NULL,
    tipo        NVARCHAR(10) NOT NULL,
    cantidad    INT NOT NULL,
    importe     DECIMAL(14,2) NOT NULL,
    tasaprom    DECIMAL(9,4) NULL,
    CONSTRAINT PK_ftprestamos PRIMARY KEY (idtiempo, idsucursal, cuotas, tipo)
);
GO
