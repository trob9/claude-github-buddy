# GitHub Buddy Server - Status Check (Windows)
# Mirrors launchers/server_status.command (macOS).

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir  = Join-Path $ProjectDir 'server'
$PidFile    = Join-Path $ServerDir 'server.pid'
$envFile    = Join-Path $ProjectDir '.env'

# Ports default to the extension's (47382/47383); honour .env overrides.
$HttpPort = 47382
$WsPort = 47383
if (Test-Path $envFile) {
    $h = Select-String -Path $envFile -Pattern '^HTTP_PORT=' | Select-Object -First 1
    if ($h) { $v = ($h.Line -replace '^HTTP_PORT=', '').Trim(); if ($v -match '^\d+$') { $HttpPort = [int]$v } }
    $w = Select-String -Path $envFile -Pattern '^WS_PORT=' | Select-Object -First 1
    if ($w) { $v = ($w.Line -replace '^WS_PORT=', '').Trim(); if ($v -match '^\d+$') { $WsPort = [int]$v } }
}

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
foreach ($port in $HttpPort, $WsPort) {
    $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) { Write-Host "  Port $port in use" } else { Write-Host "  Port $port free" }
}
