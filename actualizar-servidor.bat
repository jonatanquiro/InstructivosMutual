@echo off
cd /d "%~dp0"
echo Actualizando InstructivosMutual desde GitHub...
echo.
git pull
if errorlevel 1 (
  echo.
  echo Hubo un problema haciendo git pull ^(mensaje arriba^). No se actualizo nada mas.
  pause
  exit /b 1
)

echo.
echo Instalando/actualizando dependencias...
call npm install

echo.
echo Instalando librerias de Python ^(las usa la conciliacion bancaria para leer los PDF^)...
where python >nul 2>nul
if errorlevel 1 (
  echo ATENCION: Python no esta instalado en este equipo. La conciliacion bancaria
  echo no va a poder leer los PDF hasta instalarlo ^(python.org, tildar "Add to PATH"^)
  echo y volver a correr este archivo.
) else (
  call python -m pip install -r motor\requirements.txt
)

echo.
echo Listo. Si el servidor esta corriendo, cerra esa ventana y volve a
echo iniciarlo con iniciar-servidor.bat para que tome los cambios.
pause
