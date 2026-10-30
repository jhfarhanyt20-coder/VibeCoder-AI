@echo off
setlocal
cd /d "%~dp0"
echo.
echo === VibeCoder AI: install, test, and build Windows installer ===
echo.
call npm ci
if errorlevel 1 goto :failed
call npm test
if errorlevel 1 goto :failed
call npm run dist
if errorlevel 1 goto :failed
echo.
echo SUCCESS: tests passed and the Windows installer build completed.
echo Check the release\ folder for the installer.
pause
exit /b 0
:failed
echo.
echo FAILED: see the command output above. The installer was not confirmed.
pause
exit /b 1
