-- Carga en Preguntas Frecuentes, módulo "Sistemas", la pregunta anidada
-- "Cambio de toner" → "¿Qué impresora tenés?" → una opción por impresora.
-- Requiere haber corrido antes agregar_preguntas_anidadas.sql.
-- Idempotente: si "Cambio de toner" ya existe en Sistemas, no hace nada.
-- Después se puede seguir editando todo desde Administrar Preguntas Frecuentes.
SET NOCOUNT ON;

DECLARE @moduloId INT = (SELECT TOP 1 id FROM app_modulos WHERE nombre = N'Sistemas');
IF @moduloId IS NULL
BEGIN
    RAISERROR(N'No existe el módulo "Sistemas" en app_modulos.', 16, 1);
    RETURN;
END

IF EXISTS (SELECT 1 FROM app_preguntas WHERE modulo_id = @moduloId AND padre_id IS NULL AND pregunta = N'Cambio de toner')
BEGIN
    PRINT N'"Cambio de toner" ya estaba cargada, no se hizo nada.';
    RETURN;
END

DECLARE @padreId INT;
INSERT INTO app_preguntas (modulo_id, pregunta, respuesta, activo)
VALUES (@moduloId, N'Cambio de toner',
        N'¿Qué impresora tenés? El modelo está escrito en el frente de la impresora.', 1);
SET @padreId = SCOPE_IDENTITY();

INSERT INTO app_preguntas (modulo_id, padre_id, pregunta, respuesta, activo) VALUES
(@moduloId, @padreId, N'Brother HL-1212W',
 N'Le va el toner Brother TN-1060.

Si la impresora avisa que hay que cambiar el tambor (drum), es el DR-1060.

Si no hay uno de repuesto, avisá a Sistemas.', 1),

(@moduloId, @padreId, N'HP',
 N'Las HP usan uno de estos dos toners, según el modelo:

• HP 48A (CF248A): LaserJet Pro M15 / M28 (las más chiquitas).
• HP 85A (CE285A): LaserJet P1102 / M1132 / M1212.

Si no sabés el modelo, abrí la tapa y fijate el código que dice el cartucho puesto.

Si no hay uno de repuesto, avisá a Sistemas.', 1),

(@moduloId, @padreId, N'Samsung M4020',
 N'Le va el toner Samsung MLT-D203L.

Si no hay uno de repuesto, avisá a Sistemas.', 1),

(@moduloId, @padreId, N'Brother 5100',
 N'Le va el toner Brother TN-3472 (alto rendimiento) o TN-3442 (rendimiento estándar).

Si la impresora avisa que hay que cambiar el tambor (drum), es el DR-3440.

Si no hay uno de repuesto, avisá a Sistemas.', 1),

(@moduloId, @padreId, N'Brother 5650',
 N'Le va el toner Brother TN-3472 (alto rendimiento) o TN-3442 (rendimiento estándar).

Si la impresora avisa que hay que cambiar el tambor (drum), es el DR-3440.

Si no hay uno de repuesto, avisá a Sistemas.', 1);

PRINT N'Listo: "Cambio de toner" cargada con 5 opciones.';
GO
