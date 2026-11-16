#!/usr/bin/env node
/* 扫描件 PDF 的 OCR 端到端实况验证（需要模型与 tesseract.js，不进 npm test）
 *
 *   node test-scanned-pdf-ocr-live.mjs
 *
 * 为什么单独一个用例：
 *   扫描件 PDF 正文层里没有文字，密级标识只写在整页图上。此前只有两段
 *   分开验证——① OCR 能认出汉字（test-ocr-live.mjs）、② 词库引擎能命中密级词
 *   （同上文件里的引擎自检）。中间最关键的一环没被固定下来：
 *   「扫描件 PDF → 提取整页图 → OCR 识别 → 送进同一套词库引擎 → 判成命中」。
 *   这一环断了，用户勾了「图片文字检查（OCR）」也照样漏检扫描件。
 *
 * 造样本的方式：
 *   1) 用 PowerShell + System.Drawing 画一张含密级词的 JPEG（Windows 才有，
 *      非 Windows 直接 SKIP，不让这个用例卡住别人）。
 *   2) 把 JPEG 塞进一个只有图片、没有文本层的 PDF —— 就是「扫描件」的真实形态。
 *   3) 用仓库里真实的 js/pdf.js + js/ocr.js + js/rules.js 跑完整链路。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + '] ' + String(detail === undefined ? '' : detail)); }
}

let createWorker = null;
try {
  const mod = await import('tesseract.js');
  createWorker = mod.createWorker;
} catch (e) {
  console.log('SKIP [live-扫描件OCR]：未安装 tesseract.js，跳过实况用例');
  process.exit(0);
}

/* ---------- 1. 造一张含密级词的图（JPEG） ---------- */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-scan-pdf-'));
const jpegPath = path.join(tmpDir, 'page.jpg');

function drawScanJpeg() {
  if (process.platform !== 'win32') return false;
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    "$bmp = New-Object System.Drawing.Bitmap 1000,300",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.Clear([System.Drawing.Color]::White)",
    "$f = New-Object System.Drawing.Font('Microsoft YaHei', 64, [System.Drawing.FontStyle]::Bold)",
    "$g.DrawString('内部文件机密', $f, [System.Drawing.Brushes]::Black, 40, 90)",
    "$g.Dispose()",
    "$bmp.Save('" + jpegPath.replace(/\\/g, '\\\\') + "', [System.Drawing.Imaging.ImageFormat]::Jpeg)",
    "$bmp.Dispose()",
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
    return fs.existsSync(jpegPath) && fs.statSync(jpegPath).size > 1000;
  } catch (e) {
    return false;
  }
}

if (!drawScanJpeg()) {
  console.log('SKIP [live-扫描件OCR]：本机画不出样本图（需要 Windows + System.Drawing），跳过实况用例');
  process.exit(0);
}

/* ---------- 2. 把 JPEG 塞进一个「只有图、没有文本层」的 PDF ---------- */
function buildImageOnlyPdf(jpeg, width, height) {
  const content = Buffer.from('q ' + width + ' 0 0 ' + height + ' 0 0 cm /Im0 Do Q', 'latin1');
  const objs = [];
  objs[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1');
  objs[2] = Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1');
  objs[3] = Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + width + ' ' + height + '] ' +
    '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>', 'latin1');
  objs[4] = Buffer.concat([
    Buffer.from('<< /Type /XObject /Subtype /Image /Width ' + width + ' /Height ' + height +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length +
      ' >>\nstream\n', 'latin1'),
    jpeg,
    Buffer.from('\nendstream', 'latin1'),
  ]);
  objs[5] = Buffer.concat([
    Buffer.from('<< /Length ' + content.length + ' >>\nstream\n', 'latin1'),
    content,
    Buffer.from('\nendstream', 'latin1'),
  ]);

  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  let offset = parts[0].length;
  const offsets = [];
  for (let n = 1; n <= 5; n++) {
    offsets[n] = offset;
    const head = Buffer.from(n + ' 0 obj\n', 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    const chunk = Buffer.concat([head, objs[n], tail]);
    parts.push(chunk);
    offset += chunk.length;
  }
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  const tail = Buffer.from(xref + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + offset + '\n%%EOF\n', 'latin1');
  parts.push(tail);
  return Buffer.concat(parts);
}

const jpeg = fs.readFileSync(jpegPath);
const pdfBytes = buildImageOnlyPdf(jpeg, 1000, 300);
const pdfPath = path.join(tmpDir, 'scanned.pdf');
fs.writeFileSync(pdfPath, pdfBytes);

/* ---------- 3. 载入仓库里真实的 pdf.js 与 rules.js ---------- */
function loadModules(files) {
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder, Uint8Array, DataView, Array, Object, String,
    RegExp, Math, JSON, Promise, console,
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

const D = loadModules(['js/zip.js', 'js/rules.js', 'js/pdf.js', 'js/util.js', 'js/ocrsuspect.js']);
const pdfBytesIn = new Uint8Array(pdfBytes);

/* 3.1 先确认它确实是「扫描件」：没有文本层 */
const extracted = D.DWRPdf.extract(pdfBytesIn);
check('扫描件 PDF 没有文本层', !!(extracted && extracted.imageOnly === true),
  'imageOnly=' + (extracted && extracted.imageOnly) + ' chars=' + (extracted && extracted.chars));

/* 3.2 提取整页图 */
const images = D.DWRPdf.extractImages(pdfBytesIn) || [];
check('能从扫描件 PDF 里提取出整页图', images.length === 1 && !!images[0].bytes,
  '图片数 ' + images.length);

/* ---------- 4. 真实 OCR ---------- */
const langPath = path.join(__dirname, 'assets', 'ocr', 'lang');
const worker = await createWorker('chi_sim+eng', 1, { langPath, gzip: true, logger: () => { } });
let ocrText = '';
try {
  for (const img of images) {
    const out = await worker.recognize(img.bytes);
    ocrText += String((out && out.data && out.data.text) || '');
  }
} finally {
  await worker.terminate();
}
const cjk = (ocrText.match(/[\u4e00-\u9fff]/g) || []).length;
check('OCR 识别出扫描件上的汉字', cjk >= 4, '汉字 ' + cjk + ' 个：' + ocrText.replace(/\s+/g, ' ').slice(0, 80));
console.log('  OCR 文本：[' + ocrText.replace(/\s+/g, ' ').trim().slice(0, 120) + ']');

/* ---------- 5. 识别结果送进同一套词库引擎，必须判成命中 ---------- */
const engine = D.DWRRules.createEngine({
  rules: [
    { text: '内部', type: 'word', enabled: true },
    { text: '机密', type: 'word', enabled: true },
    { text: '绝密', type: 'word', enabled: true },
    { text: '秘密', type: 'word', enabled: true },
  ],
  scope: 'all',
  action: 'delete',
});
const sc = engine.scan(ocrText);
const matched = (sc && sc.matched) || [];
check('扫描件 OCR 结果被判成密级命中',
  !!(sc && sc.hits >= 2 && matched.includes('内部') && matched.includes('机密')),
  '命中 ' + (sc ? sc.hits : 0) + ' 处 / ' + matched.join('、'));

/* ---------- 6. 认错时不能当成干净文件 ----------
 * 实测发现：同一个模型会把「内部文件 机密」认成「内部文件 ULE」——
 * 中文被识成了拉丁字母。此时词库引擎报 0 命中，但图上明明有密级标识，
 * 外部保密检查软件照样会报出来。所以「认得不可信」必须单独标出来。
 */
const F = D.DWROcrSuspect;
check('可信度判定模块已随仓库加载', !!(F && typeof F.check === 'function'));
if (F) {
  const bad = F.check('内部文件 ULE');
  check('密级词被认成拉丁串时判为不可靠', bad.ok === false && bad.reasons.some((x) => x.kind === 'latin'),
    JSON.stringify(bad.reasons));
  const good = F.check(ocrText);
  check('本次实际识别文本判为可靠', good.ok === true, JSON.stringify(good.reasons));
}

/* ---------- 6. 收尾 ---------- */
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不影响结论 */ }

console.log('');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
if (fail) process.exit(1);
