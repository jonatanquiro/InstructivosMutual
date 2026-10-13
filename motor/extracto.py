"""Extracto continuo del banco: todos los resúmenes del año, encadenados por saldo.

Los PDF de los bancos no cortan siempre a fin de mes: un resumen de agosto puede
traer movimientos del 01/09 (Santa Fe cierra la quincena el día 1), y uno de
julio movimientos de agosto. Por eso, en vez de leer "el PDF del mes", se leen
todos los resúmenes del año, se encadenan (cada uno tiene que empezar con el
saldo con que terminó el anterior) y para conciliar un mes se toman los
movimientos por su FECHA, vengan del archivo que vengan.

Cada PDF se lee una sola vez: el resultado queda en <base>/_cache y se vuelve a
leer sólo si cambia el PDF o el lector (lectores.py).
"""
import hashlib
import json
from datetime import date, timedelta
from pathlib import Path

from lectores import BANCOS, ErrorLectura, resumenes

_VERSION_LECTOR = hashlib.sha256(Path(__file__).with_name('lectores.py').read_bytes()).hexdigest()[:12]


def _a_json(movs):
    return [{**m, 'fecha': m['fecha'].isoformat()} for m in movs]


def _de_json(movs):
    return [{**m, 'fecha': date.fromisoformat(m['fecha'])} for m in movs]


def _corregir_anio(movs, mes, anio):
    """Francés imprime las fechas sin año y el lector lo deduce del mes del PDF:
    los movimientos de enero dentro del resumen de diciembre quedan con el año
    anterior. Si una fecha cae a más de ~6 meses del mes del PDF, se corrige el año."""
    referencia = date(anio, mes, 15)
    for m in movs:
        dias = (m['fecha'] - referencia).days
        if dias < -200:
            m['fecha'] = m['fecha'].replace(year=m['fecha'].year + 1)
        elif dias > 200:
            m['fecha'] = m['fecha'].replace(year=m['fecha'].year - 1)
    return movs


def _leer(banco, archivo, mes, anio, carpeta_cache):
    """Lee un PDF con el lector del banco, usando la caché si el PDF ya se leyó."""
    contenido = archivo.read_bytes()
    clave = f"{banco}-{hashlib.sha256(contenido).hexdigest()[:24]}-{_VERSION_LECTOR}"
    cache = carpeta_cache / f'{clave}.json'
    if cache.exists():
        d = json.loads(cache.read_text(encoding='utf-8'))
        return d['info'], _corregir_anio(_de_json(d['movs']), mes, anio), clave
    info, movs = BANCOS[banco]['lector'](archivo, mes, anio)
    carpeta_cache.mkdir(exist_ok=True)
    cache.write_text(json.dumps({'info': info, 'movs': _a_json(movs)}, ensure_ascii=False), encoding='utf-8')
    return info, _corregir_anio(movs, mes, anio), clave


def _fmt(d):
    return f'{d:%d/%m/%Y}'


def extracto(banco, base, anio):
    """Todos los resúmenes del año (más diciembre anterior y enero siguiente), encadenados.

    Devuelve {'movimientos': [...], 'huecos': [...]}. Cada movimiento trae
    'saldo_antes', 'saldo_despues' y 'archivo'. Un hueco es un lugar donde un
    resumen no empieza con el saldo con que terminó el anterior (falta un PDF o
    hay dos que se superponen).
    """
    meses = [(12, anio - 1)] + [(m, anio) for m in range(1, 13)] + [(1, anio + 1)]
    partes, vistos = [], set()
    for mes, a in meses:
        for archivo in resumenes(banco, base, mes, a):
            info, movs, clave = _leer(banco, archivo, mes, a, base / '_cache')
            if clave in vistos or not movs:      # el mismo PDF con dos nombres, o sin movimientos
                continue
            vistos.add(clave)
            partes.append({'archivo': archivo, 'info': info, 'movs': movs})
    partes.sort(key=lambda p: (p['movs'][0]['fecha'], p['movs'][-1]['fecha']))

    movimientos, huecos = [], []
    for i, p in enumerate(partes):
        if i and abs(p['info']['saldo_inicial'] - partes[i - 1]['info']['saldo_final']) > 0.005:
            ant = partes[i - 1]
            huecos.append({'desde': ant['movs'][-1]['fecha'], 'hasta': p['movs'][0]['fecha'],
                           'archivo_antes': ant['archivo'].name, 'archivo_despues': p['archivo'].name,
                           'saldo_antes': ant['info']['saldo_final'], 'saldo_despues': p['info']['saldo_inicial']})
        saldo = p['info']['saldo_inicial']
        for m in p['movs']:
            nuevo = dict(m)
            nuevo['saldo_antes'] = saldo
            saldo = round(saldo + m['importe'], 2)
            nuevo['saldo_despues'] = saldo
            nuevo['archivo'] = p['archivo']
            movimientos.append(nuevo)
    return {'movimientos': movimientos, 'huecos': huecos}


def _limites(mes, anio):
    inicio = date(anio, mes, 1)
    fin = date(anio + (mes == 12), mes % 12 + 1, 1) - timedelta(days=1)
    return inicio, fin


def _anterior(mes, anio):
    return (mes - 1, anio) if mes > 1 else (12, anio - 1)


def _hueco_en(huecos, inicio, fin):
    """Huecos de la cadena que caen dentro de [inicio, fin]."""
    return [h for h in huecos if h['hasta'] >= inicio and h['desde'] <= fin]


def _texto_hueco(h):
    return (f"entre el {_fmt(h['desde'])} y el {_fmt(h['hasta'])} ({h['archivo_antes']} termina con saldo "
            f"{h['saldo_antes']:,.2f} y {h['archivo_despues']} empieza con {h['saldo_despues']:,.2f})")


def _limpio(m):
    """Copia del movimiento sin los datos del extracto (el motor no los usa)."""
    return {k: v for k, v in m.items() if k not in ('saldo_antes', 'saldo_despues', 'archivo')}


def _del_resumen(ext, banco, base, mes, anio):
    """Movimientos que corresponden al resumen del mes.

    Cada resumen se queda con lo que trae (el de septiembre puede empezar con
    movimientos del 31/08 que el banco procesó después de cerrar agosto: el
    asiento global de gastos se arma así, por resumen), salvo lo fechado en el
    mes siguiente, que pasa a ese mes: los movimientos del 01/09 al final del
    resumen de agosto (Santa Fe cierra la quincena el día 1) son de septiembre.
    """
    inicio, fin = _limites(mes, anio)
    propios = set(resumenes(banco, base, mes, anio))
    previos = set(resumenes(banco, base, *_anterior(mes, anio)))
    return [m for m in ext['movimientos']
            if (m['archivo'] in propios and m['fecha'] <= fin)
            or (m['archivo'] in previos and inicio <= m['fecha'] <= fin)]


def del_mes(ext, banco, base, mes, anio):
    """Movimientos del banco del mes, con saldo inicial y final sacados del extracto.

    Devuelve (info, movimientos, archivos) o None si no hay resumen del mes.
    Si falta un resumen dentro del mes no se puede conciliar: ErrorLectura.
    """
    movs = _del_resumen(ext, banco, base, mes, anio)
    if not movs:
        return None
    inicio, fin = _limites(mes, anio)
    huecos = _hueco_en(ext['huecos'], min(inicio, movs[0]['fecha']), fin)
    if huecos:
        raise ErrorLectura('Falta un resumen del banco ' + '; '.join(_texto_hueco(h) for h in huecos)
                           + '. Cargá el PDF que falta para poder conciliar este mes.')
    info = {'saldo_inicial': movs[0]['saldo_antes'], 'saldo_final': movs[-1]['saldo_despues']}
    if abs(round(info['saldo_inicial'] + sum(m['importe'] for m in movs), 2) - info['saldo_final']) > 0.005:
        raise ErrorLectura('Los resúmenes del banco de este mes no se pueden encadenar por saldo.')
    archivos = sorted({m['archivo'] for m in movs}, key=lambda f: f.name)
    # Qué se tomó de cada PDF, para mostrarlo en pantalla.
    detalle = []
    for f in dict.fromkeys(m['archivo'] for m in movs):     # en el orden de la cadena de saldos
        del_archivo = [m for m in movs if m['archivo'] == f]
        detalle.append({'archivo': f.name, 'renglones': len(del_archivo),
                        'desde': del_archivo[0]['fecha'], 'hasta': del_archivo[-1]['fecha'],
                        'saldo_inicial': del_archivo[0]['saldo_antes'], 'saldo_final': del_archivo[-1]['saldo_despues']})
    return info, [_limpio(m) for m in movs], archivos, detalle


def del_mes_anterior(ext, banco, base, mes, anio):
    """Movimientos del resumen del mes anterior (para la regla "mes anterior").

    Van primero los fechados en ese mes: el motor toma el mes del primer
    movimiento para reconocer asientos con la fecha en el concepto ("24/08
    ROJAS"), y un resumen de agosto que empieza el 31/07 lo confundía.
    """
    mes_a, anio_a = _anterior(mes, anio)
    movs = _del_resumen(ext, banco, base, mes_a, anio_a)
    movs.sort(key=lambda m: m['fecha'].month != mes_a)   # orden estable
    return [_limpio(m) for m in movs], sorted({m['archivo'] for m in movs}, key=lambda f: f.name)


def avisos(ext, banco, base, mes, anio):
    """Avisos que no impiden conciliar: falta parte del resumen del mes
    anterior, o el último resumen cargado no llega a fin de mes."""
    lista = []
    ini_ant, fin_ant = _limites(*_anterior(mes, anio))
    for h in _hueco_en(ext['huecos'], ini_ant, fin_ant):
        lista.append('Falta un resumen del banco del mes anterior ' + _texto_hueco(h) + '. Los asientos de los '
                     'primeros días que el banco registró en esa parte van a quedar pendientes hasta que se cargue.')
    inicio, fin = _limites(mes, anio)
    movs = _del_resumen(ext, banco, base, mes, anio)
    posteriores = [m for m in ext['movimientos'] if m['fecha'] > fin]
    if movs and not posteriores and movs[-1]['fecha'] < fin - timedelta(days=3):
        lista.append(f"El último resumen del banco cargado llega hasta el {_fmt(movs[-1]['fecha'])}: "
                     'falta el resto del mes.')
    return lista
