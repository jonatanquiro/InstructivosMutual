"""Control de regresión: septiembre 2026 tiene que dar lo mismo que el prototipo.

Uso:   python regresion.py --base DIR
"""
import argparse
import sys
from pathlib import Path

from procesar import cmd_conciliar

# banco: (conciliados, asientos del mayor, en mayor no en banco, en banco no en mayor)
#
# Números del prototipo verificados a mano, salvo tres que mejoraron al pasar
# al extracto continuo (extracto.py), en octubre 2026:
# - SANTAFE era (467, 517, 50, 10): el lector sólo leía el primer resumen de
#   AGOSTO 2026.pdf (trae las dos quincenas) y se perdían los movimientos del
#   01/09 que vienen al final de ese PDF.
# - FRANCES era (348, 357, 9, 17) y RIO (1389, 1408, 19, 16): la regla de
#   asientos con la fecha en el concepto ("13/08 ERROR REG...") miraba el mes
#   del primer movimiento del resumen anterior, que empezaba el 31/07.
ESPERADO = {
    'COINAG': (92, 92, 0, 3),
    'CREDICOOP': (599, 609, 10, 11),
    'FRANCES': (351, 357, 6, 17),
    'RIO': (1393, 1408, 15, 16),
    'SANTAFE': (511, 517, 6, 11),
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--base', type=Path, required=True)
    a = p.parse_args()
    fallas = 0
    for banco, esperado in ESPERADO.items():
        c = cmd_conciliar(a.base, banco, 9, 2026)['cuadre']
        obtenido = (c['conciliados'], c['asientos_mayor'], c['pend_mayor'], c['pend_banco'])
        ok = obtenido == esperado
        fallas += not ok
        print(f"{'OK ' if ok else 'MAL'} {banco:10} {obtenido[0]} de {obtenido[1]} | "
              f'mayor no banco {obtenido[2]} | banco no mayor {obtenido[3]}'
              + ('' if ok else f'   (esperado {esperado})'))
    return 1 if fallas else 0


if __name__ == '__main__':
    sys.exit(main())
