#!/usr/bin/env bash
# 构建 Win7(32/64 位) ~ Win11 通用的启动 EXE（32 位静态二进制，WoW64 下兼容 64 位系统）
# 用法：bash tools/build-launcher.sh [输出目录，默认仓库根目录]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.}"
# 输出转绝对路径（下面要 cd 到 launcher 目录内构建）
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
mkdir -p "$OUT"
VER="$(git describe --tags --always 2>/dev/null || echo dev)"
# ---- 资源段（EXE 图标 + 清单）：rsrc 可用时自动嵌入 ----
SYSO="tools/launcher/rsrc_windows_386.syso"
# rsrc 通常由 go install 装到 ~/go/bin（一般不在 PATH），与 build-launcher.ps1 的查找顺序对齐
RSRC="$(command -v rsrc 2>/dev/null || true)"
if [ -z "$RSRC" ] && [ -x "$HOME/go/bin/rsrc" ]; then
  RSRC="$HOME/go/bin/rsrc"
fi
if [ "${NO_ICON:-0}" = "1" ]; then
  rm -f "$SYSO"
elif [ -n "$RSRC" ]; then
  "$RSRC" -arch 386 -ico assets/app-icon.ico -manifest tools/launcher/app.manifest -o "$SYSO"
  echo "icon    : assets/app-icon.ico -> $SYSO"
else
  rm -f "$SYSO"
  echo "warning : rsrc 未安装（go install github.com/akavel/rsrc@latest），本次构建不含 EXE 图标"
fi
# CGO_ENABLED=0 → 纯静态、不依赖 MinGW 运行时；GOARCH=386 → Win7 32/64 位与 Win11 通吃
( cd tools/launcher && CGO_ENABLED=0 GOOS=windows GOARCH=386 go build \
    -trimpath -ldflags="-s -w -X main.buildVersion=${VER}" \
    -o "${OUT}/启动工具.exe" . )
echo "built: ${OUT}/启动工具.exe"
