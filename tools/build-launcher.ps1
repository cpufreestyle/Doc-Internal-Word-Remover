# 构建 Win7(32/64 位) ~ Win11 通用的启动 EXE（32 位静态二进制，WoW64 下兼容 64 位系统）
# 用法：powershell -ExecutionPolicy Bypass -File tools\build-launcher.ps1 [-OutDir .]
param(
  [string]$OutDir = ".",
  [switch]$NoIcon
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  # ---- 资源段（EXE 图标 + 清单）：rsrc 可用时自动嵌入，缺失则跳过并提示 ----
  $syso = Join-Path $repo "tools\launcher\rsrc_windows_386.syso"
  if ($NoIcon) {
    Remove-Item -LiteralPath $syso -Force -ErrorAction SilentlyContinue
  } else {
    $rsrc = Join-Path $env:USERPROFILE "go\bin\rsrc.exe"
    if (-not (Test-Path $rsrc)) { $rsrc = (Get-Command rsrc -ErrorAction SilentlyContinue).Source }
    if ($rsrc) {
      $rsrcArgs = @("-arch", "386",
        "-ico", (Join-Path $repo "assets\app-icon.ico"),
        "-manifest", (Join-Path $repo "tools\launcher\app.manifest"),
        "-o", $syso)
      & $rsrc @rsrcArgs
      if ($LASTEXITCODE -ne 0) { throw "rsrc failed ($LASTEXITCODE)" }
      Write-Host "icon    : assets/app-icon.ico -> rsrc_windows_386.syso"
    } else {
      Remove-Item -LiteralPath $syso -Force -ErrorAction SilentlyContinue
      Write-Warning "未找到 rsrc（go install github.com/akavel/rsrc@latest），本次构建不含 EXE 图标"
    }
  }
  $ver = (& git describe --tags --always 2>$null)
  if (-not $ver) { $ver = "dev" }
  $env:CGO_ENABLED = "0"
  $env:GOOS = "windows"
  $env:GOARCH = "386"
  $ld = "-s -w -X main.buildVersion=" + $ver
  if (-not [IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $repo $OutDir }
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  Push-Location (Join-Path $repo "tools\launcher")
  try {
    & go build -trimpath -ldflags $ld -o (Join-Path $OutDir "启动工具.exe") .
    if ($LASTEXITCODE -ne 0) { throw "go build failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  Write-Host ("built: " + (Join-Path $OutDir "启动工具.exe"))
} finally {
  Pop-Location
}
