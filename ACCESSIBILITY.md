# 无障碍声明

本工具按 WCAG 2.1 AA 目标构建，以下为实测符合项（截至 v4.12）。

## 知觉（Perceivable）

- **对比度**：浅 / 深两主题全部前景色过 AA（`test-app.mjs` 有像素级回归，见 `ct-*` 组用例）；
- **读屏播报**：处理日志 `role="log" aria-live="polite"`、进度条 `role="progressbar"` 带动态 `aria-valuenow` 服务到读屏（v4.26 固化为 `v426-*` 门禁）；
- **表单名称**：全部输入框 / 表头有可访问名称（v2.62 实测 `inputNoLabel` 8 → 0，13 个 `<th>` 全带 `scope`；全量门禁见 `a11y-*` 组）；
  复核清单 24 个单选按钮在 v4.12 补上 `aria-label`（v4.8 加入时漏了，读屏只能念「单选按钮」），
  实测 `named_radios` 0 → 24。

## 可操作（Operable）

- **键盘可达**：74 个 Tab 停靠点全走查无隐藏焦点陷阱（2026-10-05 实测，Playwright）；
- **焦点可见**：`:focus-visible` 焦点环跨主题可见（v2.74 修复 17 处结构缺陷后阈值 `rgba(0,122,255,.45) 0 0 0 3px`）；
- **快捷键**：Ctrl+Enter 处理、Shift 连选、Ctrl/⌘+A 全选、Delete 删除选中、Esc 关闭词库编辑态与「更多」浮层并归还焦点；
- **目标尺寸**：可操作目标符合 WCAG 2.5.8（目标尺寸最小，AA）。判定口径二选一：
  目标本身 ≥ 24×24，或以目标中心为圆心、24px 为直径的圆不与其它目标相交。
  实测 80 个可交互控件全部通过（v4.22，Playwright）。两处刻意设定：
  - 词条复选框视觉是 14px 方块，命中区 24×24（`appearance:none` + 5px 透明 border 撑盒）。
    原生 checkbox 在 `appearance:auto` 下会忽略 border/padding，所以必须自绘；
    命中区用绝对定位溢出到 chip 外，否则 chip 会从 26px 被撑到 38px。
  - 相邻的开关 label 高 20px，上下间距取 10px（`--sp-2` 的 8px 不够，差 2px）。
  以上口径已固化为 `test-app.mjs` 的 `v422-*` 门禁。

## 易懂（Understandable）

- **悬停解释**：100+ 处 `data-tip` 定制气泡，**禁用的按钮也能弹**（v2.80 修复原 `title` 在 disabled 上不触发的问题）；
- **空态说明**：筛选空态区分「没有符合条件的文件」与「还有 N 个文件未扫描」，不只甩一句没有结果；
- **危险操作**：「自行输出」与「永久删除」有红色告警，与普通操作区分。

## 稳健（Robust）

- 语言标记 `lang="zh-CN"`，标题层级起点唯一（v4.26 固化为 `v426-*` 门禁）；
- 单选组带 `role="radiogroup"` + `aria-labelledby`（3 个具名组读屏可定位）；
  复核清单 8 项各为 `role="group"` + 具名 `role="radiogroup"`，radio 的 `aria-label` 形如
  「所有待外发文件已准确标明密级：符合」（v4.12）；
- 状态变化走 `role="status"` / `aria-live`，不依赖-only 视觉提示（如「已复制 ✓」同时伴随文案变化）。

## 已知 lParam

- 图标内的密级意象（纸+红划线+对勾）依赖 `alt` 简述，复杂语义靠周边文字补充；
- 复杂表格内嵌 Word / Excel 的命中信息主要靠文本，读屏顺序依赖 DOM 顺序，暂不做复杂矩阵语义。

## 反馈

读屏 / 键盘走查若发现遗漏，欢迎在 issue 里说明使用的读屏软件（NVDA / JAWS / VoiceOver）和步骤，修法优先解决「操作可达」与「状态可感知」。
