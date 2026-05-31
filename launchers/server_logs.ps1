# GitHub Buddy Server - Log Viewer (Windows)
# Mirrors launchers/server_logs.command (macOS).
#
# Usage:
#   .\launchers\server_logs.ps1            # last 50 lines
#   .\launchers\server_logs.ps1 100        # last 100 lines
#   .\launchers\server_logs.ps1 -Follow    # live tail

param(
    [int]$Lines = 50,
    [switch]$Follow
)

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$ServerDir  = Join-Path $ProjectDir 'server'
$LogFile    = Join-Path $ServerDir 'server.log'
$ErrFile    = Join-Path $ServerDir 'server.error.log'

if (-not (Test-Path $LogFile)) {
    Write-Host "No log file yet at $LogFile"
    exit 0
}

if ($Follow) {
    Get-Content $LogFile -Tail $Lines -Wait
} else {
    Get-Content $LogFile -Tail $Lines
    if ((Test-Path $ErrFile) -and (Get-Item $ErrFile).Length -gt 0) {
        Write-Host ""
        Write-Host "--- stderr (server.error.log) ---" -ForegroundColor Yellow
        Get-Content $ErrFile -Tail $Lines
    }
}
