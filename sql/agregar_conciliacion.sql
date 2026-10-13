-- Conciliación bancaria: tablas propias, todas con prefijo conc_.
-- No modifica ni borra ninguna tabla existente (las FK hacia app_usuarios
-- sólo agregan una referencia desde las tablas nuevas).
-- Idempotente: se puede correr más de una vez sin romper nada.

-- Las 7 cuentas. "codigo" es el mismo nombre que usa el motor (motor/lectores.py,
-- diccionario BANCOS) y el prefijo del PDF del mayor (COINAG092026.pdf).
IF OBJECT_ID('conc_bancos', 'U') IS NULL
BEGIN
    CREATE TABLE conc_bancos (
        codigo  NVARCHAR(20) NOT NULL PRIMARY KEY,
        nombre  NVARCHAR(60) NOT NULL,
        moneda  CHAR(3)      NOT NULL DEFAULT 'ARS',
        orden   INT          NOT NULL DEFAULT 0,
        activo  BIT          NOT NULL DEFAULT 1
    );

    INSERT INTO conc_bancos (codigo, nombre, moneda, orden) VALUES
        ('COINAG',     N'Coinag',           'ARS', 1),
        ('CREDICOOP',  N'Credicoop',        'ARS', 2),
        ('FRANCES',    N'Francés',          'ARS', 3),
        ('FRANCESUSD', N'Francés USD',      'USD', 4),
        ('NACION',     N'Nación',           'ARS', 5),
        ('SANTAFE',    N'Santa Fe (NBSF)',  'ARS', 6),
        ('RIO',        N'Santander (Río)',  'ARS', 7);
END
GO

-- Quién puede usar la conciliación (los admin pueden siempre) y quién puede
-- cerrar el mes. Reabrir un mes cerrado queda sólo para admin.
IF OBJECT_ID('conc_permisos', 'U') IS NULL
CREATE TABLE conc_permisos (
    usuario_id   INT      NOT NULL PRIMARY KEY FOREIGN KEY REFERENCES app_usuarios(id),
    puede_cerrar BIT      NOT NULL DEFAULT 0,
    fecha_alta   DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- Un período = un banco en un mes. Guarda el resultado de la última lectura.
-- estado: 'procesando' | 'con_error' | 'abierto' | 'cerrado'
IF OBJECT_ID('conc_periodos', 'U') IS NULL
CREATE TABLE conc_periodos (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    banco            NVARCHAR(20)  NOT NULL FOREIGN KEY REFERENCES conc_bancos(codigo),
    anio             SMALLINT      NOT NULL,
    mes              TINYINT       NOT NULL,
    estado           NVARCHAR(15)  NOT NULL,
    mensaje_error    NVARCHAR(1000) NULL,
    cuenta           NVARCHAR(200) NULL,
    saldo_ini_mayor  DECIMAL(18,2) NULL,
    saldo_fin_mayor  DECIMAL(18,2) NULL,
    saldo_ini_banco  DECIMAL(18,2) NULL,
    saldo_fin_banco  DECIMAL(18,2) NULL,
    hay_anterior     BIT           NOT NULL DEFAULT 0,
    cuadre_motor     NVARCHAR(MAX) NULL,  -- JSON del cuadre calculado por Python (control)
    valores_acreditar NVARCHAR(MAX) NULL, -- JSON informativo: depósitos aún no acreditados
    procesado_por    INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
    fecha_proceso    DATETIME      NULL,
    cerrado_por      INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
    fecha_cierre     DATETIME      NULL,
    CONSTRAINT UQ_conc_periodos UNIQUE (banco, anio, mes)
);
GO

-- Qué PDF se usaron en cada lectura (para auditoría: nombre, tamaño, hash).
-- tipo: 'mayor' | 'resumen' | 'resumen_anterior'
IF OBJECT_ID('conc_archivos', 'U') IS NULL
CREATE TABLE conc_archivos (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    periodo_id  INT            NOT NULL FOREIGN KEY REFERENCES conc_periodos(id),
    tipo        NVARCHAR(20)   NOT NULL,
    ruta        NVARCHAR(400)  NOT NULL,  -- relativa a la carpeta de bancos
    tamanio     BIGINT         NOT NULL,
    hash_sha256 CHAR(64)       NOT NULL,
    subido_por  INT            NULL FOREIGN KEY REFERENCES app_usuarios(id), -- NULL: ya estaba en la carpeta
    fecha       DATETIME       NOT NULL DEFAULT GETDATE()
);
GO

-- Cada renglón leído de los PDF.
-- lado: 'M' mayor | 'B' banco del mes | 'A' banco del mes anterior (sólo los que se usaron)
-- clave: fecha|importe|concepto|repetición, estable entre lecturas del mismo PDF.
IF OBJECT_ID('conc_movimientos', 'U') IS NULL
BEGIN
    CREATE TABLE conc_movimientos (
        id            INT IDENTITY(1,1) PRIMARY KEY,
        periodo_id    INT           NOT NULL FOREIGN KEY REFERENCES conc_periodos(id),
        lado          CHAR(1)       NOT NULL,
        clave         NVARCHAR(250) NOT NULL,
        orden         INT           NOT NULL,  -- orden en el PDF
        fecha         DATE          NOT NULL,
        concepto      NVARCHAR(300) NOT NULL,
        detalle       NVARCHAR(1000) NULL,
        comprob       NVARCHAR(50)  NULL,
        nro           NVARCHAR(30)  NULL,  -- nro de asiento (mayor)
        suc           NVARCHAR(10)  NULL,
        importe       DECIMAL(18,2) NOT NULL,  -- + entra plata, - sale
        saldo         DECIMAL(18,2) NULL,
        por_acreditar DECIMAL(18,2) NOT NULL DEFAULT 0,
        cuit          CHAR(11)      NULL,
        rubro_gasto   NVARCHAR(60)  NULL
    );
    CREATE UNIQUE INDEX UX_conc_movimientos_clave ON conc_movimientos(periodo_id, clave);
END
GO

-- Cruces entre movimientos (automáticos del motor o manuales).
-- estado: 'conciliado' | 'a_confirmar' | 'rechazado'. Deshacer no borra: marca deshecho.
IF OBJECT_ID('conc_cruces', 'U') IS NULL
BEGIN
    CREATE TABLE conc_cruces (
        id             INT IDENTITY(1,1) PRIMARY KEY,
        periodo_id     INT           NOT NULL FOREIGN KEY REFERENCES conc_periodos(id),
        numero         INT           NOT NULL,  -- nro de cruce dentro del período
        origen         NVARCHAR(10)  NOT NULL,  -- 'auto' | 'manual'
        regla          NVARCHAR(40)  NOT NULL,  -- 'Uno a uno', 'Depósito de valores', ...
        nota           NVARCHAR(400) NULL,
        estado         NVARCHAR(15)  NOT NULL,
        diferencia     DECIMAL(18,2) NOT NULL DEFAULT 0,  -- mayor - banco
        creado_por     INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
        fecha_creacion DATETIME      NOT NULL DEFAULT GETDATE(),
        resuelto_por   INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
        fecha_resuelto DATETIME      NULL,
        deshecho       BIT           NOT NULL DEFAULT 0,
        deshecho_por   INT           NULL FOREIGN KEY REFERENCES app_usuarios(id),
        fecha_deshecho DATETIME      NULL,
        CONSTRAINT UQ_conc_cruces_numero UNIQUE (periodo_id, numero)
    );

    CREATE TABLE conc_cruce_items (
        cruce_id      INT NOT NULL FOREIGN KEY REFERENCES conc_cruces(id),
        movimiento_id INT NOT NULL FOREIGN KEY REFERENCES conc_movimientos(id),
        PRIMARY KEY (cruce_id, movimiento_id)
    );
    CREATE INDEX IX_conc_cruce_items_mov ON conc_cruce_items(movimiento_id);
END
GO

-- Observaciones por movimiento (se agregan, no se pisan) y marca de revisado.
IF OBJECT_ID('conc_observaciones', 'U') IS NULL
CREATE TABLE conc_observaciones (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    movimiento_id INT            NOT NULL FOREIGN KEY REFERENCES conc_movimientos(id),
    texto         NVARCHAR(1000) NOT NULL,
    usuario_id    INT            NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    fecha         DATETIME       NOT NULL DEFAULT GETDATE()
);
GO

IF OBJECT_ID('conc_revisados', 'U') IS NULL
CREATE TABLE conc_revisados (
    movimiento_id INT      NOT NULL PRIMARY KEY FOREIGN KEY REFERENCES conc_movimientos(id),
    usuario_id    INT      NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    fecha         DATETIME NOT NULL DEFAULT GETDATE()
);
GO
