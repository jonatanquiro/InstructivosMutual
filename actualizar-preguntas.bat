@echo off
cd /d "%~dp0"
echo Actualizando preguntas frecuentes desde scripts\datos\preguntas.json...
call node scripts\cargar-preguntas.js
pause
