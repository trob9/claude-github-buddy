# GitHub Buddy Server - Status Check (Windows)
# Mirrors launchers/server_status.command (macOS).

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir  = Join-Path $ProjectDir 'server'
$PidFile    = Join-Path $ServerDir 'server.pid'

Write-Host "GitHub Buddy Server Status"
Write-Host "=========================="

if (Test-Path $PidFile) {
    $serverPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $proc = if ($serverPid) { Get-Process -Id $serverPid -ErrorAction SilentlyContinue } else { $null }
    if ($proc) {
        Write-Host "Server is RUNNING (PID: $serverPid)" -ForegroundColor Green
        Write-Host ""
        Write-Host "Process details:"
        $proc | Select-Object Id, StartTime, Path | Format-List
    } else {
        Write-Host "Server is NOT running (stale PID file)" -ForegroundColor Red
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "Server is NOT running (no PID file)" -ForegroundColor Red
}

Write-Host ""
Write-Host "Port check:"
foreach ($port in 13030, 13031) {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) { Write-Host "  Port $port in use" } else { Write-Host "  Port $port free" }
}
