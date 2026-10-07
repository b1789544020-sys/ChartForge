@echo off
setlocal
if not exist "C:\Users\86159\Desktop\ChartForge\tools\logs" mkdir "C:\Users\86159\Desktop\ChartForge\tools\logs"
cd /d C:\Users\86159\Desktop\ChartForge
rem Use a wrapper cmd to redirect output (start /B does not pass redirections reliably)
start "ChartForge Server" /B cmd /c "python -m http.server 8123 > C:\Users\86159\Desktop\ChartForge\tools\logs\server.out 2> C:\Users\86159\Desktop\ChartForge\tools\logs\server.err"
echo Server launched.
ping -n 3 127.0.0.1 -n 1 >nul
echo.
echo PID listening on 8123:
for /f "tokens=5" %%P in ('netstat -ano ^| findstr :8123 ^| findstr LISTENING') do echo   PID %%P
endlocal