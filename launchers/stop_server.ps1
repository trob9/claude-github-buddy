# GitHub Buddy Server - Stop Script (Windows)
# Mirrors launchers/stop_server.command (macOS).

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir  = Join-Path $ProjectDir 'server'
$PidFile    = Join-Path $ServerDir 'server.pid'

if (-not (Test-Path $PidFile)) {
    Write-Host "No PID file found. Searching for running 'node server.js' processes..."
    $found = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -match 'server\.js' }
    if ($found) {
        foreach ($p in $found) {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "Stopped server process (PID: $($p.ProcessId))"
        }
    } else {
        Write-Host "No running server found"
    }
    exit 0
}

$serverPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
if ($serverPid -and (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $serverPid -Force
    Write-Host "Stopped server (PID: $serverPid)" -ForegroundColor Green
} else {
    Write-Host "Server not running (stale PID file)"
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
