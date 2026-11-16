# 第三方组件声明（assets/ocr）

本目录随包分发 OCR 所需的第三方文件，全部为**原样收录、未做修改**。
本项目自身代码为 MIT；下列组件各自保留其原有许可。

## tesseract.js

- 文件：`tesseract.min.js`、`worker.min.js`
- 版本：7.x（见 `package.json` 的 devDependencies）
- 许可：Apache License 2.0 —— 全文见 `LICENSE-tesseract.js.txt`
- 上游：https://github.com/naptha/tesseract.js
- 打包进这两个压缩文件里的第三方片段，版权声明保留在：
  - `tesseract.min.js.LICENSE.txt`（regenerator-runtime，MIT）
  - `worker.min.js.LICENSE.txt`（buffer / ieee754 / regenerator-runtime / zlib.js）

## tesseract.js-core

- 文件：`core/tesseract-core-lstm.wasm.js`、`core/tesseract-core-simd-lstm.wasm.js`
- 版本：6.x（见 `package.json` 的 devDependencies）
- 许可：Apache License 2.0 —— 全文见 `LICENSE-tesseract.js-core.txt`
- 上游：https://github.com/naptha/tesseract.js-core

## Tesseract 语言数据（tessdata_fast）

- 文件：`lang/chi_sim.traineddata.gz`、`lang/eng.traineddata.gz`
- 许可：Apache License 2.0
- 上游：https://github.com/tesseract-ocr/tessdata_fast
- 说明：由上游原始 `.traineddata` 直接 gzip 得到，内容未做任何裁剪或训练。

为便于核对来源，压缩前的原始文件 SHA256（与 tessdata_fast 主干一致）：

| 语言 | 原始文件 SHA256 |
| --- | --- |
| chi_sim | `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730` |
| eng | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |

随包压缩文件 SHA256：

| 文件 | SHA256 |
| --- | --- |
| `lang/chi_sim.traineddata.gz` | `6a317f84d100103a0740334e01c3dedbe761a29d946b44a166cb322729094bec` |
| `lang/eng.traineddata.gz` | `b130d16b69e3888bc099133991a50a5b50e1da0e3ff6ca31a5496fab0fb386c3` |
