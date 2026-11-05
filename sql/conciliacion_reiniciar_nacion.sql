-- Conciliación: deja visible sólo el Nación y borra sus períodos para
-- cargarlo de cero. Los demás bancos quedan ocultos (activo = 0) con sus
-- datos guardados; para volver a mostrarlos:
--     UPDATE conc_bancos SET activo = 1;
-- Los PDF subidos no se tocan (siguen en la carpeta de bancos).
-- ATENCIÓN: el borrado del Nación no se puede deshacer.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- 1) Sólo el Nación en la pantalla.
UPDATE conc_bancos SET activo = CASE WHEN codigo = 'NACION' THEN 1 ELSE 0 END;

-- 2) Períodos del Nación y todo lo que cuelga de ellos.
DECLARE @periodos TABLE (id INT PRIMARY KEY);
INSERT INTO @periodos SELECT id FROM conc_periodos WHERE banco = 'NACION';

DELETE ci FROM conc_cruce_items ci
WHERE ci.cruce_id IN (SELECT c.id FROM conc_cruces c WHERE c.periodo_id IN (SELECT id FROM @periodos))
   OR ci.movimiento_id IN (SELECT m.id FROM conc_movimientos m WHERE m.periodo_id IN (SELECT id FROM @periodos));

DELETE FROM conc_cruces WHERE periodo_id IN (SELECT id FROM @periodos);

DELETE o FROM conc_observaciones o
JOIN conc_movimientos m ON m.id = o.movimiento_id
WHERE m.periodo_id IN (SELECT id FROM @periodos);

DELETE r FROM conc_revisados r
JOIN conc_movimientos m ON m.id = r.movimiento_id
WHERE m.periodo_id IN (SELECT id FROM @periodos);

DELETE FROM conc_movimientos WHERE periodo_id IN (SELECT id FROM @periodos);
DELETE FROM conc_archivos    WHERE periodo_id IN (SELECT id FROM @periodos);
DELETE FROM conc_periodos    WHERE id IN (SELECT id FROM @periodos);

COMMIT;

-- Control: el Nación tiene que quedar sin períodos y como único activo.
SELECT codigo, nombre, activo FROM conc_bancos ORDER BY orden;
SELECT banco, anio, mes, estado FROM conc_periodos ORDER BY banco, anio, mes;
