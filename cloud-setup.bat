@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
call :find_bash
if not defined BASHEXE goto :no_bash
"%BASHEXE%" "%~dp0setup-cloud.sh"
goto :done

:no_bash
echo.
echo [Git Bash not found]
echo  This launcher needs Git for Windows. Install it from:
echo      https://git-scm.com/download/win
echo.
pause
exit /b 1

:done
echo.
echo Finished. You can close this window.
pause
exit /b 0

:find_bash
set "BASHEXE="
for %%I in (bash.exe) do if not "%%~$PATH:I"=="" set "BASHEXE=%%~$PATH:I"
if not defined BASHEXE if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASHEXE=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASHEXE if exist "%ProgramW6432%\Git\bin\bash.exe" set "BASHEXE=%ProgramW6432%\Git\bin\bash.exe"
if not defined BASHEXE if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASHEXE=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASHEXE if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASHEXE=%LocalAppData%\Programs\Git\bin\bash.exe"
exit /b 0

