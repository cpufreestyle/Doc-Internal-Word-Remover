# 参与贡献

感谢关注这个工具。开始之前请先读一遍 [README.md](README.md) 和 [SECURITY.md](SECURITY.md)。

## 项目约束

1. **零运行时依赖**——`package.json` 不得出现 `dependencies`；脚本与运行时均使用浏览器 / Node 原生能力（`CompressionStream`、`showDirectoryPicker`、原生 ZIP 等）。
2. **数据不出本机**——任何改动不得新增网络请求。CSP 也在约束这一点。
3. **不要改 `.gitattributes` 的行尾策略**——源码 LF、批处理 CRLF 是刻意设定。
4. **所有改动先跑测试**：

   ```bash
   npm test          # 9 套引擎/UI/安全回归，任一失败不可合并
   ```

   若改 `js/app.js` 同时要跑 Playwright 浏览器冒烟：`BASE_URL=http://127.0.0.1:8091/index.html node test-e2e.mjs`。
   （v4.19 起该文件也会加载 _e2e_new.mjs，覆盖复核清单 / 文件名关键字 / 区分大小写；
     只改命令行 scan.mjs 时不必跑浏览器冒烟。）

## 提交规范

格式：`类型(范围): 描述（v版本号）`，与仓库现有历史一致。例如：

- `feat(ui): 扫描结果表多选与文件列表行为对齐（v2.0.0）`
- `fix(ui): UI 打磨与便捷性修复（v1.7.0）`

类型：`feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore`。

## 新增功能

1. `js/engine` 改动（`zip.js` / `rules.js` / `ooxml.js`）必须在对应测试套里补用例：
   - 覆盖度类改动 → `test-coverage.mjs`；
   - 规避 / 排除 / 整词语义 → `test-rules.mjs`；
   - 新的 Office 部件 → `test-allparts.mjs`。
2. UI 改动补 `test-app.mjs`（无头 DOM 桩），关键交互另跑 Playwright 冒烟。
3. 安全边界改动补 `test-security.mjs`。
4. 版本号递增，并在 [CHANGELOG.md](CHANGELOG.md) 同步记录变更与验证结果。

## 什么会拒绝合并

- 引入任何第三方运行时依赖；
- 新增网络请求或把数据带出本地；
- 破坏 `firstlast` 范围语义（首尾清除、中段保留是产品核心承诺）；
- 回归测试标红或只改文档不跑测试。
