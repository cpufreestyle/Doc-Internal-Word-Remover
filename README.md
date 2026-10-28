# 文档敏感词批量清除工具

> michaelqiu 出品

一个纯本地运行的文档扫描与脱敏工具，支持 Word、Excel、PowerPoint 和常见文本文件。文件不会上传到服务器，网页端与命令行都可离线使用。

## 能做什么

- 批量扫描文件夹、磁盘或报告清单，定位文档中的密级标识、敏感词和个人信息。
- 按首行、尾行或全文清除命中内容，支持删除、智能打码和自定义替换。
- 直接处理 OOXML 文档，包括正文、页眉页脚、批注、修订、图表缓存、文档属性和内嵌 Office 文件。
- 预览命中位置，处理后复查残留，并导出 JSON、CSV 或 HTML 报告。
- 为批量结果提供筛选、连选、误报复核和人工复核清单。
- 导入 JSON 清单、通用检查报告的 HTML 表格或纯路径清单后继续处理。

## 快速开始

### Windows

1. 解压发布包。
2. 双击 `启动工具.exe`，或运行 `Start.bat`。
3. 浏览器打开 `http://127.0.0.1:8080/index.html`。

也可以直接用 Chrome 或 Edge 打开 `index.html`。

### Linux / UOS

```bash
bash Start.sh
```

启动脚本只监听 `127.0.0.1`，局域网中的其他设备无法访问本地服务。

## 新增能力速览

界面支持文件夹扫描、文件名关键字、区分大小写、扫描结果筛选、人工复核清单、批量删除和脱敏。主要按钮、标签和选项均带有悬停说明。

当前 `index.html` 的 147 处解释和由脚本动态生成的 11 处说明都带键盘焦点样式。默认词库扩到 38 词，`npm test` 一次跑完全部 9 套测试。

命令行提供以下参数：

- 扫描：`--dir`、`--drive`、`--depth`、`--limit`、`--ext`、`--all-ext`、`--docs-only`
- 筛选：`--words`、`--whole`、`--scope`、`--name-words`、`--name-mode`、`--case-sensitive`、`--exclude`、`--exclude-ctx`
- 报告：`--json`、`--report`、`--html`
- 处理：`--clean`、`--out`、`--root`、`--in-place`、`--action`、`--custom`、`--delete`、`--delete-dry-run`
- 选择结果：`--from-report`、`--pick`、`--pick-word`、`--pick-dir`、`--pick-list`
- 安全控制：`--authorized-root`、`--confirm-delete`、`--allow-network-paths`、`--confirm-network-paths`
- 其他：`--move-to`、`--move-dry-run`、`--shard`、`--concurrency`、`--max-file-mb`、`--no-skip-system`、`--verify`

## 按报告处理

报告属于外部输入。命令行会用 `--authorized-root` 限定报告可以触碰的目录：

```bash
node scan.mjs --from-report report.json \
  --authorized-root "D:\资料" \
  --out cleaned
```

就地脱敏：

```bash
node scan.mjs --from-report report.json \
  --authorized-root "D:\资料" \
  --in-place
```

删除默认只演练。确认清单无误后再显式加上确认开关：

```bash
node scan.mjs --from-report report.json \
  --authorized-root "D:\资料" \
  --delete --confirm-delete
```

网络路径默认拒绝。确需处理时，必须同时提供 `--allow-network-paths` 与 `--confirm-network-paths`。

## 支持的格式

- Word：`docx`、`docm`、`dotx`、`dotm`
- Excel：`xlsx`、`xlsm`、`xltx`、`xltm`
- PowerPoint：`pptx`、`pptm`、`potx`、`potm`、`ppsx`、`ppsm`
- 文本：`txt`、`md`、`csv`、`tsv`、`json`、`xml`、`html`、`log`、`ini`、`yaml`、`sql` 及常见源码文件

旧版二进制 `doc`、`xls`、`ppt` 和 PDF 需要先另存为受支持的 OOXML 或文本格式。

## 本地性与安全边界

- 网页资源没有外部依赖，文件处理在浏览器内完成。
- 启动脚本显式绑定回环地址 `127.0.0.1`。
- 报告派生路径会解析真实路径，并拒绝授权根之外的路径、路径前缀碰撞和符号链接越界。
- ZIP 解压、条目数量、内嵌文档深度、累计大小和解析时限均有上限。
- 扫描报告可能包含真实路径，处理完成后应妥善保存或删除。

安全问题请通过仓库的私下安全渠道报告，不要在公开 issue 中附带真实文档或检查报告。

## 开发与测试

需要 Node.js 18 或更高版本。

```bash
npm test
node test-e2e.mjs
```

`npm test` 覆盖格式处理、规则匹配、报告解析、并发、界面逻辑和安全边界。Playwright 冒烟测试需要 Chromium。

版本变更见 `CHANGELOG.md（1 条版本记录）`。

## 许可

MIT License。Copyright (c) 2026 cpufreestyle (michaelqiu)。
