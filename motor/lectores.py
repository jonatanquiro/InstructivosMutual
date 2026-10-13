"""Lectores de PDF: mayor contable del sistema y resúmenes bancarios.

Cada lector devuelve (info, movimientos) con los importes ya con signo:
positivo = entra plata a la cuenta, negativo = sale.
Todos controlan que los saldos impresos cierren con los movimientos leídos.
"""
import re
from collections import defaultdict
from datetime import date
from fnmatch import fnmatchcase

import pdfplumber

FECHA = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$')
DIA_MES = re.compile(r'^(\d{2})/(\d{2})$')
NUM_AR = re.compile(r'^-?\d{1,3}(\.\d{3})*,\d\d-?$')
MENOS = '−'


class ErrorLectura(Exception):
    pass


def _filas(page, tol=2.0):
    """Agrupa los caracteres de la página en renglones (por coordenada vertical)."""
    filas = defaultdict(list)
    for c in page.chars:
        if c['text'].strip():
            filas[round(c['top'] / tol)].append(c)
    return [sorted(filas[k], key=lambda c: c['x0']) for k in sorted(filas)]


def _texto(chars, x0, x1, pegado=False):
    """Texto de los caracteres cuyo centro cae entre x0 y x1."""
    sel = [c for c in chars if x0 <= (c['x0'] + c['x1']) / 2 < x1]
    if pegado:
        return ''.join(c['text'] for c in sel)
    s, ant = '', None
    for c in sel:
        if ant is not None and c['x0'] - ant > 1.5:
            s += ' '
        s += c['text']
        ant = c['x1']
    return s.strip()


def _renglones(page, salto=3.0, x_max=None):
    """Palabras de la página agrupadas por renglón, ordenadas de izquierda a derecha."""
    palabras = [w for w in page.extract_words(x_tolerance=1.5, y_tolerance=2)
                if x_max is None or w['x0'] < x_max]
    palabras.sort(key=lambda w: w['top'])
    filas = []
    for w in palabras:
        w['text'] = w['text'].replace(MENOS, '-')
        if filas and w['top'] - filas[-1][0]['top'] <= salto:
            filas[-1].append(w)
        else:
            filas.append([w])
    return [sorted(f, key=lambda w: w['x0']) for f in filas]


def _fecha(s):
    m = FECHA.match(s)
    if not m:
        return None
    anio = int(m.group(3))
    return date(anio + 2000 if anio < 100 else anio, int(m.group(2)), int(m.group(1)))


def _num_us(s):   # 1,234,567.89
    return round(float(s.replace(',', '')), 2) if s else 0.0


def _num_ar(s):   # 1.234.567,89  (el signo puede venir adelante o atrás)
    if not s:
        return 0.0
    v = float(s.replace('-', '').replace('.', '').replace(',', '.'))
    return round(-v if '-' in s else v, 2)


def _mov(fecha, saldo=None):
    return {'fecha': fecha, 'concepto': '', 'detalle': '', 'comprob': '',
            'por_acreditar': 0.0, 'importe': 0.0, 'saldo': saldo}


def _verificar_saldos(movs, info, origen):
    """Controla saldo anterior + movimientos = saldo impreso (donde el resumen lo trae)."""
    if info.get('saldo_inicial') is None:
        raise ErrorLectura(f'{origen}: no se encontró el saldo anterior.')
    s = info['saldo_inicial']
    for m in movs:
        s = round(s + m['importe'], 2)
        if m['saldo'] is not None and abs(s - m['saldo']) > 0.005:
            raise ErrorLectura(
                f"{origen}: el saldo no cierra en el renglón del {m['fecha']:%d/%m/%Y} "
                f"'{m['concepto']}' (calculado {s:,.2f}, impreso {m['saldo']:,.2f}). "
                "El PDF no se leyó bien; no se puede conciliar.")
    if info.get('saldo_final') is None:
        info['saldo_final'] = s
    elif abs(s - info['saldo_final']) > 0.005:
        raise ErrorLectura(f"{origen}: los movimientos leídos dan un saldo final de {s:,.2f} "
                           f"y el resumen dice {info['saldo_final']:,.2f}.")


# ------------------------------------------------------------------ Mayor

def leer_mayor(path):
    """Mayor de una cuenta banco. Debe = entra plata (+), Haber = sale (-)."""
    info = {'cuenta': '', 'saldo_inicial': None, 'saldo_final': None,
            'total_debe': None, 'total_haber': None}
    movs = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for f in _filas(page):
                linea = _texto(f, 0, 9999)
                if linea.startswith('CUENTA:'):
                    info['cuenta'] = linea[7:].strip()
                    continue
                if linea.startswith('Total:'):
                    info['total_debe'] = _num_us(_texto(f, 272, 366, True))
                    info['total_haber'] = _num_us(_texto(f, 366, 470, True))
                    continue
                fe = _fecha(_texto(f, 0, 76, True))
                if fe is None:
                    if info['saldo_inicial'] is None and re.fullmatch(r'-?[\d,]+\.\d\d', linea):
                        info['saldo_inicial'] = _num_us(linea)
                    continue
                debe = _num_us(_texto(f, 272, 366, True))
                haber = _num_us(_texto(f, 366, 470, True))
                movs.append({
                    'fecha': fe,
                    'concepto': _texto(f, 76, 240),
                    'nro': _texto(f, 240, 272, True),
                    'suc': _texto(f, 568.8, 9999, True),
                    'importe': round(debe - haber, 2),
                    'saldo': _num_us(_texto(f, 470, 568.8, True)),
                })
    _verificar_saldos(movs, info, 'Mayor')
    debe = round(sum(m['importe'] for m in movs if m['importe'] > 0), 2)
    haber = round(-sum(m['importe'] for m in movs if m['importe'] < 0), 2)
    if info['total_debe'] is not None and (abs(debe - info['total_debe']) > 0.005
                                           or abs(haber - info['total_haber']) > 0.005):
        raise ErrorLectura('Mayor: los totales de Debe/Haber leídos no coinciden con el pie del listado.')
    return info, movs


# ------------------------------------------------------------------ Bancos

def leer_coinag(path, mes=None, anio=None):
    """Banco Coinag: saldo en cada renglón; los depósitos de valores figuran 'por acreditar'."""
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs, fecha = [], None
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            filas = defaultdict(list)
            for w in page.extract_words(x_tolerance=1.5, y_tolerance=2):
                filas[round(w['top'] / 2)].append(w)
            for k in sorted(filas):
                ws = sorted(filas[k], key=lambda w: w['x0'])
                txt = ' '.join(w['text'] for w in ws)
                if 'Saldo Ant.:' in txt:
                    info['saldo_inicial'] = _num_ar(ws[-1]['text'])
                    continue
                if 'odo:' in txt:
                    continue
                if ws[0]['x0'] < 100 and _fecha(ws[0]['text']):
                    fecha = _fecha(ws[0]['text'])
                    ws = ws[1:]
                if not ws:
                    continue
                saldo = [w for w in ws if w['x1'] > 565 and NUM_AR.match(w['text'])]
                if not saldo or not (100 <= ws[0]['x0'] < 106):
                    # renglón de detalle: se agrega al movimiento anterior
                    if movs and 106 <= ws[0]['x0'] < 112:
                        movs[-1]['detalle'] = (movs[-1]['detalle'] + ' ' + txt).strip()
                    continue
                m = _mov(fecha, _num_ar(saldo[0]['text']))
                conc = []
                for w in ws:
                    if w is saldo[0]:
                        continue
                    x1, es_num = w['x1'], bool(NUM_AR.match(w['text']))
                    if w['x0'] < 290:
                        conc.append(w['text'])
                    elif x1 < 335:
                        m['comprob'] = w['text']
                    elif x1 < 395 and es_num:
                        m['por_acreditar'] = _num_ar(w['text'])
                    elif x1 < 460 and es_num:      # columna Débito
                        m['importe'] = round(m['importe'] - _num_ar(w['text']), 2)
                    elif x1 < 525 and es_num:      # columna Crédito
                        m['importe'] = round(m['importe'] + _num_ar(w['text']), 2)
                    else:
                        conc.append(w['text'])
                m['concepto'] = ' '.join(conc)
                movs.append(m)
    _verificar_saldos(movs, info, 'Resumen Coinag')
    return info, movs


def leer_credicoop(path, mes=None, anio=None):
    """Banco Credicoop: trae el saldo sólo en el último renglón de cada día."""
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            if info['saldo_final'] is not None:
                break
            for ws in _renglones(page):
                txt = ' '.join(w['text'] for w in ws)
                if txt.startswith('SALDO ANTERIOR'):
                    info['saldo_inicial'] = _num_ar(ws[-1]['text'])
                    continue
                if txt.startswith('SALDO AL '):
                    info['saldo_final'] = _num_ar(ws[-1]['text'])
                    break
                if info['saldo_inicial'] is None:
                    continue
                fe = _fecha(ws[0]['text']) if ws[0]['x0'] < 40 else None
                if fe is None:
                    if movs and 105 <= ws[0]['x0'] < 115:
                        movs[-1]['detalle'] = (movs[-1]['detalle'] + ' ' + txt).strip()
                    continue
                m = _mov(fe)
                conc = []
                for w in ws[1:]:
                    t = w['text']
                    if w['x0'] < 106:
                        m['comprob'] = t
                    elif w['x0'] < 330 or not NUM_AR.match(t):
                        conc.append(t)
                    elif w['x1'] < 430:
                        m['importe'] = round(m['importe'] - _num_ar(t), 2)
                    elif w['x1'] < 520:
                        m['importe'] = round(m['importe'] + _num_ar(t), 2)
                    else:
                        m['saldo'] = _num_ar(t)
                m['concepto'] = ' '.join(conc)
                movs.append(m)
    _verificar_saldos(movs, info, 'Resumen Credicoop')
    return info, movs


def leer_frances(path, mes=None, anio=None):
    """BBVA Francés: fechas sin año, débitos con signo negativo, saldo en cada renglón.

    Lee sólo la primera cuenta del PDF (la que tiene movimientos).
    """
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            if info['saldo_final'] is not None:
                break
            for ws in _renglones(page, x_max=576):
                ws = [w for w in ws if w['x0'] >= 60]      # descarta marcas del margen
                if not ws:
                    continue
                txt = ' '.join(w['text'] for w in ws)
                nums = [w for w in ws if NUM_AR.match(w['text']) and w['x1'] > 380]
                if info['saldo_inicial'] is None:
                    if 'SALDO ANTERIOR' in txt and nums:
                        info['saldo_inicial'] = _num_ar(nums[-1]['text'])
                    continue
                if 'SALDO AL ' in txt and nums:
                    info['saldo_final'] = _num_ar(nums[-1]['text'])
                    break
                dm = DIA_MES.match(ws[0]['text']) if ws[0]['x0'] < 75 else None
                if not dm or 'SIN MOVIMIENTOS' in txt:
                    if movs and not nums and 130 <= ws[0]['x0'] < 140:
                        movs[-1]['detalle'] = (movs[-1]['detalle'] + ' ' + txt).strip()
                    continue
                d, mm = int(dm.group(1)), int(dm.group(2))
                m = _mov(date(anio if mm <= mes else anio - 1, mm, d))
                conc = []
                for w in ws[1:]:
                    if any(w is n for n in nums):
                        if w['x1'] < 510:      # Débito (ya viene negativo) o Crédito
                            m['importe'] = round(m['importe'] + _num_ar(w['text']), 2)
                        else:
                            m['saldo'] = _num_ar(w['text'])
                    elif w['x0'] < 130:
                        if w['text'] != 'D':
                            m['comprob'] = w['text']
                    else:
                        conc.append(w['text'])
                m['concepto'] = ' '.join(conc)
                movs.append(m)
    _verificar_saldos(movs, info, 'Resumen Francés')
    return info, movs


def leer_rio(path, mes=None, anio=None):
    """Santander: la fecha viene una vez por día (o en texto oculto debajo del renglón)."""
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs, fecha, fin = [], None, False
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            if fin:
                break
            filas = _renglones(page)
            ocultas = [(f[0]['top'], _fecha(f[0]['text'])) for f in filas
                       if len(f) == 1 and f[0]['x1'] - f[0]['x0'] < 1 and _fecha(f[0]['text'])]
            for ws in filas:
                if len(ws) == 1 and ws[0]['x1'] - ws[0]['x0'] < 1:
                    continue
                txt = ' '.join(w['text'] for w in ws)
                if txt.startswith('Movimientos en d') or (info['saldo_inicial'] is not None
                                                          and txt.startswith('Saldo total')):
                    fin = True
                    break
                nums = [w for w in ws if NUM_AR.match(w['text']) and w['x1'] > 360]
                saldo = [w for w in nums if w['x1'] > 520]
                if 'Saldo Inicial' in txt and saldo:
                    if info['saldo_inicial'] is None:
                        info['saldo_inicial'] = _num_ar(saldo[0]['text'])
                    continue
                if info['saldo_inicial'] is None:
                    continue
                if not saldo:
                    if movs and 112 <= ws[0]['x0'] < 120 and not nums:
                        movs[-1]['detalle'] = (movs[-1]['detalle'] + ' ' + txt).strip()
                    continue
                top = ws[0]['top']
                propia = _fecha(ws[0]['text']) if ws[0]['x0'] < 40 else None
                cerca = [f for t, f in ocultas if -1 <= t - top <= 9]
                fecha = propia or (cerca[0] if cerca else fecha)
                m = _mov(fecha)
                conc = []
                for i, w in enumerate(ws):
                    neg = i > 0 and ws[i - 1]['text'] in ('-$', '-')
                    if any(w is n for n in nums):
                        v = _num_ar(w['text'])
                        v = -abs(v) if neg else v
                        if w['x1'] < 420:
                            m['importe'] = round(m['importe'] - v, 2)
                        elif w['x1'] < 505:
                            m['importe'] = round(m['importe'] + v, 2)
                        else:
                            m['saldo'] = v
                    elif w['text'] in ('$', '-$', '-') or (w is ws[0] and propia):
                        continue
                    elif w['x0'] < 112:
                        m['comprob'] = w['text']
                    elif w['x1'] < 365:
                        conc.append(w['text'])
                m['concepto'] = ' '.join(conc)
                movs.append(m)
    _verificar_saldos(movs, info, 'Resumen Santander')
    return info, movs


def leer_santafe(path, mes=None, anio=None):
    """Nuevo Banco de Santa Fe: resumen quincenal, saldo sólo al cierre de cada día.

    Un mismo PDF puede traer varios resúmenes seguidos (ej. AGOSTO 2026.pdf tiene
    la 1ra quincena y la 2da). Se leen todos, y cada uno tiene que empezar con el
    saldo con que cerró el anterior.
    """
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs = []
    leyendo, cierre = False, None   # dentro de un resumen / saldo del último "Saldo al:"
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for ws in _renglones(page):
                txt = ' '.join(w['text'] for w in ws)
                if txt.startswith('SALDO ULTIMO RESUMEN'):
                    saldo = _num_ar(ws[-1]['text'])
                    if info['saldo_inicial'] is None:
                        info['saldo_inicial'] = saldo
                    elif cierre is None or abs(saldo - cierre) > 0.005:
                        raise ErrorLectura(
                            f"Resumen Santa Fe: el PDF trae varios resúmenes que no empalman (uno cierra en "
                            f"{cierre or 0:,.2f} y el siguiente empieza en {saldo:,.2f}).")
                    leyendo = True
                    continue
                if txt.startswith('Saldo al:'):
                    cierre = _num_ar(ws[-1]['text'])
                    leyendo = False
                    break          # el resto de la página es el pie del resumen
                if not leyendo:
                    continue
                fe = _fecha(ws[0]['text']) if ws[0]['x0'] < 95 else None
                if fe is None:
                    continue
                m = _mov(fe)
                conc = []
                for w in ws[1:]:
                    t = w['text']
                    if NUM_AR.match(t) and w['x0'] > 290:
                        if w['x1'] < 385:
                            m['importe'] = round(m['importe'] - _num_ar(t), 2)
                        elif w['x1'] < 475:
                            m['importe'] = round(m['importe'] + _num_ar(t), 2)
                        else:
                            m['saldo'] = _num_ar(t)
                    elif 228 <= w['x0'] and w['x1'] <= 265 and t.isdigit():
                        m['comprob'] = t
                    else:
                        conc.append(t)
                m['concepto'] = ' '.join(conc)
                movs.append(m)
    info['saldo_final'] = cierre
    _verificar_saldos(movs, info, 'Resumen Santa Fe')
    return info, movs


def leer_nacion(path, mes=None, anio=None):
    """Banco Nación: saldo en cada renglón."""
    info = {'saldo_inicial': None, 'saldo_final': None}
    movs = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for ws in _renglones(page):
                ws = [w for w in ws if set(w['text']) != {'_'}]
                if not ws:
                    continue
                txt = ' '.join(w['text'] for w in ws)
                if 'SALDO ANTERIOR' in txt and info['saldo_inicial'] is None:
                    info['saldo_inicial'] = _num_ar(ws[-1]['text'])
                    continue
                if 'SALDO FINAL' in txt and NUM_AR.match(ws[-1]['text']):
                    info['saldo_final'] = _num_ar(ws[-1]['text'])
                    continue
                fe = _fecha(ws[0]['text']) if ws[0]['x0'] < 80 else None
                if fe is None or info['saldo_inicial'] is None:
                    continue
                m = _mov(fe)
                conc = []
                for w in ws[1:]:
                    t = w['text']
                    if NUM_AR.match(t) and w['x0'] > 300:
                        if w['x1'] < 385:
                            m['importe'] = round(m['importe'] - _num_ar(t), 2)
                        elif w['x1'] < 480:
                            m['importe'] = round(m['importe'] + _num_ar(t), 2)
                        else:
                            m['saldo'] = _num_ar(t)
                    elif w['x0'] >= 240:
                        m['comprob'] = t
                    else:
                        conc.append(t)
                m['concepto'] = ' '.join(conc)
                if m['saldo'] is not None:
                    movs.append(m)
    _verificar_saldos(movs, info, 'Resumen Nación')
    return info, movs


# ------------------------------------------------------------------ Registro

MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO',
         'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE']


def _por_mes(mes, anio):
    return [f'{MESES[mes - 1]} {anio}.pdf']


# Un banco = carpeta de resúmenes, patrones de nombre del PDF del mes y con qué se lee.
# El nombre es el mismo del archivo del mayor: MAYOR/<NOMBRE><mes><año>.pdf
BANCOS = {
    'COINAG': {'carpeta': 'RSM COINAG', 'patrones': _por_mes, 'lector': leer_coinag},
    'CREDICOOP': {'carpeta': 'RSM CREDICOOP', 'lector': leer_credicoop,
                  'patrones': lambda mes, anio: [f'*Del {anio}-{mes:02d}-01 Al *.pdf']},
    'FRANCES': {'carpeta': 'RSM FRANCES', 'patrones': _por_mes, 'lector': leer_frances},
    'FRANCESUSD': {'carpeta': 'RSM FRANCES DOLARES', 'patrones': _por_mes, 'lector': leer_frances},
    'NACION': {'carpeta': 'RSM NACION', 'patrones': _por_mes, 'lector': leer_nacion},
    'RIO': {'carpeta': 'RSM RIO', 'patrones': _por_mes, 'lector': leer_rio},
    'SANTAFE': {'carpeta': 'RSM NBSF', 'lector': leer_santafe,
                'patrones': lambda mes, anio: [f'{MESES[mes - 1]} {anio}.pdf',
                                               f'*QUINCENA {MESES[mes - 1]} {anio}.pdf']},
}


def resumenes(nombre, base, mes, anio):
    """PDF del resumen de ese banco y mes (puede ser más de uno, p. ej. por quincena)."""
    carpeta = base / BANCOS[nombre]['carpeta']
    if not carpeta.is_dir():
        return []
    patrones = [p.upper() for p in BANCOS[nombre]['patrones'](mes, anio)]
    return sorted((f for f in carpeta.iterdir()
                   if any(fnmatchcase(f.name.upper(), p) for p in patrones)),
                  key=lambda f: f.name.upper())


def leer_resumen(nombre, base, mes, anio):
    """Lee el o los PDF del mes y los une. Devuelve (info, movimientos) o None si no hay PDF."""
    fs = resumenes(nombre, base, mes, anio)
    if not fs:
        return None
    partes = sorted((BANCOS[nombre]['lector'](f, mes, anio) for f in fs),
                    key=lambda p: p[1][0]['fecha'] if p[1] else date.min)
    info, movs = dict(partes[0][0]), list(partes[0][1])
    for i, m in partes[1:]:
        if abs(i['saldo_inicial'] - info['saldo_final']) > 0.005:
            raise ErrorLectura(f'{nombre}: los resúmenes del mes no son consecutivos '
                               f"(uno termina en {info['saldo_final']:,.2f} y el siguiente empieza en "
                               f"{i['saldo_inicial']:,.2f}).")
        info['saldo_final'] = i['saldo_final']
        movs += m
    # el resumen puede traer movimientos del mes siguiente (cierre de quincena el día 1)
    fin_mes = date(anio + (mes == 12), mes % 12 + 1, 1)
    sobran = [m for m in movs if m['fecha'] >= fin_mes]
    if sobran:
        movs = [m for m in movs if m['fecha'] < fin_mes]
        info['saldo_final'] = round(info['saldo_final'] - sum(m['importe'] for m in sobran), 2)
    return info, movs
