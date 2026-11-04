"""Lee la planilla de control de préstamos (CONTROL PRÉSTAMOS.xlsx) para la
pestaña Préstamos de INFORMAMUTUAL.

La planilla es una hoja por mes, cargada a mano: el encabezado no siempre está
en la misma fila, las columnas cambian un poco entre hojas y el estado de cada
solicitud (aprobado, rechazado, se pide garantía...) no tiene columna propia,
sino que está escrito en COMENTARIOS o en FECHA DE LIQ. Este script junta todas
las hojas en una sola lista y deduce el estado y el motivo de rechazo del texto.

Uso:
  python prestamos.py --archivo "F:\\Textos\\CONTROL PRÉSTAMOS.xlsx"

Devuelve JSON por la salida estándar. Si el archivo no se puede leer devuelve
{"ok": false, "error": "..."} con código 0 (es un resultado esperable).
"""
import argparse
import json
import re
import sys
import unicodedata
import zipfile
from collections import Counter
from datetime import date, datetime, time
from pathlib import Path

import openpyxl
from openpyxl.utils.exceptions import InvalidFileException

MESES = {'ENERO': 1, 'FEBRERO': 2, 'MARZO': 3, 'ABRIL': 4, 'MAYO': 5, 'JUNIO': 6, 'JULIO': 7,
         'AGOSTO': 8, 'SEPTIEMBRE': 9, 'SETIEMBRE': 9, 'OCTUBRE': 10, 'NOVIEMBRE': 11, 'DICIEMBRE': 12}

# Encabezado normalizado -> clave. Las hojas viejas dicen "FECHA DE LIQUIDACION"
# y las nuevas "FECHA DE LIQ."; la de octubre 2024 tiene además "OTORGADO".
COLUMNAS = {
    'FECHA': 'fecha', 'SOCIO': 'socio', 'CONYUGE': 'conyuge', 'GARANTIA': 'garantia',
    'IMPORTE': 'importe', 'PLAZO': 'plazo', 'FECHA DE LIQ.': 'fechaLiq',
    'FECHA DE LIQUIDACION': 'fechaLiq', 'FORMA DE PAGO': 'formaPago', 'VENDIDO POR': 'vendedor',
    'COMENTARIOS': 'comentarios', 'OBSERVACION': 'observacion', 'ESTADO': 'estadoPlanilla',
    'ENVIADO A ARCHIVO': 'enviadoArchivo', 'OTORGADO': 'otorgado',
}

# Apodos y variantes con que se carga el mismo vendedor.
VENDEDORES = {'wali': 'Walter', 'walli': 'Walter', 'waly': 'Walter', 'mirian': 'Miriam',
              'refinanciacion': '(Refinanciación)'}

# Motivo de rechazo -> palabras que lo delatan (sobre texto sin tildes y en minúscula).
MOTIVOS = [
    ('Rojo / informado en otras entidades', r'rojo|informad|fast ?cred|finan ?ya|naranja|credixa|megatone|'
                                            r'credife|mercado libre|bazar|atrasad|bco\.|banco|m\. libertad|'
                                            r'sit\. ?\d|afectad|afectaci|recupero'),
    ('Mal historial de pago / antecedentes', r'antecedente|ancedentes|referencias negativas|historial|'
                                             r'buen cumplimiento|minimo|atraso|refinanciaci'),
    ('Judiciales', r'judicial'),
    ('Endeudamiento / relación cuota-ingreso', r'endeudamiento|cuota/ingreso|relacion cuota'),
    ('Tiene un préstamo vigente', r'(prestamo|uno|refinanciacion) vigente|hasta (que )?no cancele'),
    ('Sin antigüedad', r'antig'),
    ('No es socio', r'no (es )?soci'),
    ('TMU inhabilitada', r'tmu inhabilitada'),
]


def _sin_tildes(texto):
    return ''.join(c for c in unicodedata.normalize('NFD', texto) if unicodedata.category(c) != 'Mn')


def _norm(valor):
    return _sin_tildes(str(valor)).strip().upper() if isinstance(valor, str) else ''


def _texto(valor):
    if valor is None:
        return ''
    if isinstance(valor, datetime):
        return valor.strftime('%d/%m/%Y')
    if isinstance(valor, time):
        return valor.strftime('%H:%M')
    return str(valor).strip()


def _fecha(valor):
    if isinstance(valor, datetime):
        return valor.date().isoformat()
    if isinstance(valor, date):
        return valor.isoformat()
    return None


def _importe(valor):
    if isinstance(valor, (int, float)):
        return float(valor)
    if isinstance(valor, str):
        limpio = re.sub(r'[^\d,]', '', valor).replace(',', '.')
        try:
            return float(limpio) if limpio else None
        except ValueError:
            return None
    return None


def _plazo(valor):
    """(meses, etiqueta). Los préstamos cortos se cargan en días ("15 días")."""
    if isinstance(valor, (int, float)):
        return int(valor), f'{int(valor)} meses'
    texto = _texto(valor)
    if not texto:
        return None, ''
    if texto.isdigit():
        return int(texto), f'{texto} meses'
    return None, texto


def _vendedor(valor):
    texto = _texto(valor)
    if not texto:
        return 'Sin dato'
    # "Walter (Alicia)": vendió Walter, lo vio Alicia.
    texto = texto.split('(')[0].strip() or texto
    clave = _sin_tildes(texto).lower()
    return VENDEDORES.get(clave, texto[:1].upper() + texto[1:].lower())


def _estado(liquidado, texto):
    """Estado deducido. "texto" es todo lo escrito en la fila, sin tildes y en minúscula."""
    if re.search(r'rechaz|rachaz|recahaz', texto):
        return 'Rechazado'
    if liquidado or re.search(r'liquidad[oa]', texto):
        return 'Liquidado'
    if re.search(r'no (lo|se) (van? a )?tom|no se otorga|no respondi|desisti|sin desembolso', texto):
        return 'No lo tomó'
    if 'aprobado' in texto:
        return 'Aprobado sin liquidar'
    if 'garant' in texto or 'se pide' in texto:
        return 'Pide garantía'
    return 'Sin resolución'


def _motivos(texto):
    motivos = [nombre for nombre, patron in MOTIVOS if re.search(patron, texto)]
    if motivos:
        return motivos
    # Algo escrito además de "rechazado" pero que no encaja en ningún motivo conocido.
    resto = re.sub(r'rechazad[oa]s?|[^a-z]', '', texto)
    return ['Otro motivo'] if resto else ['Sin motivo escrito']


def _periodo_hoja(nombre, fechas):
    """(año, mes) de la hoja. Las primeras no tienen año en el nombre ("OCTUBRE"):
    se toma el de las fechas cargadas en la hoja."""
    partes = _norm(nombre).split()
    mes = MESES.get(partes[0]) if partes else None
    anio = int(partes[1]) if len(partes) > 1 and partes[1].isdigit() else None
    if mes and anio:
        return anio, mes
    if mes:
        anios = Counter(f.year for f in fechas if f.month == mes)
        return (anios.most_common(1)[0][0] if anios else None), mes
    candidatos = Counter((f.year, f.month) for f in fechas)
    return candidatos.most_common(1)[0][0] if candidatos else (None, None)


def leer_hoja(hoja):
    filas = list(hoja.iter_rows(values_only=True))
    fila_titulos = next((i for i, f in enumerate(filas) if any(_norm(c) == 'SOCIO' for c in f)), None)
    if fila_titulos is None:
        return None, []

    indices = {}
    for i, titulo in enumerate(filas[fila_titulos]):
        clave = COLUMNAS.get(_norm(titulo))
        if clave and clave not in indices:
            indices[clave] = i

    def celda(fila, clave):
        i = indices.get(clave)
        return fila[i] if i is not None and i < len(fila) else None

    registros = []
    for numero, fila in enumerate(filas[fila_titulos + 1:], start=fila_titulos + 2):
        socio = _texto(celda(fila, 'socio'))
        # Sin socio son totales o notas sueltas al pie de la hoja.
        if not socio:
            continue
        fecha_liq = celda(fila, 'fechaLiq')
        liquidado = isinstance(fecha_liq, (datetime, date)) or isinstance(celda(fila, 'otorgado'), (datetime, date))
        comentarios = ' — '.join(t for t in (_texto(celda(fila, 'comentarios')),
                                             _texto(celda(fila, 'observacion')),
                                             _texto(celda(fila, 'estadoPlanilla'))) if t)
        forma_pago = _texto(celda(fila, 'formaPago'))
        todo = _sin_tildes(' '.join([comentarios, forma_pago, _texto(fecha_liq),
                                     _texto(celda(fila, 'otorgado'))])).lower()
        estado = _estado(liquidado, todo)
        meses, plazo = _plazo(celda(fila, 'plazo'))
        registros.append({
            'fila': numero,
            'fecha': _fecha(celda(fila, 'fecha')),
            'socio': socio,
            'conyuge': _texto(celda(fila, 'conyuge')),
            'garantia': '' if _norm(celda(fila, 'garantia')) == 'NO' else _texto(celda(fila, 'garantia')),
            'importe': _importe(celda(fila, 'importe')),
            'plazoMeses': meses,
            'plazo': plazo,
            'fechaLiq': _fecha(fecha_liq),
            'formaPago': forma_pago,
            'vendedor': _vendedor(celda(fila, 'vendedor')),
            'comentarios': comentarios,
            'enviadoArchivo': _fecha(celda(fila, 'enviadoArchivo')),
            'estado': estado,
            'motivos': _motivos(todo) if estado == 'Rechazado' else [],
        })

    fechas = [datetime.fromisoformat(r['fecha']) for r in registros if r['fecha']]
    return _periodo_hoja(hoja.title, fechas), registros


def leer(archivo):
    libro = openpyxl.load_workbook(archivo, data_only=True, read_only=True)
    hojas, solicitudes = [], []
    for hoja in libro.worksheets:
        (anio, mes), registros = leer_hoja(hoja)
        if not registros:
            continue
        periodo = f'{anio}-{mes:02d}' if anio and mes else None
        hojas.append({'nombre': hoja.title.strip(), 'periodo': periodo, 'cantidad': len(registros)})
        for r in registros:
            r['hoja'] = hoja.title.strip()
            r['periodo'] = periodo
        solicitudes.extend(registros)
    libro.close()
    return hojas, solicitudes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archivo', required=True)
    args = parser.parse_args()
    archivo = Path(args.archivo)

    if not archivo.exists():
        resultado = {'ok': False, 'error': f'No se encuentra la planilla en «{archivo}».'}
    else:
        try:
            hojas, solicitudes = leer(archivo)
            resultado = {'ok': True, 'hojas': hojas, 'solicitudes': solicitudes}
        except (zipfile.BadZipFile, InvalidFileException):
            resultado = {'ok': False, 'error': 'El archivo no es una planilla .xlsx válida. Si es un .xls viejo, '
                                               'abrila en Excel y guardala como .xlsx.'}
        except PermissionError:
            resultado = {'ok': False, 'error': 'No se pudo abrir la planilla (¿sin permiso de lectura?).'}
        except Exception as error:  # planilla rota o con un formato inesperado
            resultado = {'ok': False, 'error': f'No se pudo leer la planilla: {error}'}

    sys.stdout.reconfigure(encoding='utf-8')
    json.dump(resultado, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
