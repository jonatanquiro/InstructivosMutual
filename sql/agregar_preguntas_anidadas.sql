-- Ejecutar una sola vez en la base INFORMA para permitir preguntas anidadas
-- en Preguntas Frecuentes (ej: "Cambio de toner" → "¿Qué impresora tenés?" →
-- una opción por impresora). Una pregunta con padre_id es una OPCIÓN de su
-- pregunta padre; la respuesta del padre se muestra como la sub-pregunta.
-- Idempotente: si ya corriste schema.sql actualizado, no hace nada.
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('app_preguntas') AND name = 'padre_id')
    ALTER TABLE app_preguntas ADD padre_id INT NULL FOREIGN KEY REFERENCES app_preguntas(id);
GO
