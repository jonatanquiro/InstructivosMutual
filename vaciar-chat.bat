@echo off
cd /d "%~dp0"
echo Este script borra TODOS los mensajes, chats privados y grupos del chat
echo (produccion, .env). No se puede deshacer. Va a pedir confirmacion.
echo.
call node scripts\vaciar-chat.js
pause
