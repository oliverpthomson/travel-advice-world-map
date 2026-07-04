@echo off
cd /d "%~dp0"
echo Starting Smartraveller Advisory Map on http://localhost:5000 ...
".venv\Scripts\python.exe" "server\app.py"
pause
