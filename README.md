# InstructivosMutual

Plataforma interna de la mutual: login + preguntas frecuentes por módulo.

## Requisitos

- Node.js (versión LTS)
- SQL Server accesible (local o en red)

## Instalación

```bash
git clone https://github.com/jonatanquiro/InstructivosMutual.git
cd InstructivosMutual
npm install
```

Copiar `.env.example` a `.env` y completar con los valores reales (usuario, contraseña y datos de conexión de SQL Server):

```bash
cp .env.example .env
```

## Uso

```bash
npm start        # producción
npm run dev      # desarrollo, reinicia solo al guardar cambios
```

El servidor levanta en el puerto definido en `.env` (por defecto `3000`).

## Documentación

- [Funcionamiento general de la app](docs/funcionamiento-general.md)
- [Documentación técnica por carpetas](docs/documentacion-tecnica.md)

## Notas

- `.env` nunca se sube a git (contiene credenciales).
- `node_modules` tampoco se sube; se regenera con `npm install`.
- Antes de empezar a trabajar en cualquier PC, hacer `git pull` para traer los últimos cambios.
