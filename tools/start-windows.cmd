@echo off
rem Starts the local server (once) and opens Halcyon Type in Chrome as an app window.
cd /d "%~dp0.."
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 8137 -State Listen -ErrorAction SilentlyContinue)) { Start-Process python -ArgumentList 'tools\serve.py' -WindowStyle Hidden; Start-Sleep -Milliseconds 800 }"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (start "" "%CHROME%" --app=http://localhost:8137/) else (start "" http://localhost:8137/)
