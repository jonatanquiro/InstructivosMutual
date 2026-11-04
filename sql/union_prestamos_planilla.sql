-- Control de préstamos (la planilla CONTROL PRÉSTAMOS.xlsx) pasado a tablas,
-- en la base UNION para que el sistema en Fox pueda cargar y leer lo mismo
-- que muestra la pestaña Control de Préstamos de INFORMAMUTUAL.
--
-- Nombres al estilo de UNION: prefijo PRPL (préstamos / planilla), columnas
-- en mayúsculas de hasta 10 letras. No modifica ninguna tabla existente; los
-- vendedores se toman de UNION.dbo.Usuarios (sin FK, igual que el resto de
-- la base). Idempotente: se puede correr más de una vez.
--
--   PRPLESTADO  estados posibles de una solicitud
--   PRPLMOTIVO  motivos de rechazo
--   PRPLANILLA  una fila por solicitud
--   PRPLSOLMOT  motivos de cada solicitud rechazada (puede tener varios)
--   PRPLVENALI  cómo se escribió el vendedor en la planilla -> Usuarios.id
--
-- PLSUCURSAL se agregó después (ALTER más abajo).
USE [UNION];
GO

IF OBJECT_ID('dbo.PRPLESTADO', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PRPLESTADO (
        ID         TINYINT     NOT NULL PRIMARY KEY,
        ESNOMBRE   VARCHAR(40) NOT NULL,
        ESCERRADO  BIT         NOT NULL,   -- 0 = todavía en curso
        ESORDEN    TINYINT     NOT NULL
    );
    INSERT INTO dbo.PRPLESTADO (ID, ESNOMBRE, ESCERRADO, ESORDEN) VALUES
        (1, 'Liquidado',             1, 1),
        (2, 'Aprobado sin liquidar', 0, 2),
        (3, 'Pide garantía',         0, 3),
        (4, 'Sin resolución',        0, 4),
        (5, 'No lo tomó',            1, 5),
        (6, 'Rechazado',             1, 6);
END
GO

IF OBJECT_ID('dbo.PRPLMOTIVO', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PRPLMOTIVO (
        ID        TINYINT     NOT NULL PRIMARY KEY,
        MONOMBRE  VARCHAR(60) NOT NULL
    );
    INSERT INTO dbo.PRPLMOTIVO (ID, MONOMBRE) VALUES
        (1, 'Rojo / informado en otras entidades'),
        (2, 'Mal historial de pago / antecedentes'),
        (3, 'Judiciales'),
        (4, 'Endeudamiento / relación cuota-ingreso'),
        (5, 'Tiene un préstamo vigente'),
        (6, 'Sin antigüedad'),
        (7, 'No es socio'),
        (8, 'TMU inhabilitada'),
        (9, 'Otro motivo'),
        (10, 'Sin motivo escrito');
END
GO

IF OBJECT_ID('dbo.PRPLANILLA', 'U') IS NULL
CREATE TABLE dbo.PRPLANILLA (
    ID          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    PLFECHA     DATE          NULL,      -- fecha de la solicitud
    PLANIO      SMALLINT      NOT NULL,  -- mes al que pertenece (la hoja de la planilla)
    PLMES       TINYINT       NOT NULL,
    PLSOCIO     VARCHAR(120)  NOT NULL,  -- nombre, como se cargó
    PLSONUME    BIGINT        NULL,      -- nº de socio (somaesgral.SONUME), si se conoce
    PLCONYUGE   VARCHAR(120)  NULL,
    PLGARANTE   VARCHAR(200)  NULL,
    PLIMPORTE   NUMERIC(15,2) NULL,
    PLPLAZO     SMALLINT      NULL,      -- en meses
    PLPLAZOTX   VARCHAR(20)   NULL,      -- cuando no son meses: "15 días"
    PLFECLIQ    DATE          NULL,      -- fecha de liquidación
    PLFORMAPAG  VARCHAR(100)  NULL,
    PLVENDEDOR  INT           NULL,      -- Usuarios.id (NULL si no se sabe quién es)
    PLVENDTXT   VARCHAR(40)   NULL,      -- vendedor tal como se escribió
    PLESTADO    TINYINT       NOT NULL FOREIGN KEY REFERENCES dbo.PRPLESTADO(ID),
    PLCOMENT    VARCHAR(1000) NULL,
    PLENVARCH   DATE          NULL,      -- enviado a archivo
    PLORIGEN    VARCHAR(5)    NOT NULL DEFAULT 'FOX',  -- 'EXCEL' = importado de la planilla
    PLHOJA      VARCHAR(30)   NULL,      -- sólo EXCEL: hoja y fila de donde salió
    PLFILA      INT           NULL,
    USUAPLIC    VARCHAR(20)   NULL,      -- quién la cargó
    FECALTA     DATETIME      NOT NULL DEFAULT GETDATE(),
    USUMODIF    VARCHAR(20)   NULL,      -- si se tocó después de cargada (desde Fox)
    ULTMODIF    DATETIME      NULL
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PRPLANILLA_PERIODO')
    CREATE INDEX IX_PRPLANILLA_PERIODO ON dbo.PRPLANILLA (PLANIO, PLMES);
GO

-- Sucursal que tomó la solicitud (oApp.sucursal en Fox): 0 Sunchales (Casa
-- Central), 1 Rafaela, 2 Humberto, 3 Moisés Ville. Lo importado de la
-- planilla de Excel es todo de Sunchales.
IF COL_LENGTH('dbo.PRPLANILLA', 'PLSUCURSAL') IS NULL
    ALTER TABLE dbo.PRPLANILLA ADD PLSUCURSAL SMALLINT NOT NULL
        CONSTRAINT DF_PRPLANILLA_PLSUCURSAL DEFAULT 0;
GO

IF OBJECT_ID('dbo.PRPLSOLMOT', 'U') IS NULL
CREATE TABLE dbo.PRPLSOLMOT (
    IDPLANILLA  INT     NOT NULL FOREIGN KEY REFERENCES dbo.PRPLANILLA(ID) ON DELETE CASCADE,
    IDMOTIVO    TINYINT NOT NULL FOREIGN KEY REFERENCES dbo.PRPLMOTIVO(ID),
    PRIMARY KEY (IDPLANILLA, IDMOTIVO)
);
GO

-- Apodos y variantes con que se escribe cada vendedor (en minúscula y sin
-- tildes). IDUSUARIO NULL = no se sabe quién es: queda el texto en PLVENDTXT.
-- Para asignarlo después: UPDATE PRPLVENALI SET IDUSUARIO = ... y volver a
-- subir la planilla (o UPDATE PRPLANILLA SET PLVENDEDOR = ... a mano).
IF OBJECT_ID('dbo.PRPLVENALI', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.PRPLVENALI (
        ALIAS      VARCHAR(40) NOT NULL PRIMARY KEY,
        IDUSUARIO  INT         NULL
    );
    INSERT INTO dbo.PRPLVENALI (ALIAS, IDUSUARIO)
    SELECT a.ALIAS, u.id
    FROM (VALUES
        ('adriana', 'ADRIANA'),
        ('alejandro', 'ALEJANDRO'),
        ('alfredo', 'ALFREDO'), ('negrucho', 'ALFREDO'),
        ('alicia', 'ALICIA'),
        ('andres', 'ANDRES'),
        ('cristian', 'CRISTIAN'), ('kitu', 'CRISTIAN'),
        ('florencia', 'FLORENCIA'),
        ('laura', 'LAURAA'),
        ('marisa', 'MARISA'),
        ('mirian', 'MIRIAN'), ('miriam', 'MIRIAN'), ('mili', 'MIRIAN'),
        ('nadia', 'NADIA'),
        ('nicolas', 'NICOLASP'),
        ('sandra', 'SANDRA'),
        ('sebastian', 'SEBASTIAN'),
        ('walter', 'WALTER'), ('wali', 'WALTER'), ('walli', 'WALTER'), ('waly', 'WALTER'),
        ('humberto', NULL),         -- ¿Sebastián o Gisela? sin confirmar
        ('refinanciacion', NULL)    -- no es un vendedor
    ) AS a (ALIAS, USUARIO)
    LEFT JOIN dbo.Usuarios u ON u.nombre = a.USUARIO AND u.usbaja IS NULL;
END
GO
