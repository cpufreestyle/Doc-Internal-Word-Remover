#!/usr/bin/env node
/**
 * test-coverage.mjs —— 覆盖度回归自测（锁定「全部件脱敏」的部件范围）
 *
 * 在 test-allparts.mjs（正文/页眉/页脚/批注/文本框）基础上，进一步覆盖：
 *  - docx：脚注(footnotes)、尾注(endnotes)
 *  - pptx：幻灯片母版(slideMasters)、版式(slideLayouts)、备注母版(notesMasters)、
 *          备注(notesSlides)、评论(comments)
 *  - xlsx：内联字符串单元格(inlineStr)、图表(charts, drawingML)、
 *          数据透视缓存(pivotCache)、查询表(queryTables)、表名(tables)
 *
 * 断言：处理后每个部件内都不再残留敏感词，且输出 ZIP 可被重新解析。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js'];
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

const SENSITIVE = ['内部', '秘密', '机密', '绝密'];

function partsFor(fmt) {
  if (fmt === 'docx') return [
    { name: 'word/document.xml',  data: '<w:p><w:t>这是内部资料正文</w:t></w:p>' },
    { name: 'word/header1.xml',   data: '<w:p><w:t>内部资料页眉</w:t></w:p>' },
    { name: 'word/footer1.xml',   data: '<w:p><w:t>机密页脚</w:t></w:p>' },
    { name: 'word/footnotes.xml', data: '<w:footnotes><w:footnote w:id="1"><w:p><w:t>秘密脚注</w:t></w:p></w:footnote></w:footnotes>' },
    { name: 'word/endnotes.xml',  data: '<w:endnotes><w:endnote w:id="1"><w:p><w:t>绝密尾注</w:t></w:p></w:endnote></w:endnotes>' },
    { name: 'word/comments.xml',  data: '<w:comments><w:comment w:id="1"><w:p><w:t>内部批注</w:t></w:p></w:comment></w:comments>' },
    { name: 'word/drawing1.xml',  data: '<a:p><a:t>机密文本框</a:t></a:p>' },
  ];
  if (fmt === 'xlsx') return [
    { name: 'xl/sharedStrings.xml',     data: '<sst><si><t>内部资料字符串</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c t="inlineStr"><is><t>机密单元格</t></is></c></row></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row><c><is><t>内部内联串</t></is></c></row></sheetData></worksheet>' },
    { name: 'xl/comments1.xml',         data: '<comments><commentList><comment ref="A1"><text><t>绝密批注</t></text></comment></commentList></comments>' },
    { name: 'xl/drawings/drawing1.xml', data: '<a:p><a:t>秘密绘图</a:t></a:p>' },
    { name: 'xl/charts/chart1.xml',     data: '<c:chart><c:tx><c:rich><a:p><a:t>绝密图表标题</a:t></a:p></c:rich></c:tx></c:chart>' },
    { name: 'xl/tables/table1.xml',     data: '<table displayName="内部表" name="列1"><tableColumn name="机密列"/></table>' },
    { name: 'xl/pivotCache/pivotCacheDefinition1.xml', data: '<pivotCacheDefinition><cacheSource><worksheetSource name="内部源"/></cacheSource></pivotCacheDefinition>' },
    { name: 'xl/pivotCache/pivotCacheRecords1.xml',    data: '<pivotCacheRecords><r><s v="内部记录"/></r></pivotCacheRecords>' },
    { name: 'xl/queryTables/queryTable1.xml',          data: '<queryTable name="机密查询"><queryTableRefresh/></queryTable>' },
  ];
  if (fmt === 'pptx') return [
    { name: 'ppt/slides/slide1.xml',            data: '<a:p><a:t>内部资料幻灯片</a:t></a:p>' },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: '<a:p><a:t>绝密母版</a:t></a:p>' },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: '<a:p><a:t>内部版式</a:t></a:p>' },
    { name: 'ppt/notesSlides/notesSlide1.xml',  data: '<a:p><a:t>机密备注</a:t></a:p>' },
    { name: 'ppt/notesMasters/notesMaster1.xml', data: '<a:p><a:t>内部备注母版</a:t></a:p>' },
    { name: 'ppt/comments/modernComment1.xml',  data: '<p:cmLst><p:cm><p:txBody><a:p><a:t>秘密评论</a:t></a:p></p:txBody></p:cm></p:cmLst>' },
  ];
  return [];
}

const D = await loadEngine();
const engine = D.DWRRules.createEngine({
  rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
  scope: 'all', action: 'delete', custom: '',
});

let allPass = true;
const checked = {};
for (const fmt of ['docx', 'xlsx', 'pptx']) {
  const blob = await D.DWRZip.pack(partsFor(fmt));
  const res = await D.DWRDoc.processOffice(await blob.arrayBuffer(), engine);
  if (!res.touched) { console.log('FAIL [' + fmt + '] 未触发任何命中'); allPass = false; continue; }
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer()); // 能重新解析 = 合法 zip
  if (!zip2) { console.log('FAIL [' + fmt + '] 输出无法重新解析'); allPass = false; continue; }
  const bad = [];
  for (const e of zip2.entries) {
    checked[e.name] = true;
    const xml = await zip2.getText(e.name);
    for (const w of SENSITIVE) {
      if (xml && xml.includes(w)) bad.push(e.name + ' 仍含「' + w + '」');
    }
  }
  if (bad.length) { console.log('FAIL [' + fmt + ']\n  ' + bad.join('\n  ')); allPass = false; }
  else console.log('PASS [' + fmt + '] 覆盖 ' + Object.keys(checked).length + ' 个部件，敏感词已全部清除 (hits=' + res.hits + ')');
}
/* ---------------- 隐藏部位覆盖：关键词藏在隐藏工作表 / 隐藏行 / 隐藏列也必须被检测并清除 ---------------- */
{
  const hiddenParts = [
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="urn:r"><sheets>'
      + '<sheet name="Visible" sheetId="1" r:id="rId1"/>'
      + '<sheet name="内部密表" sheetId="2" state="hidden" r:id="rId2"/>'
      + '</sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>绝密共享串</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data:
        '<worksheet><cols><col min="6" max="6" hidden="1"/></cols><sheetData>'
        + '<row r="1"><c t="inlineStr"><is><t>可见正常内容</t></is></c></row>'
        + '<row r="2" hidden="1"><c t="inlineStr"><is><t>机密隐藏行</t></is></c></row>'
        + '<row r="3"><c r="F3" t="inlineStr"><is><t>内部隐藏列</t></is></c></row>'
        + '</sheetData></worksheet>' },
    { name: 'xl/drawings/drawing1.xml', data: '<xdr:wsDr xmlns:xdr="urn:x"><a:p><a:t>秘密隐藏图形</a:t></a:p></xdr:wsDr>' },
  ];
  const scan = await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(hiddenParts)).arrayBuffer(), engine);
  const allDetected = scan.hits > 0 && ['机密', '内部', '秘密', '绝密'].every((w) => scan.matched.indexOf(w) >= 0);
  console.log((allDetected ? 'PASS' : 'FAIL') + ' [隐藏部位-扫描检出隐藏表/隐藏行/隐藏列] hits=' + scan.hits + ' matched=' + JSON.stringify(scan.matched)); if (!allDetected) allPass = false;
  const hres = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(hiddenParts)).arrayBuffer(), engine);
  const hzip = await D.DWRZip.load(await hres.blob.arrayBuffer());
  const hbad = [];
  for (const e of hzip.entries) {
    const xml = await hzip.getText(e.name);
    for (const w of SENSITIVE) if (xml && xml.includes(w)) hbad.push(e.name + ' 仍含「' + w + '」');
  }
  const hkeep = await hzip.getText('xl/worksheets/sheet1.xml');
  const hold = hbad.length === 0 && /<row[^>]*hidden="1"/.test(hkeep) && /可见正常内容/.test(hkeep);
  console.log((hold ? 'PASS' : 'FAIL') + ' [隐藏部位-清除后无敏感词残留且隐藏结构保留]' + (hold ? '' : ' ' + (hbad.join(' | ') || String(hkeep).slice(0, 80)))); if (!hold) allPass = false;
}

/* ---------------- v4.46 PPT 非幻灯片部件的整部件口径：README 承诺「版式 / 母版 / 备注母版 /
   讲义母版与 SmartArt 图示没有首行 / 尾行语义，已按整部件清理，不受此边界影响」。
   此前零覆盖，且既有断言一律用 scope:'all'——在 all 范围下「整部件清理」与「按页取首尾」
   行为完全相同，夹具根本没有区分力。这里改用默认范围 firstlast，并让每段都含敏感词，
   于是 slide 只剩首尾两段被清、非 slide 部件应一段不剩。 */
{
  const flEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.filter((p) => p.word === '机密').map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  });
  // 三段文本块、每段都含「机密」：按页取首尾应剩 1 段，整部件清理应剩 0 段
  const shape = (t) => '<p:sp><p:txBody><a:p><a:r><a:t>' + t + '</a:t></a:r></a:p></p:txBody></p:sp>';
  const tree = () => [shape('机密甲'), shape('机密乙'), shape('机密丙')].join('');
  const wrap = (inner) => '<root xmlns:a="urn:a"><spTree>' + inner + '</spTree></root>';
  const pptParts = [
    { name: 'ppt/slides/slide1.xml', data: wrap(tree()) },
    { name: 'ppt/handoutMasters/handoutMaster1.xml', data: wrap(tree()) },
    { name: 'ppt/drawings/drawing1.xml', data: wrap(tree()) },
  ];
  const pres = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(pptParts)).arrayBuffer(), flEngine);
  const pzip = await D.DWRZip.load(await pres.blob.arrayBuffer());
  const left = async (nm) => ((await pzip.getText(nm)).match(/机密/g) || []).length;
  const slideLeft = await left('ppt/slides/slide1.xml');
  const handoutLeft = await left('ppt/handoutMasters/handoutMaster1.xml');
  const drawingLeft = await left('ppt/drawings/drawing1.xml');
  // 幻灯片按页取首尾：中段留下（这正是 README 说明的边界，设计如此）
  const slideOk = slideLeft === 1;
  console.log((slideOk ? 'PASS' : 'FAIL') + ' [v446-幻灯片按页取首尾，中段保留] 剩余=' + slideLeft); if (!slideOk) allPass = false;
  // 讲义母版与 SmartArt 图示按整部件清理：一段不剩
  const nonSlideOk = handoutLeft === 0 && drawingLeft === 0;
  console.log((nonSlideOk ? 'PASS' : 'FAIL') + ' [v446-讲义母版与图示按整部件清理（不受首尾边界影响）]'
    + ' handout=' + handoutLeft + ' drawing=' + drawingLeft); if (!nonSlideOk) allPass = false;
  // 扫描侧口径与处理侧一致：slide 在 firstlast 下只算首尾两段，讲义母版与图示各算三段，
  // 合计 2 + 3 + 3 = 8。若扫描把 slide 也按整部件算（得 9），说明两侧口径分叉，
  // 用户会看到「扫描报 3 处、处理后只剩 1 处」的困惑。
  const pscan = await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(pptParts)).arrayBuffer(), flEngine);
  const scanOk = pscan.hits === 8;
  console.log((scanOk ? 'PASS' : 'FAIL') + ' [v446-扫描侧与处理侧口径一致（slide 只算首尾）] hits=' + pscan.hits); if (!scanOk) allPass = false;
}
console.log(allPass ? '\n==== 全部通过 ====' : '\n==== 存在失败 ====');
process.exit(allPass ? 0 : 1);
