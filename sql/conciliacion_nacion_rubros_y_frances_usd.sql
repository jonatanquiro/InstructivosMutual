-- Conciliación: rubros de gastos del Nación y baja del Francés USD.
-- Se puede correr más de una vez.

-- 1) Nación: los gastos van en tres rubros, como se contabilizan:
--    mantenimiento (comisiones, IVA e intereses), Ley 25413 y SIRCREB.
--    Sólo cambia el nombre del rubro de los movimientos ya leídos; no toca
--    lo cruzado ni el estado de los períodos.
UPDATE m SET rubro_gasto = CASE m.rubro_gasto
        WHEN N'Comisiones y mantenimiento'    THEN N'Gastos de mantenimiento'
        WHEN N'IVA'                           THEN N'Gastos de mantenimiento'
        WHEN N'Intereses'                     THEN N'Gastos de mantenimiento'
        WHEN N'Impuesto Ley 25413 (déb/créd)' THEN N'Ley débito/crédito (25413)'
        WHEN N'SIRCREB (Ingresos Brutos)'     THEN N'SIRCREB'
    END
FROM conc_movimientos m
JOIN conc_periodos p ON p.id = m.periodo_id
WHERE p.banco = 'NACION'
  AND m.rubro_gasto IN (N'Comisiones y mantenimiento', N'IVA', N'Intereses',
                        N'Impuesto Ley 25413 (déb/créd)', N'SIRCREB (Ingresos Brutos)');
GO

-- 2) Francés USD: no se usa. Se borra si no tiene ningún período; si
--    tuviera, sólo se desactiva (deja de aparecer en la pantalla).
IF NOT EXISTS (SELECT 1 FROM conc_periodos WHERE banco = 'FRANCESUSD')
    DELETE FROM conc_bancos WHERE codigo = 'FRANCESUSD';
ELSE
    UPDATE conc_bancos SET activo = 0 WHERE codigo = 'FRANCESUSD';
GO
