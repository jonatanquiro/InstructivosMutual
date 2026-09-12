-- Índices para el nuevo panel de estadísticas de preguntas frecuentes
-- (top de preguntas consultadas, consultas por módulo, consultas en los
-- últimos 30 días). No cambia estructura de tablas, solo agrega índices
-- para que esas consultas agregadas no escaneen toda app_consultas_log.

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_app_consultas_log_pregunta_id' AND object_id = OBJECT_ID('app_consultas_log')
)
CREATE INDEX IX_app_consultas_log_pregunta_id ON app_consultas_log (pregunta_id);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_app_consultas_log_fecha' AND object_id = OBJECT_ID('app_consultas_log')
)
CREATE INDEX IX_app_consultas_log_fecha ON app_consultas_log (fecha);
GO
