@echo off
chcp 65001 >nul
title 文档敏感词批量清除工具
echo ========================================
echo   文档敏感词批量清除工具 - 本地服务器
echo ========================================
  echo.

:: 自动探测可用端口（从 8080 起，若被占用则顺延），避免与已运行服务冲突
set PORT=8080
:findport
netstat -ano 2>nul | findstr /r ":%PORT% " >nul 2>nul
if %errorlevel%==0 (
  set /a PORT+=1
  if %PORT% gtr 8099 (
    echo 8080-8099 端口均被占用，请手动释放后重试。
    pause
    exit /b 1
  )
  goto findport
)

where python >nul 2>nul
if %errorlevel%==0 (
  python -c "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)" >nul 2>nul
  if not errorlevel 1 (
    echo 检测到 Python 3，正在 http://127.0.0.1:%PORT% 启动服务...
    start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/index.html'"
    python -m http.server %PORT% --bind 127.0.0.1
    goto server_exit
  )
)

where npx >nul 2>nul
if %errorlevel%==0 (
  echo 检测到 Node.js，正在 http://127.0.0.1:%PORT% 启动服务...
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/index.html'"
  npx --yes serve -l tcp://127.0.0.1:%PORT% .
  goto server_exit
)

echo 未检测到 Python 3 或 Node.js。
echo 请安装其一后再运行本脚本，或直接用 Chrome / Edge 打开 index.html。
pause
exit /b 1

:server_exit
echo.
echo 本地服务已停止。
pause
