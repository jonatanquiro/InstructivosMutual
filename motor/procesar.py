"""Puente entre INFORMAMUTUAL (Node) y el motor de conciliación.

Usa los lectores (lectores.py) y las reglas (conciliar.py) del prototipo y
devuelve todo por la salida estándar como JSON, para que Node lo guarde en
SQL Server. El banco no se lee "por PDF del mes" sino del extracto continuo
del año (extracto.py), tomando los movimientos por su fecha.

Uso:
  python procesar.py conciliar  --base DIR --banco COINAG --periodo 09/2026
  python procesar.py archivos   --base DIR --anio 2026
  python procesar.py validar    --base DIR --banco COINAG --periodo 09/2026 --tipo mayor|resumen
                                --archivo X.pdf [--parte 1|2]   (parte: quincena, sólo Santa Fe)

DIR es la carpeta con la estructura MAYOR/ y "RSM <BANCO>/" de siempre.
Si la lectura no cierra se devuelve {"ok": false, "error": "..."} (código de
salida 0: es un resultado esperable, no una falla del programa).
"""
import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

from conciliar import CUIT_PROPIO, conciliar, cuadre, rubro_gasto, valores_a_acreditar
from extracto import avisos, del_mes, del_mes_anterior, extracto
from lectores import BANCOS, MESES, ErrorLectura, leer_mayor, resumenes

CUIT = re.compile(r'\b(?:20|23|24|27|30|33|34)\d{9}\b')
DIAS_ANTERIOR_VISIBLES = 7   # últimos días del resumen anterior que se guardan para conciliar a mano
LADOS = {'M': 'mayor', 'B': 'banco', 'A': 'banco del mes anterior'}


def _ruta_mayor(base, banco, mes, anio):
    return base / 'MAYOR' / f'{banco}{mes:02d}{anio}.pdf'


def _claves(items, lado):
    """Clave estable por movimiento (misma idea que app.py del prototipo)."""
    vistos = {}
    for x in items:
        k = f"{lado}|{x['fecha']:%Y%m%d}|{x['importe']:.2f}|{x['concepto'][:150]}"
        vistos[k] = vistos.get(k, 0) + 1
        x['k'] = f'{k}|{vistos[k]}'


def _mov(x, lado, orden):
    texto = x['concepto'] + ' ' + x.get('detalle', '')
    cuit = CUIT.search(texto) if lado != 'M' else None
    return {
        'k': x['k'], 'lado': lado, 'orden': orden, 'fecha': x['fecha'],
        'concepto': x['concepto'], 'detalle': x.get('detalle', ''),
        'comprob': x.get('comprob', ''), 'nro': x.get('nro', ''), 'suc': x.get('suc', ''),
        'importe': x['importe'], 'saldo': x.get('saldo'),
        'por_acreditar': x.get('por_acreditar', 0.0),
        'cuit': cuit.group() if cuit else None,
        'rubro_gasto': rubro_gasto(x['concepto']) if lado != 'M' else None,
    }


def cmd_conciliar(base, banco, mes, anio):
    """Como conciliar.cargar(), pero el banco sale del extracto continuo del año:
    los movimientos se toman por su fecha, no por el PDF en que vinieron."""
    f_mayor = _ruta_mayor(base, banco, mes, anio)
    if not f_mayor.exists():
        raise ErrorLectura(f'Falta el mayor de {banco} de {mes:02d}/{anio} ({f_mayor.name}).')
    im, mayor = leer_mayor(f_mayor)
    # El extracto del año ya incluye diciembre anterior y enero siguiente.
    ext = extracto(banco, base, anio)
    actual = del_mes(ext, banco, base, mes, anio)
    if actual is None:
        raise ErrorLectura(f'Falta el resumen del banco de {mes:02d}/{anio}.')
    ib, banco_movs, archivos_mes, detalle_banco = actual
    banco_ant, archivos_ant = del_mes_anterior(ext, banco, base, mes, anio)
    lista_avisos = avisos(ext, banco, base, mes, anio)
    grupos = conciliar(mayor, banco_movs, banco_ant)
    c = cuadre(im, ib, mayor, banco_movs, grupos)

    _claves(mayor, 'M')
    _claves(banco_movs, 'B')
    _claves(banco_ant, 'A')
    # Del resumen del mes anterior: lo que usó el motor y, además, todo lo de los
    # últimos días (los asientos del día 1 pueden estar ahí y conciliarse a mano).
    usados_ant = {id(b) for g in grupos for b in g['banco']}
    desde_ant = date(anio, mes, 1) - timedelta(days=DIAS_ANTERIOR_VISIBLES)
    movimientos = ([_mov(m, 'M', i) for i, m in enumerate(mayor)]
                   + [_mov(b, 'B', i) for i, b in enumerate(banco_movs)]
                   + [_mov(b, 'A', i) for i, b in enumerate(banco_ant)
                      if id(b) in usados_ant or b['fecha'] >= desde_ant])

    return {
        'ok': True, 'banco': banco, 'mes': mes, 'anio': anio,
        'cuenta': im['cuenta'], 'hay_anterior': bool(banco_ant),
        'aviso_anterior': ' '.join(lista_avisos) or None,
        # Qué se leyó, para que se vea en pantalla: renglones y totales del mayor
        # (el lector ya controló que Debe/Haber coincidan con el pie del listado)
        # y, del banco, qué tomó de cada PDF con sus saldos.
        'lectura': {
            'mayor': {
                'archivo': f_mayor.name, 'renglones': len(mayor),
                'saldo_inicial': im['saldo_inicial'], 'saldo_final': im['saldo_final'],
                'debe': round(sum(m['importe'] for m in mayor if m['importe'] > 0), 2),
                'haber': round(-sum(m['importe'] for m in mayor if m['importe'] < 0), 2),
                'total_debe_pie': im.get('total_debe'), 'total_haber_pie': im.get('total_haber'),
            },
            'banco': {
                'renglones': len(banco_movs), 'saldo_inicial': ib['saldo_inicial'], 'saldo_final': ib['saldo_final'],
                'archivos': detalle_banco,
            },
        },
        'archivos': {
            'mayor': str(f_mayor),
            'resumen': [str(f) for f in archivos_mes],
            'resumen_anterior': [str(f) for f in archivos_ant if f not in archivos_mes],
        },
        'saldos': {'ini_mayor': im['saldo_inicial'], 'fin_mayor': im['saldo_final'],
                   'ini_banco': ib['saldo_inicial'], 'fin_banco': ib['saldo_final']},
        'movimientos': movimientos,
        'grupos': [{'tipo': g['tipo'], 'nota': g['nota'],
                    'mayor': [m['k'] for m in g['mayor']], 'banco': [b['k'] for b in g['banco']]}
                   for g in grupos],
        # Cuadre tal como lo calcula el motor: sirve de control de regresión
        # contra el que después calcula Node desde la base.
        'cuadre': {
            'asientos_mayor': len(mayor), 'conciliados': len(mayor) - len(c['pend_m']),
            'pend_mayor': len(c['pend_m']), 'pend_banco': len(c['pend_otros']),
            'pend_gastos': len(c['pend_gastos']),
            'dif_ini': c['dif_ini'], 'tot_mes_ant': c['tot_mes_ant'],
            'sin_explicar_ini': c['sin_explicar_ini'], 'difs': c['difs'],
            'calculado': c['calculado'], 'dif_final': c['dif_final'],
        },
        'valores_a_acreditar': [{'fecha': l['fecha'], 'concepto': l['concepto'], 'comprob': l['comprob'],
                                 'importe': l['por_acreditar'], 'detalle': l['detalle']}
                                for l in valores_a_acreditar(banco_movs)],
        'cuit_propio': CUIT_PROPIO,
    }


def nombre_destino(banco, mes, anio, parte=None):
    """Con qué nombre guardar un resumen subido desde la web para que el lector lo encuentre.

    parte: None (mes completo), 1 o 2 (quincena, sólo Santa Fe).
    """
    if banco == 'CREDICOOP':
        ultimo = (date(anio + (mes == 12), mes % 12 + 1, 1) - date.resolution).day
        return f'Resumen Del {anio}-{mes:02d}-01 Al {anio}-{mes:02d}-{ultimo:02d}.pdf'
    if parte in (1, 2):
        return f"{'PRIMER' if parte == 1 else 'SEGUNDA'} QUINCENA {MESES[mes - 1]} {anio}.pdf"
    return f'{MESES[mes - 1]} {anio}.pdf'


def cmd_archivos(base, anio):
    """Qué PDF hay en la carpeta para cada banco y mes del año."""
    out = {}
    for banco, cfg in BANCOS.items():
        meses = {}
        for mes in range(1, 13):
            mayor = _ruta_mayor(base, banco, mes, anio)
            rs = resumenes(banco, base, mes, anio)
            fechas = [f.stat().st_mtime for f in rs + ([mayor] if mayor.exists() else [])]
            meses[mes] = {
                'mayor': mayor.name if mayor.exists() else None,
                'resumen': [f.name for f in rs],
                # última modificación de sus PDF: si es posterior al último cruce,
                # la grilla avisa que conviene volver a cruzar
                'modificado': max(fechas) if fechas else None,
            }
        out[banco] = {'carpeta': cfg['carpeta'], 'meses': meses}
    return {'ok': True, 'anio': anio, 'bancos': out}


def cmd_validar(base, banco, mes, anio, tipo, archivo, parte=None):
    """Lee un único PDF (recién subido) para avisar en el momento si no cierra.

    También dice con qué nombre y en qué carpeta guardarlo para que después
    el lector lo encuentre, y qué PDF hay ya cargados para ese mes.
    """
    if tipo == 'mayor':
        info, movs = leer_mayor(archivo)
        carpeta, nombre = 'MAYOR', _ruta_mayor(base, banco, mes, anio).name
        existentes = [nombre] if _ruta_mayor(base, banco, mes, anio).exists() else []
    else:
        info, movs = BANCOS[banco]['lector'](archivo, mes, anio)
        carpeta, nombre = BANCOS[banco]['carpeta'], nombre_destino(banco, mes, anio, parte)
        existentes = [f.name for f in resumenes(banco, base, mes, anio)]
    return {'ok': True, 'cuenta': info.get('cuenta', ''), 'movimientos': len(movs),
            'saldo_inicial': info['saldo_inicial'], 'saldo_final': info['saldo_final'],
            'desde': movs[0]['fecha'] if movs else None, 'hasta': movs[-1]['fecha'] if movs else None,
            'destino': {'carpeta': carpeta, 'nombre': nombre, 'existentes': existentes}}


def _periodo(s):
    m = re.fullmatch(r'(\d{1,2})/(\d{4})', s or '')
    if not m or not 1 <= int(m.group(1)) <= 12:
        raise argparse.ArgumentTypeError('El período tiene que ser MM/AAAA.')
    return int(m.group(1)), int(m.group(2))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('accion', choices=['conciliar', 'archivos', 'validar'])
    p.add_argument('--base', type=Path)
    p.add_argument('--banco', choices=list(BANCOS))
    p.add_argument('--periodo', type=_periodo)
    p.add_argument('--anio', type=int)
    p.add_argument('--tipo', choices=['mayor', 'resumen'])
    p.add_argument('--archivo', type=Path)
    p.add_argument('--parte', type=int, choices=[1, 2])
    a = p.parse_args()

    try:
        if a.accion == 'conciliar':
            r = cmd_conciliar(a.base, a.banco, *a.periodo)
        elif a.accion == 'archivos':
            r = cmd_archivos(a.base, a.anio)
        else:
            r = cmd_validar(a.base, a.banco, *a.periodo, a.tipo, a.archivo, a.parte)
    except ErrorLectura as e:
        r = {'ok': False, 'error': str(e)}

    # ensure_ascii: la consola de Windows no siempre está en UTF-8.
    sys.stdout.write(json.dumps(r, ensure_ascii=True,
                                default=lambda o: o.isoformat() if isinstance(o, date) else str(o)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
