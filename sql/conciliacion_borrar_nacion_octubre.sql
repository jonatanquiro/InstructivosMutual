-- Conciliación: borra SÓLO octubre 2026 del Nación (movimientos, cruces,
-- observaciones, revisados y archivos registrados) para volver a cargarlo.
-- No toca ningún otro mes ni banco. Los PDF quedan en la carpeta.
-- ATENCIÓN: no se puede deshacer.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

DECLARE @periodos TABLE (id INT PRIMARY KEY);
INSERT INTO @periodos SELECT id FROM conc_periodos WHERE banco = 'NACION' AND anio = 2026 AND mes = 10;

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

-- Control: lo que queda del Nación.
SELECT id, banco, anio, mes, estado FROM conc_periodos WHERE banco = 'NACION' ORDER BY anio, mes;
