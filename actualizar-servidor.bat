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
echo Listo. Si el servidor esta corriendo, cerra esa ventana y volve a
echo iniciarlo con iniciar-servidor.bat para que tome los cambios.
pause
