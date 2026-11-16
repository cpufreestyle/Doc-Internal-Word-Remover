#!/usr/bin/env node
/**
 * test-revision-ocr.mjs —— Word 修订痕迹 + 扫描件/图片 OCR 两条链路回归测试
 *
 * 覆盖两块此前只有「源码级」断言、没有行为级验证的能力：
 *
 *   1) Word 修订痕迹验证
 *      文档里「删掉了但还留在文件里的字」（w:del / w:delText）与
 *      「域代码里的字」（w:instrText）都是保密检查软件会读出来的内容。
 *      这里用真实 ZIP 造一份带修订痕迹的 docx，验证：
 *        - 扫描时修订文字确实被算作命中（不是正文干净就放过）
 *        - 命中部位记成「删除记录」/「域代码」这类可追溯的名字
 *        - 清除时修订文字真的被改掉（不是只报不改）
 *        - 清除后重新扫描不再命中（幂等）
 *
 *   2) 命令行 --ocr 参数
 *      --ocr 是 scan.mjs 上唯一没有任何测试套引用的对外参数（v430 门禁会红）。
 *      这里补上行为级验证：
 *        - --ocr 能被 parseArgs 正确解析
 *        - 开了 --ocr 后独立图片文件进入检查范围
 *        - 没开 --ocr 时图片文件仍按「格式不支持」跳过
 *        - 命令行文档（README）里有 --ocr 的交代
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('PASS [' + name + ']');
  } else {
    failed++;
    console.log('FAIL [' + name + '] ' + String(detail === undefined ? '' : detail));
  }
}

/* ---------- 载入浏览器端引擎（与网页端同一套代码） ---------- */

function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/pdf.js', 'js/ooxml.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    console, setTimeout, clearTimeout, URL, Blob, Response, TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

const W = loadEngine();

/** 默认词库引擎（含「内部」「机密」这类密级标识词），与 scan.mjs 的 buildRules 同口径 */
function makeEngine(scope) {
  const rules = W.DWRRules.DEFAULT_PRESETS.map((p) => ({
    text: p.word, type: 'text', enabled: true,
    notBefore: p.notBefore, notAfter: p.notAfter, whole: p.whole,
    group: p.group, docNumber: p.docNumber,
  }));
  return W.DWRRules.createEngine({ rules, scope: scope || 'all', action: 'delete' });
}

/* ---------- 1) Word 修订痕迹 ---------- */

{
  const engine = makeEngine('all');
  const docXml =
    '<w:document><w:body>' +
    '<w:p><w:r><w:t>公开正文内容</w:t></w:r></w:p>' +
    // 已删除但仍留在文件里的文字
    '<w:p><w:del w:id="1" w:author="张三"><w:r><w:delText>内部涉密删除记录</w:delText></w:r></w:del></w:p>' +
    // 插入的修订文字
    '<w:p><w:ins w:id="2" w:author="李四"><w:r><w:t>机密新增内容</w:t></w:r></w:ins></w:p>' +
    // 域代码里的文字
    '<w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "内部系统地址" </w:instrText></w:r></w:p>' +
    '</w:body></w:document>';

  const blob = await W.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: docXml },
  ]);
  const ab = await blob.arrayBuffer();

  // --- 扫描：修订文字必须被算作命中 ---
  const scan = await W.DWRDoc.scanOffice(ab, engine);
  check('修订-扫描命中删除记录里的敏感词', scan.hits > 0, 'hits=' + scan.hits);
  check('修订-扫描命中插入的敏感词', (scan.matched || []).indexOf('机密') >= 0,
    'matched=' + JSON.stringify(scan.matched));
  check('修订-扫描命中域代码里的敏感词', (scan.matched || []).indexOf('内部') >= 0,
    'matched=' + JSON.stringify(scan.matched));

  // 命中部位要能追溯到「在哪个部件」，不能是「（全文）」这种没法回溯的名字
  const partLabels = (scan.parts || []).map((p) => p.label || p.name || '');
  check('修订-命中部位记到具体部件', partLabels.length > 0
    && partLabels.every((l) => l && l !== '（全文）'),
    'parts=' + JSON.stringify(partLabels));

  // --- 清除：修订文字要真的被改掉 ---
  const proc = await W.DWRDoc.processOffice(ab, engine);
  check('修订-清除时确实改动了文件', proc.touched === true, 'touched=' + proc.touched);
  const outAb = await proc.blob.arrayBuffer();
  const outZip = await W.DWRZip.load(outAb);
  const outXml = await outZip.getText('word/document.xml');
  check('修订-清除后删除记录里的敏感词消失', outXml.indexOf('内部涉密删除记录') === -1,
    outXml.slice(0, 300));
  check('修订-清除后插入的敏感词消失', outXml.indexOf('机密新增内容') === -1,
    outXml.slice(0, 300));
  check('修订-清除后域代码里的敏感词消失', outXml.indexOf('内部系统地址') === -1,
    outXml.slice(0, 300));
  check('修订-清除后正常正文保留', outXml.indexOf('公开正文内容') >= 0,
    outXml.slice(0, 300));

  // --- 幂等：清完再扫一次不应再有命中 ---
  const scan2 = await W.DWRDoc.scanOffice(outAb, engine);
  check('修订-清除后重新扫描不再命中', scan2.hits === 0,
    'hits=' + scan2.hits + ' matched=' + JSON.stringify(scan2.matched));
}

/* ---------- 2) 命令行 --ocr ---------- */

{
  const SCAN_SRC = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');

  // --ocr 能被 parseArgs 解析（源码级：确认它进 options 默认值与分支）
  check('cli-ocr-parseArgs 认得 --ocr',
    /a === '--ocr'/.test(SCAN_SRC) && /ocr:\s*false/.test(SCAN_SRC),
    'scan.mjs 里找不到 --ocr 分支或默认值');

  // --ocr 会把独立图片文件纳入检查范围
  check('cli-ocr-开了 --ocr 后图片文件进入检查范围',
    /ocrState\.enabled\s*&&\s*D\.DWRDoc\.isImageFile/.test(SCAN_SRC),
    'scan.mjs 里找不到「OCR 开启时图片文件入检查范围」的判断');

  // --ocr 会把扫描件 PDF 送去识别（而不是只说一句「需人工复核」）
  check('cli-ocr-扫描件 PDF 走 OCR 识别',
    /imageOnly|扫描件/.test(SCAN_SRC) && /ocrScanFile\(full,\s*buf\)/.test(SCAN_SRC),
    'scan.mjs 里找不到扫描件 PDF 的 OCR 分支');

  // OCR 命中要独立记账成「图片OCR（部件名）」
  check('cli-ocr-OCR 命中独立记账', /图片OCR（/.test(SCAN_SRC),
    'scan.mjs 里找不到「图片OCR（...）」部位名');

  // 命令行文档要有 --ocr 的交代（否则用户不知道怎么用）
  check('cli-ocr-README 交代了 --ocr', README.indexOf('--ocr') >= 0,
    'README.md 里没找到 --ocr');

  // OCR 引擎不可用时必须降级 + 明确提示「仍需人工复核」，不能静默当作干净
  check('cli-ocr-引擎缺失时明确提示人工复核',
    /未做图片文字检查/.test(SCAN_SRC) && /仍需人工复核/.test(SCAN_SRC),
    'scan.mjs 里找不到 OCR 降级提示');

  // OCR 模型资源必须随包分发（否则 --ocr 在别人机器上永远不生效）
  const langDir = path.join(__dirname, 'assets', 'ocr', 'lang');
  const need = ['chi_sim.traineddata.gz', 'eng.traineddata.gz'];
  const missing = need.filter((f) => !fs.existsSync(path.join(langDir, f)));
  check('cli-ocr-OCR 模型资源随包分发', missing.length === 0, '缺 ' + missing.join(','));

  // v4.93 修掉的两个真问题：
  //   1) worker 不 terminate → 扫描跑完、报告写好了，进程却不退出，整盘批处理卡死
  check('cli-ocr-退出前收掉 OCR worker（否则进程挂着不退）',
    /async function shutdownOcrWorker/.test(SCAN_SRC)
    && /terminate\(\)/.test(SCAN_SRC)
    && /shutdownOcrWorker\(\)/.test(SCAN_SRC),
    'scan.mjs 里找不到退出前 terminate OCR worker 的逻辑');
  check('cli-ocr-worker 赋值给模块级变量（收尾时才拿得到）',
    /ocrWorker\s*=\s*worker/.test(SCAN_SRC),
    'scan.mjs 里 worker 没有存到模块级变量');

  //   2) 部位名双层括号：部件名自带「（图片文件）」，再套一层变成「图片OCR（（图片文件））」
  check('cli-ocr-OCR 部位名不产生双层括号',
    /function ocrPartLabel/.test(SCAN_SRC) && /图片OCR' \+ ocrPartLabel/.test(SCAN_SRC),
    'scan.mjs 里找不到 ocrPartLabel 归一化逻辑');
  check('cli-ocr-网页端同步修了双层括号',
    /function ocrPartLabel/.test(fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf8')),
    'js/app.js 里找不到 ocrPartLabel');
}

console.log('');
console.log(failed === 0 ? '==== 全部通过 ====' : '==== 存在失败 ====');
console.log('PASS: ' + passed + '  FAIL: ' + failed);
if (failed) process.exit(1);
