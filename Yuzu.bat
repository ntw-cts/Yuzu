@echo off
title YUZU
color 0A

echo.
echo  ==============================
echo    Y U Z U  ^|  Anime Player
echo  ==============================
echo.
echo  Starting server on localhost:4000...
echo.

cd /d "D:\AnimepaheApi-main"

set PORT=4000

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:4000"

echo  Server is running. Keep this window open while watching.
echo  Close this window to stop the server.
echo.
echo  Press Ctrl+C to stop.
echo.

node index.js
