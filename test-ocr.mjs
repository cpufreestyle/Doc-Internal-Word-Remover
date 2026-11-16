/* v4.88 图片文字检查（OCR）回归测试
 *
 * 覆盖三块：
 *   1. 图片提取：OOXML 内嵌图片、PDF 里的 DCTDecode 图片能不能被取出来；
 *   2. OCR 模块：接口齐全、缺资源时优雅降级（不抛错、不卡住扫描）；
 *   3. 界面接线：开关、预缓存清单、随包资源是否齐全。
 * 真正跑识别的用例在 test-ocr-live.mjs（需要模型，不进 npm test）。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEngine(extra = []) {
  const files = ['js/zip.js', 'js/rules.js', 'js/pdf.js', 'js/ooxml.js', 'js/util.js', 'js/ocr.js'].concat(extra);
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + ']' + (extra ? '  ' + extra : '')); }
}

/* ---------- 最小 ZIP（只存储，不压缩） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

/* 1x1 PNG */
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6360000002000100ffff03000006' +
  '0005574bd0e10000000049454e44ae426082', 'hex');

const D = await loadEngine();

/* ================= A. 图片提取 ================= */
{
  const docx = makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: 'word/document.xml', data: Buffer.from('<w:document/>') },
    { name: 'word/media/image1.png', data: PNG_1x1 },
    { name: 'word/media/image2.jpg', data: PNG_1x1 },
    { name: 'word/embeddings/oleObject1.bin', data: Buffer.from('not-an-image') },
  ]);
  const imgs = await D.DWRDoc.extractImages('a.docx', new Uint8Array(docx));
  check('ocr-从 docx 里取出内嵌图片', imgs.length === 2, '取出 ' + imgs.length + ' 张');
  check('ocr-图片部件名保留路径',
    imgs.some((i) => i.part === 'word/media/image1.png'), JSON.stringify(imgs.map((i) => i.part)));
  check('ocr-图片字节原样取出',
    imgs.length === 2 && imgs[0].bytes.length === PNG_1x1.length);
  check('ocr-按扩展名给出 MIME',
    imgs.length === 2 && imgs[0].mime === 'image/png' && imgs[1].mime === 'image/jpeg');
  check('ocr-非图片部件不误取', !imgs.some((i) => /oleObject/.test(i.part)));

  const notZip = await D.DWRDoc.extractImages('a.txt', new Uint8Array(Buffer.from('hello')));
  check('ocr-非压缩包返回空数组', Array.isArray(notZip) && notZip.length === 0);

  check('ocr-独立图片文件识别',
    D.DWRDoc.isImageFile('截图.PNG') && D.DWRDoc.isImageFile('a.jpeg') && !D.DWRDoc.isImageFile('a.docx'));
}

/* ================= B. PDF 图片提取 ================= */
{
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(32), Buffer.from([0xFF, 0xD9])]);
  const objs = [];
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  const imgObj = '4 0 obj\n<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length '
    + jpeg.length + ' >>\nstream\n';
  const contentObj = '5 0 obj\n<< /Length 44 >>\nstream\nq 100 0 0 100 0 0 cm /Im0 Do Q\nendstream\nendobj\n';
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  offsets.push(pdf.length); pdf += imgObj;
  pdf += Buffer.from(jpeg).toString('latin1');
  pdf += '\nendstream\nendobj\n';
  offsets.push(pdf.length); pdf += contentObj;
  const xrefPos = pdf.length;
  let xref = 'xref\n0 ' + (offsets.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += xref + 'trailer\n<< /Size ' + (offsets.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n';
  const imgs = D.DWRPdf.extractImages(new Uint8Array(Buffer.from(pdf, 'latin1')));
  check('ocr-从 PDF 里取出 JPEG 图片', imgs.length === 1, '取出 ' + imgs.length + ' 张');
  check('ocr-PDF 图片 MIME 为 image/jpeg', imgs.length === 1 && imgs[0].mime === 'image/jpeg');
  check('ocr-PDF 图片带尺寸信息', imgs.length === 1 && imgs[0].width === 4 && imgs[0].height === 4);
  check('ocr-PDF 图片字节完整', imgs.length === 1 && imgs[0].bytes.length === jpeg.length);
}

/* ================= C. OCR 模块 ================= */
{
  check('ocr-模块已加载', !!D.DWROcr, 'DWROcr 缺失');
  check('ocr-接口齐全',
    ['configure', 'status', 'warmup', 'recognize', 'terminate'].every((k) => typeof D.DWROcr[k] === 'function'));
  const st = D.DWROcr.status();
  check('ocr-状态可读', st && typeof st.available === 'boolean' && typeof st.ready === 'boolean');
  check('ocr-命令行环境标记为不可用（未注入实现）', st.available === false);
  const empty = await D.DWROcr.recognize(null);
  check('ocr-空输入不抛错', empty && empty.text === '');
  const tooBig = await D.DWROcr.recognize({ bytes: new Uint8Array(1024) }, { maxBytes: 10 });
  check('ocr-超大图片直接跳过', tooBig && tooBig.skipped === '图片过大');
  const noImpl = await D.DWROcr.recognize({ bytes: new Uint8Array(4) });
  check('ocr-没有引擎时降级为错误而不是崩溃', !!noImpl && noImpl.text === '' && !!noImpl.error);
}

/* ================= D. 界面与资源接线 ================= */
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  check('ocr-界面有图片文字检查开关', /id="scanOcr"/.test(html));
  check('ocr-开关带悬停说明', /id="scanOcr"/.test(html) && /图片文字检查（OCR/.test(html));
  check('ocr-引入 OCR 模块', /<script src="js\/ocr\.js"><\/script>/.test(html));
  check('ocr-扫描选项带上 ocr 开关', app.indexOf("ocr: !!(($('scanOcr') && $('scanOcr').checked))") >= 0);
  check('ocr-OCR 命中以独立部位记账', app.indexOf('图片OCR（') >= 0);
  check('ocr-OCR 用全文口径引擎', app.indexOf("cfg.scope = 'all'") >= 0);
  check('ocr-统计 OCR 识别张数', app.indexOf('stats.ocrImages') >= 0);
  check('ocr-停止扫描时收掉 worker', app.indexOf('DWROcr.terminate') >= 0);
  check('ocr-预缓存清单含 OCR 模块', sw.indexOf("'./js/ocr.js'") >= 0);

  const assets = ['assets/ocr/tesseract.min.js', 'assets/ocr/worker.min.js',
    'assets/ocr/core/tesseract-core-simd-lstm.wasm.js', 'assets/ocr/core/tesseract-core-lstm.wasm.js',
    'assets/ocr/lang/chi_sim.traineddata.gz', 'assets/ocr/lang/eng.traineddata.gz'];
  const missing = assets.filter((f) => !fs.existsSync(path.join(__dirname, f)));
  check('ocr-识别模型资源齐全', missing.length === 0, '缺 ' + missing.join(','));
  const size = assets.reduce((n, f) => n + fs.statSync(path.join(__dirname, f)).size, 0);
  check('ocr-识别资源体积在 20MB 以内', size < 20 * 1024 * 1024, Math.round(size / 1048576) + 'MB');
}

console.log('');
console.log(fail === 0 ? '==== 全部通过 ====' : '==== 存在失败 ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
if (fail) process.exit(1);
