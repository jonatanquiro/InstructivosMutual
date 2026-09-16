@echo off
cd /d "%~dp0"
echo Este script borra TODOS los mensajes, chats privados y grupos del chat
echo de la instancia de TESTEO (.env.test). No se puede deshacer.
echo Va a pedir confirmacion antes de borrar.
echo.
set ENV_FILE=.env.test
call node scripts\vaciar-chat.js
pause
