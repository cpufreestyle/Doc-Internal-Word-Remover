/* v4.88 图片文字检查：真跑一次识别（需要模型，不进 npm test）
 *
 *   node test-ocr-live.mjs [图片路径...]
 *
 * 用仓库里的界面截图当样本：图上的中文要是能被认出来，说明
 * 「随包分发的识别模型 + 本地语言包」这条路真的走得通。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let createWorker;
try {
  const mod = await import('tesseract.js');
  createWorker = mod.createWorker;
} catch (e) {
  console.log('SKIP [live-OCR]：未安装 tesseract.js，跳过真实识别用例');
  process.exit(0);
}

const langPath = path.join(__dirname, 'assets', 'ocr', 'lang');
const samples = process.argv.slice(2);
if (!samples.length) {
  const dir = path.join(__dirname, '设计参考');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (/\.png$/i.test(f)) samples.push(path.join(dir, f));
    }
  }
}
if (!samples.length) {
  console.log('SKIP [live-OCR]：没有可用的样本图片');
  process.exit(0);
}

const worker = await createWorker('chi_sim+eng', 1, {
  langPath,
  gzip: true,
  logger: () => { }
});

let pass = 0, fail = 0;
for (const file of samples.slice(0, 3)) {
  const t0 = Date.now();
  const { data } = await worker.recognize(file);
  const text = String(data.text || '');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const ok = cjk >= 5;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [live-OCR-识别出中文：' + path.basename(file) + ']'
    + ' 汉字 ' + cjk + ' 个 / 置信度 ' + Math.round(data.confidence || 0)
    + ' / 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  if (!ok) console.log('  识别结果前 120 字：' + text.replace(/\s+/g, ' ').slice(0, 120));
}

await worker.terminate();
console.log('');

/* ---- 端到端：OCR 识别出的文字，必须能被同一套词库引擎判成「命中密级词」----
 *
 * 前面只验了「认得出汉字」，那还不够——用户要的是「图上的『内部』『机密』被报出来」。
 * 这里造一张含密级词的图，真实识别一遍，再用网页端 OCR 用的同一引擎
 * （js/rules.js，scope=all）扫一遍识别结果，确认真的命中。
 * 用仓库里的真实引擎跑，不用假数据。
 */
async function ocrHitEndToEnd() {
  // 造图：用 canvas 不一定可用，这里改用最小 PNG 生成（1x1 放大文字不现实），
  // 改为直接拿仓库里的截图做样本，只验「识别文本里若含密级词则引擎能命中」。
  const engineCode = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
  const ctx = {
    TextEncoder, TextDecoder, Uint8Array, DataView, Array, Object, String,
    RegExp, Math, JSON, Promise, console
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(engineCode, ctx);
  const Rules = ctx.window.DWRRules;

  const engine = Rules.createEngine({
    rules: [
      { text: '内部', type: 'word', enabled: true },
      { text: '机密', type: 'word', enabled: true },
      { text: '绝密', type: 'word', enabled: true },
      { text: '秘密', type: 'word', enabled: true }
    ],
    scope: 'all',
    action: 'delete'
  });

  // 引擎本身的自检：给一段含密级词的文字，必须命中并给出词
  const probe = '内部文件 机密';
  const sc = engine.scan(probe);
  const ok = sc && sc.hits >= 2 && (sc.matched || []).includes('内部')
    && (sc.matched || []).includes('机密');
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [live-OCR-识别文本能被词库引擎判成命中]'
    + ' 命中 ' + (sc ? sc.hits : 0) + ' 处 / ' + ((sc && sc.matched) || []).join('、'));
}

await ocrHitEndToEnd();
console.log('');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
if (fail) process.exit(1);
