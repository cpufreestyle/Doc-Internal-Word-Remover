# Windows right-click integration: add this tool to folder / drive / file context menus.
# Writes HKCU only (current user), no admin rights needed. Use -Uninstall to remove.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\install-context-menu.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-context-menu.ps1 -Uninstall
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$Classes = 'HKCU:\Software\Classes'
$Name = '文档敏感词清除'
$Q = [char]34

$root = Split-Path -Parent $PSScriptRoot
$startBat = Join-Path $root 'Start.bat'
$indexHtml = Join-Path $root 'index.html'
$icon = Join-Path $root 'assets\app-icon.ico'

# Launch entry: prefer the bundled Start.bat, fall back to opening index.html
if (Test-Path -LiteralPath $startBat) {
    $launch = $Q + $startBat + $Q
} else {
    $launch = 'cmd /c start ' + $Q + $Q + ' ' + $Q + $indexHtml + $Q
}

function Remove-Menu($path) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
        Write-Host ('removed: ' + $path)
    }
}

$dirKey = Join-Path $Classes 'Directory\shell\DwrScan'
$drvKey = Join-Path $Classes 'Drive\shell\DwrScan'
$fileKey = Join-Path $Classes '*\shell\DwrOpen'

if ($Uninstall) {
    Remove-Menu $dirKey
    Remove-Menu $drvKey
    Remove-Menu $fileKey
    Write-Host 'context menu entries removed'
    exit 0
}

function Add-Menu($key) {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $Name
    if (Test-Path -LiteralPath $icon) {
        Set-ItemProperty -Path $key -Name 'Icon' -Value $icon
    }
    $cmd = Join-Path $key 'command'
    New-Item -Path $cmd -Force | Out-Null
    Set-ItemProperty -Path $cmd -Name '(default)' -Value $launch
}

Add-Menu $dirKey
Add-Menu $drvKey
Add-Menu $fileKey

Write-Host 'context menu entries installed for current user'
Write-Host ('right-click a folder, drive or file to see: ' + $Name)
