-- Instructivos Mutual — esquema simplificado (preguntas frecuentes por módulo)
-- Reemplaza el esquema anterior pensado para RAG (app_documentos, app_chunks,
-- app_preguntas_frecuentes). app_usuarios se deja intacta, se sigue usando para login.

IF OBJECT_ID('app_preguntas_frecuentes', 'U') IS NOT NULL DROP TABLE app_preguntas_frecuentes;
IF OBJECT_ID('app_chunks', 'U') IS NOT NULL DROP TABLE app_chunks;
IF OBJECT_ID('app_documentos', 'U') IS NOT NULL DROP TABLE app_documentos;
IF OBJECT_ID('app_consultas_log', 'U') IS NOT NULL DROP TABLE app_consultas_log;
GO

-- Módulos: las "categorías" del menú (Caja de Ahorro, Ayuda Económica, etc.)
CREATE TABLE app_modulos (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    nombre        NVARCHAR(100) NOT NULL,
    orden         INT NOT NULL DEFAULT 0,
    activo        BIT NOT NULL DEFAULT 1
);
GO

-- Preguntas frecuentes: cada una pertenece a un módulo y ya trae su respuesta
-- escrita (texto plano o con saltos de línea; se puede ampliar a HTML simple
-- más adelante si hace falta formato o imágenes).
CREATE TABLE app_preguntas (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    modulo_id     INT NOT NULL FOREIGN KEY REFERENCES app_modulos(id),
    pregunta      NVARCHAR(300) NOT NULL,
    respuesta     NVARCHAR(MAX) NOT NULL,
    orden         INT NOT NULL DEFAULT 0,
    activo        BIT NOT NULL DEFAULT 1,
    fecha_creacion DATETIME NOT NULL DEFAULT GETDATE()
);
GO

-- Configuración personal por usuario (por ahora, tema claro/oscuro). Pensada
-- para ir sumando más preferencias más adelante sin tocar app_usuarios.
IF OBJECT_ID('app_config_usuario', 'U') IS NOT NULL DROP TABLE app_config_usuario;
GO

CREATE TABLE app_config_usuario (
    usuario_id  INT PRIMARY KEY FOREIGN KEY REFERENCES app_usuarios(id),
    tema        NVARCHAR(10) NOT NULL DEFAULT 'claro' -- 'claro' | 'oscuro'
);
GO

-- Cumpleaños de directivos, cargados manualmente (o reimportados) desde la
-- base UNION (tabla somaesgral). Se guardan acá para no depender de una
-- conexión cruzada UNION↔INFORMA en tiempo real.
IF OBJECT_ID('app_cumpleanios', 'U') IS NOT NULL DROP TABLE app_cumpleanios;
GO

CREATE TABLE app_cumpleanios (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    nombre            NVARCHAR(150) NOT NULL,
    fecha_nacimiento  DATE NOT NULL
);
GO

-- Log simple de qué pregunta consultó cada usuario y cuándo.
-- Sirve como base para el futuro dashboard de estadísticas (preguntas más
-- consultadas, uso por módulo, etc.) que se suma más adelante.
CREATE TABLE app_consultas_log (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    usuario_id    INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    pregunta_id   INT NOT NULL FOREIGN KEY REFERENCES app_preguntas(id),
    fecha         DATETIME NOT NULL DEFAULT GETDATE()
);
GO
