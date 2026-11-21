@echo off
setlocal
cd /d "%~dp0"
if not exist "%JAVA_HOME%\bin\jpackage.exe" for /f "delims=" %%I in ('where javac.exe 2^>nul') do if exist "%%~dpIjpackage.exe" for %%J in ("%%~dpI..") do set "JAVA_HOME=%%~fJ"
if not exist "%JAVA_HOME%\bin\jpackage.exe" (
  echo Set JAVA_HOME to a 64-bit JDK 21 installation, then try again.
  pause
  exit /b 1
)
echo 1. Portable ZIP - unzip and double-click SlideBranch.exe
echo 2. Setup EXE - requires Inno Setup 6
choice /c 12 /n /m "Choose 1 or 2: "
set "mode="
if errorlevel 2 goto build
set "mode=-Portable"
:build
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0packaging\windows\build.ps1" %mode%
set "result=%errorlevel%"
pause
exit /b %result%
