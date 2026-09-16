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

-- Configuración personal por usuario (tema + datos de perfil). Pensada para
-- ir sumando más preferencias más adelante sin tocar app_usuarios.
IF OBJECT_ID('app_config_usuario', 'U') IS NOT NULL DROP TABLE app_config_usuario;
GO

CREATE TABLE app_config_usuario (
    usuario_id       INT PRIMARY KEY FOREIGN KEY REFERENCES app_usuarios(id),
    tema             NVARCHAR(10) NOT NULL DEFAULT 'claro', -- 'claro' | 'oscuro'
    telefono         NVARCHAR(30) NULL,
    email            NVARCHAR(150) NULL,
    fecha_nacimiento DATE NULL,
    foto_archivo     NVARCHAR(100) NULL -- nombre de archivo en src/uploads/perfiles
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

-- Chat interno: canal grupal "General" + conversaciones privadas 1 a 1,
-- con adjuntos de imagen. El texto de cada mensaje se guarda cifrado
-- (src/config/cifrado.js, AES-256-GCM) para que no quede legible desde la
-- base directamente; por eso es NVARCHAR(MAX) y no un largo fijo. No hay
-- borrado automático: cada conversación se borra a mano desde el chat.
IF OBJECT_ID('app_chat_mensajes', 'U') IS NOT NULL DROP TABLE app_chat_mensajes;
IF OBJECT_ID('app_chat_participantes', 'U') IS NOT NULL DROP TABLE app_chat_participantes;
IF OBJECT_ID('app_chat_conversaciones', 'U') IS NOT NULL DROP TABLE app_chat_conversaciones;
GO

CREATE TABLE app_chat_conversaciones (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    tipo           NVARCHAR(10) NOT NULL,   -- 'grupal' | 'privada'
    nombre         NVARCHAR(150) NULL,      -- solo para 'grupal'
    fecha_creacion DATETIME NOT NULL DEFAULT GETDATE()
);
GO

CREATE TABLE app_chat_participantes (
    conversacion_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
    usuario_id      INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    PRIMARY KEY (conversacion_id, usuario_id)
);
GO

CREATE TABLE app_chat_mensajes (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    conversacion_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
    usuario_id      INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    texto           NVARCHAR(MAX) NULL,  -- cifrado (base64), no texto plano
    imagen_archivo  NVARCHAR(300) NULL,
    fecha           DATETIME NOT NULL DEFAULT GETDATE(),
    editado         BIT NOT NULL DEFAULT 0,
    eliminado       BIT NOT NULL DEFAULT 0
);
CREATE INDEX IX_chat_mensajes_conversacion ON app_chat_mensajes(conversacion_id, fecha);
GO

-- Una reacción por usuario por mensaje (elegir otro emoji reemplaza la
-- reacción anterior, igual que WhatsApp).
IF OBJECT_ID('app_chat_reacciones', 'U') IS NOT NULL DROP TABLE app_chat_reacciones;
GO

CREATE TABLE app_chat_reacciones (
    mensaje_id INT NOT NULL FOREIGN KEY REFERENCES app_chat_mensajes(id),
    usuario_id INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    emoji      NVARCHAR(20) NOT NULL,
    PRIMARY KEY (mensaje_id, usuario_id)
);
GO

-- Hasta qué mensaje leyó cada usuario en cada conversación (badge de no
-- leídos + "visto" estilo WhatsApp en los DMs y grupos).
CREATE TABLE app_chat_lecturas (
    conversacion_id   INT NOT NULL FOREIGN KEY REFERENCES app_chat_conversaciones(id),
    usuario_id        INT NOT NULL FOREIGN KEY REFERENCES app_usuarios(id),
    ultimo_mensaje_id INT NOT NULL DEFAULT 0,
    PRIMARY KEY (conversacion_id, usuario_id)
);
GO

INSERT INTO app_chat_conversaciones (tipo, nombre) VALUES ('grupal', 'General');
GO
