@echo off
REM GitHub Buddy Server - double-click launcher (Windows)
REM Windows equivalent of "Start Server.command" (macOS).

cd /d "%~dp0server"

REM Install dependencies on first run.
if not exist "node_modules" (
    echo Dependencies not found. Installing...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies. Please check your npm configuration.
        pause
        exit /b 1
    )
    echo Dependencies installed successfully.
)

REM Start the server in the foreground. Close this window to stop it.
node server.js

pause
