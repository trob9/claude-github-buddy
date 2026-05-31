# GitHub Buddy Server - Daemon Launcher (Windows)
# Starts the server in the background and records its PID + logs.
# Mirrors launchers/start_server_daemon.command (macOS).

$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir  = Join-Path $ProjectDir 'server'

$PidFile = Join-Path $ServerDir 'server.pid'
$LogFile = Join-Path $ServerDir 'server.log'
$ErrFile = Join-Path $ServerDir 'server.error.log'

# Resolve the node binary: prefer NODE_PATH from .env, else node on PATH.
$NodeBin = $null
$envFile = Join-Path $ProjectDir '.env'
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^NODE_PATH=' | Select-Object -First 1
    if ($line) {
        $candidate = ($line.Line -replace '^NODE_PATH=', '').Trim()
        if ($candidate -and (Test-Path $candidate)) { $NodeBin = $candidate }
    }
}
if (-not $NodeBin) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeBin = $cmd.Source }
}
if (-not $NodeBin) {
    Write-Host "[ERROR] Node.js not found. Install it or set NODE_PATH in .env" -ForegroundColor Red
    exit 1
}

# Already running?
if (Test-Path $PidFile) {
    $oldPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        Write-Host "[WARN] Server already running (PID: $oldPid)" -ForegroundColor Yellow
        Write-Host "       Run .\launchers\stop_server.ps1 to stop it first"
        exit 1
    }
}

# Install dependencies on first run.
if (-not (Test-Path (Join-Path $ServerDir 'node_modules'))) {
    Write-Host "Dependencies not found. Installing..."
    Push-Location $ServerDir
    npm install
    Pop-Location
}

Write-Host "Starting GitHub Buddy Server (daemon mode)..."
Write-Host "Using Node.js: $NodeBin"

# Start node directly so the PID we record is the server's own PID (clean kill).
# stdout and stderr go to separate files (Start-Process cannot merge them).
$proc = Start-Process -FilePath $NodeBin `
    -ArgumentList 'server.js' `
    -WorkingDirectory $ServerDir `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile `
    -WindowStyle Hidden `
    -PassThru

$proc.Id | Out-File -FilePath $PidFile -Encoding ascii

Start-Sleep -Seconds 2
if (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue) {
    Write-Host "Server started successfully (PID: $($proc.Id))" -ForegroundColor Green
    Write-Host "HTTP Port: 13030, WebSocket Port: 13031"
    Write-Host "Logs: $LogFile"
    Write-Host ""
    Write-Host "   View logs:  .\launchers\server_logs.ps1"
    Write-Host "   Stop:       .\launchers\stop_server.ps1"
    Write-Host "   Status:     .\launchers\server_status.ps1"
} else {
    Write-Host "Server failed to start. Check logs: $ErrFile" -ForegroundColor Red
    exit 1
}
