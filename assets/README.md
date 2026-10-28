# 应用图标

图形是「苹果 squircle 底板 + 三张错位叠放的文档 + 被划掉的敏感词 + 右下角对勾」：纸叠表示批量处理，
红线示意被清除的敏感词，绿色对勾表示核对干净。同一枚图标的三种形态，改图标只需改生成脚本再重新导出。

纸面几何集中在 `make-icon.mjs` 顶部的 SHEET / BACK / BARS / STRIKE / BADGE 常量。后两张纸只从左边与
左下露出边缘（偏移为负 dx、正 dy），斜角处才不会露成毛边；整叠倾斜 6°，白线宽 24、与红条交叉约 17°。
折角是从矩形右上角顶点连到折线的那个三角，别填成另一半（填反了是直角在折线处的三角形，看着像缺角）。
几何按 16px 下的可读性定过一轮（v2.93）：纸叠落在画布左中部、绿勾白圈半径 176 / 绿圈 158、对勾线宽 61。
改完先跑 `node assets/make-icon.mjs --sheet` 看 16 / 24 / 32px 对照图，别只在大图上确认。

| 文件 | 用途 |
|------|------|
| `app-icon.svg` | 矢量源文件；网页站点图标（favicon）与页眉标识直接用这个文件 |
| `app-icon.png` | 1024×1024 位图；文档与商店展示用 |
| `app-icon.ico` | 16/24/32/48/64/128/256 七档多尺寸；Windows 启动器 EXE 的程序图标 |
| `make-icon.mjs` | 图标生成脚本：几何生成 squircle 底板，写出 SVG 并渲染 1024 PNG |
| `make-icon.py` | 由 PNG 导出七档 `app-icon.ico`（Pillow） |

Linux（UOS / 统信）桌面快捷方式通过 `文档敏感词清除工具.desktop` 里的 `Icon=app-icon` 引用；
图标安装到 `~/.local/share/icons/hicolor/256x256/apps/app-icon.png` 后即可显示。

## 重新生成 SVG / PNG / ICO

改图标只改 `make-icon.mjs` 里的几何参数或配色，然后依次执行：

```bash
node assets/make-icon.mjs     # 生成 app-icon.svg，并用 Chromium 渲染出 app-icon.png（1024×1024 透明底）
node assets/make-icon.mjs --sheet   # 同上，额外在系统临时目录输出 16~64px 小尺寸对照图
node assets/make-icon.mjs --svg-only # 只写 SVG，不需要 Chromium
python assets/make-icon.py    # 由 app-icon.png 导出七档 app-icon.ico
```

`make-icon.mjs` 的圆角用「按弧长等分取点 + Catmull-Rom 转三次贝塞尔」逼近超椭圆（指数 n=5），
纯几何生成、结果确定，不依赖手工调锚点。渲染需要 Playwright 的 Chromium（本仓库 `node_modules/playwright` 已含），
只想看 SVG 而本机没有 Chromium 时加 `--svg-only`；`make-icon.py` 需要 Pillow（`pip install pillow`）。

导出后重启一次浏览器可刷新 favicon 缓存。

## Linux（UOS / 统信 / Deepin）安装桌面图标

`文档敏感词清除工具.desktop` 里写的是 `Icon=app-icon`（按名字在系统图标主题里查找），
所以解压后需要先把图标装进 hicolor 主题，快捷方式才会显示图标：

```bash
# 在当前解压目录执行
install -Dm644 assets/app-icon.png ~/.local/share/icons/hicolor/256x256/apps/app-icon.png
update-desktop-database ~/.local/share/icons/hicolor 2>/dev/null || true
# 刷新桌面数据库后，双击 .desktop 即可看到图标
```

只对当前用户生效，不需要 root。装完若图标仍未刷新，注销重登录一次即可。

## Windows 启动器 EXE 的图标

EXE、任务栏与资源管理器的图标由构建脚本自动嵌入：`tools/build-launcher.ps1`（Windows）
或 `tools/build-launcher.sh`（Linux / macOS）会调用 `rsrc`，把 `app-icon.ico` 与
`tools/launcher/app.manifest` 写成 `rsrc_windows_386.syso` 交给 `go build` 链接。
缺少 `rsrc` 时构建照常进行，只是不含 EXE 图标（安装：`go install github.com/akavel/rsrc@latest`）。

换图标后重跑一次构建脚本即可让 EXE 显示新图标：

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-launcher.ps1
```
