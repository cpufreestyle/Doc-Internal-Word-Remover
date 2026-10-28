#!/usr/bin/env node
/**
 * test-roundtrip.mjs —— 回归测试：输出可被重新解析且不破坏文档
 *
 * 覆盖此前修复的几类问题：
 *  - xlsx 工作表名被整段清空（P0-2：name="" 会让 Excel 提示修复）
 *  - 未修改的二进制条目被解压重压、体积膨胀（P0-1：字节应 1:1 保真）
 *  - GBK 文件命中后被静默存成无 BOM 的 UTF-8 → 乱码（P0-3：应带 BOM）
 *  - 全部件脱敏后，输出 ZIP 仍能正常解析
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

const D = await loadEngine();
const engine = D.DWRRules.createEngine({
  rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
  scope: 'all', action: 'delete', custom: '',
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + ']' + (extra ? '  ' + extra : '')); }
}

// ---------- 1) xlsx：工作表名不应被清空 ----------
{
  const parts = [
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="http://schemas"><sheets><sheet name="内部" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>内部资料字符串</t></si></sst>' },
  ];
  const blob = await D.DWRZip.pack(parts);
  const res = await D.DWRDoc.processOffice(await blob.arrayBuffer(), engine);
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer()); // 能重新解析 = 合法 zip
  const wb = await zip2.getText('xl/workbook.xml');
  const ss = await zip2.getText('xl/sharedStrings.xml');
  check('xlsx-可重新解析', !!wb && !!ss);
  check('xlsx-工作表名未清空', /name="[^"]+/ .test(wb) && !/name=""/.test(wb), 'workbook=' + wb);
  check('xlsx-工作表名不含敏感词', !/内部/.test(wb), 'workbook=' + wb);
  check('xlsx-共享字符串已清除', !/内部/.test(ss), 'sharedStrings=' + ss);
}

// ---------- 2) docx：输出可重新解析且正文已清洁 ----------
{
  const parts = [
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>这是内部正文</w:t></w:p></w:body></w:document>' },
    { name: 'word/header1.xml', data: '<w:p><w:t>机密页眉</w:t></w:p>' },
  ];
  const blob = await D.DWRZip.pack(parts);
  const res = await D.DWRDoc.processOffice(await blob.arrayBuffer(), engine);
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer());
  const doc = await zip2.getText('word/document.xml');
  const hdr = await zip2.getText('word/header1.xml');
  check('docx-可重新解析', !!doc && !!hdr);
  check('docx-正文已清洁', !/内部资料/.test(doc), 'doc=' + doc);
  check('docx-页眉已清洁', !/机密/.test(hdr), 'hdr=' + hdr);
}

// ---------- 3) P0-1：未修改的二进制条目 1:1 保真（不重压、不膨胀） ----------
{
  // 50KB 不可压缩随机数据，模拟图片/媒体
  const media = new Uint8Array(50 * 1024);
  for (let i = 0; i < media.length; i++) media[i] = (i * 31 + 7) & 0xff;
  const parts = [
    { name: 'word/media/image1.png', data: media },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>这是内部正文</w:t></w:p></w:body></w:document>' },
  ];
  const inBlob = await D.DWRZip.pack(parts);
  const inBuf = new Uint8Array(await inBlob.arrayBuffer());
  const res = await D.DWRDoc.processOffice(inBuf.buffer.slice(0), engine);
  const outBuf = new Uint8Array(await res.blob.arrayBuffer());

  // 重新读出输出中的 media，字节应与输入完全一致
  const outZip = await D.DWRZip.load(outBuf.buffer.slice(0));
  const outMedia = await outZip.getBytes('word/media/image1.png');

  check('zip-二进制条目字节保真', (() => {
    if (!outMedia || outMedia.length !== media.length) return false;
    for (let i = 0; i < media.length; i++) if (outMedia[i] !== media[i]) return false;
    return true;
  })(), 'media length in=' + media.length + ' out=' + (outMedia && outMedia.length));
  check('zip-输出体积未膨胀', outBuf.length <= inBuf.length * 1.02,
    'in=' + inBuf.length + ' out=' + outBuf.length);
}

// ---------- 4) P0-3：GBK 文件命中后写回应带 BOM 的 UTF-8，不乱码 ----------
{
  // 「内部测试」的 GBK 字节
  const gbk = new Uint8Array([0xC4, 0xDA, 0xB2, 0xBF, 0xB2, 0xE2, 0xCA, 0xD4]);
  const dec = D.DWRDoc.decodeText(gbk);
  check('gbk-被识别为 GBK 编码', dec.encoding === 'gbk', 'encoding=' + dec.encoding);
  check('gbk-解码正确', dec.text === '内部测试', 'text=' + dec.text);
  const r = D.DWRDoc.processText(dec.text, engine, dec.encoding);
  check('gbk-敏感词已删', r.text === '测试', 'text=' + r.text);
  const outBuf = D.DWRDoc.encodeText(r.text, dec.bom, dec.encoding);
  const hasBom = outBuf[0] === 0xef && outBuf[1] === 0xbb && outBuf[2] === 0xbf;
  const reDecoded = new TextDecoder('utf-8', { fatal: true }).decode(outBuf);
  check('gbk-写回带 UTF-8 BOM', hasBom, 'head=' + outBuf.slice(0, 3).join(','));
  check('gbk-重新解码为 UTF-8 不乱码', reDecoded === '测试', 'reDecoded=' + reDecoded);
}

// ---------- 5) 覆盖度：customXml / xl:tables / 内嵌 Office 文档 ----------
{
  // 先构建一个内嵌 docx 作为字节流
  const innerDocx = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内嵌的机密内容</w:t></w:p></w:body></w:document>' },
  ]);
  const innerBuf = new Uint8Array(await innerDocx.arrayBuffer());

  const parts = [
    { name: 'customXml/item1.xml', data: '<root><prop>内部配置项</prop></root>' },
    { name: 'xl/tables/table1.xml', data: '<table displayName="内部表" name="列1"><tableColumn name="机密列"/></table>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>这是内部资料</w:t></w:p></w:body></w:document>' },
    { name: 'word/embeddings/embedded.docx', data: innerBuf },
  ];
  const blob = await D.DWRZip.pack(parts);
  const res = await D.DWRDoc.processOffice(await blob.arrayBuffer(), engine);
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer());

  const cust = await zip2.getText('customXml/item1.xml');
  const tbl = await zip2.getText('xl/tables/table1.xml');
  const doc = await zip2.getText('word/document.xml');
  const embedBytes = await zip2.getBytes('word/embeddings/embedded.docx');
  const embedZip = await D.DWRZip.load(embedBytes.buffer.slice(embedBytes.byteOffset, embedBytes.byteOffset + embedBytes.byteLength));
  const embedDoc = await embedZip.getText('word/document.xml');

  check('coverage-customXml 已清洁', cust && !/内部|机密/.test(cust), 'cust=' + cust);
  check('coverage-xl_tables 表名未清空', tbl && /displayName="[^"]+"/.test(tbl) && !/displayName=""/.test(tbl), 'tbl=' + tbl);
  check('coverage-xl_tables 已清洁', tbl && !/内部|机密/.test(tbl), 'tbl=' + tbl);
  check('coverage-document 已清洁', doc && !/内部资料/.test(doc), 'doc=' + doc);
  check('coverage-内嵌文档已递归脱敏', embedDoc && !/机密/.test(embedDoc), 'embedDoc=' + embedDoc);
}

// ---------- 6) scope=firstlast：仅处理首行/尾行，中间内容保留 ----------
{
  const mk = (scope) => D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: scope, action: 'delete', custom: '',
  });
  const engFL = mk('firstlast');
  const engALL = mk('all');

  // 纯文本：首行 / 尾行处理，中间行保留
  const text = '绝密：文档首行\n中间包含秘密与内部的正文\n机密：文档尾行';
  const r = D.DWRDoc.processText(text, engFL);
  const tl = r.text.split('\n');
  check('firstlast-文本首行已清', tl[0].indexOf('绝密') === -1, 'line0=' + tl[0]);
  check('firstlast-文本中间行保留', tl[1] === '中间包含秘密与内部的正文', 'line1=' + tl[1]);
  check('firstlast-文本尾行已清', tl[tl.length - 1].indexOf('机密') === -1, 'last=' + tl[tl.length - 1]);
  check('firstlast-命中位置标记', r.firstHit === true && r.lastHit === true, JSON.stringify({ f: r.firstHit, l: r.lastHit }));

  // 尾随空行不算「尾行」：最后一个非空行才是尾行
  const r2 = D.DWRDoc.processText('内部资料\n正文\n\n\n', engFL);
  check('firstlast-尾随空行不误判', r2.text === '资料\n正文\n\n\n', 'text=' + JSON.stringify(r2.text));

  // docx：首段 / 末段处理，中间段保留
  const parts = [
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:t>内部资料</w:t></w:p>' +
      '<w:p><w:t>中间机密内容</w:t></w:p>' +
      '<w:p><w:t>绝密尾段</w:t></w:p>' +
      '</w:body></w:document>' },
  ];
  const resFL = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), engFL);
  const zipFL = await D.DWRZip.load(await resFL.blob.arrayBuffer());
  const docFL = await zipFL.getText('word/document.xml');
  check('firstlast-docx 首段已清', docFL.indexOf('内部') === -1, 'doc=' + docFL);
  check('firstlast-docx 中间段保留', docFL.indexOf('机密') !== -1, 'doc=' + docFL);
  check('firstlast-docx 尾段已清', docFL.indexOf('绝密') === -1, 'doc=' + docFL);
  check('firstlast-docx 位置标记', resFL.firstHit === true && resFL.lastHit === true, JSON.stringify({ f: resFL.firstHit, l: resFL.lastHit }));

  // 全文模式对照：中间段也应被清除（验证范围开关生效）
  const resALL = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), engALL);
  const zipALL = await D.DWRZip.load(await resALL.blob.arrayBuffer());
  const docALL = await zipALL.getText('word/document.xml');
  check('all-docx 中间段已清', docALL.indexOf('机密') === -1, 'doc=' + docALL);
}

// ---------- 7) 全部件覆盖不变量：全文清除后重新扫描应为 0 命中 ----------
// 目的：把「扫描报出来的命中」与「清理后真的清掉了」这两件事绑成一个不变量。
// 以后任何部件处理策略回归（新增 / 漏改 / 范围语义漂移）都会在这里炸出来。
{
  const WORDS = ['内部', '机密', '绝密', '秘密'];
  const nestedZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="内部资料"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>机密表格</t></si></sst>' },
  ]);

  const xmlParts = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:r><w:t>内部</w:t></w:r><w:r><w:t>附件</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>秘密附件</w:t></w:r></w:p>' +   // 跨 run
      '<w:p><w:del><w:r><w:delText>内部删除记录</w:delText></w:r></w:del></w:p>' +
      '<w:p><w:r><w:instrText> REF 机密域 </w:instrText></w:r></w:p>' +
      '<w:p><w:pict><v:shape><v:textbox><w:txbxContent><a:p><a:r><a:t>文本框内部文字</a:t></a:r></a:p></w:txbxContent></v:textbox></v:shape></w:pict></w:p>' +
      '<w:p><w:bookmarkStart w:name="绝密书签"/><w:fldSimple w:instr="内部指令"/></w:p>' +
      '</w:body></w:document>' },
    { name: 'word/header2.xml', data: '<w:hdr><w:p><w:r><w:t>绝密页眉</w:t></w:r></w:p></w:hdr>' },
    { name: 'word/footnotes.xml', data: '<w:footnotes><w:footnote><w:p><w:r><w:t>内部脚注</w:t></w:r></w:p></w:footnote></w:footnotes>' },
    { name: 'word/comments.xml', data: '<w:comments><w:comment w:id="1"><w:p><w:r><w:t>机密批注</w:t></w:r></w:p></w:comment></w:comments>' },
    { name: 'docProps/core.xml', data: '<cp:coreProperties><dc:title>内部标题</dc:title><dc:subject>机密主题</dc:subject></cp:coreProperties>' },
    { name: 'docProps/app.xml', data: '<Properties><Company>内部单位</Company></Properties>' },
    { name: 'docProps/custom.xml', data: '<Properties><property pid="2"><vt:lpstr>绝密自定义</vt:lpstr></property></Properties>' },
    { name: 'customXml/item1.xml', data: '<Schema><Item>内部资料</Item><Flag level="机密">x</Flag><Mid>中间绝密</Mid></Schema>' },
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="内部表1"/><sheet name="普通"/></sheets>' +
      '<definedNames><definedName name="机密口径">S1!A1</definedName></definedNames></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>内部单元格</t></si><si><t>中间机密</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
      '<row><c t="inlineStr"><is><t>首行机密</t></is></c></row>' +
      '<row><c t="inlineStr"><is><t>中间内部</t></is></c></row>' +
      '<row><f>IF(1,"内部公式",2)</f><v>0</v></row>' +
      '<row><c r="A9" t="str"><f>CONCATENATE("机密","数据")</f><v>机密数据</v></c></row>' +
      '</sheetData></worksheet>' },
    { name: 'xl/comments1.xml', data: '<comments><authors><author>绝密作者</author></authors><commentList><comment ref="A1"><text><r><t>机密批注</t></r></text></comment></commentList></comments>' },    { name: 'xl/threadedComments/threadedComment1.xml', data: '<threadedComments><threadedComment ref="A1" personId="0"><text>内部线程批注</text></threadedComment></threadedComments>' },    { name: 'xl/richData/rdrichvalue.xml', data: '<rdRichValues><rv><v>内部富值</v></rv></rdRichValues>' },    { name: 'ppt/comments/modernComment1.xml', data: '<p:cmLst xmlns:p="urn:p" xmlns:a="urn:a"><p:cm authorId="0" dt="t" idx="1"><a:t>机密现代评论</a:t></p:cm></p:cmLst>' },
    { name: 'xl/tables/table1.xml', data: '<table name="内部表" displayName="内部表"><tableColumns><tableColumn name="机密列"/></tableColumns></table>' },
    { name: 'xl/pivotCache/pivotCacheDefinition1.xml', data: '<pivotCacheDefinition><cacheFields><cacheField name="内部字段" caption="机密说明"><sharedItems><s v="绝密值"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>' },
    { name: 'xl/queryTables/queryTable1.xml', data: '<queryTable name="内部查询"><queryTableFields><queryTableField name="机密条件"/></queryTableFields></queryTable>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="内部形状" descr="机密替代文字"/></p:nvSpPr>' +
      '<p:txBody><a:p><a:r><a:t>机密幻灯片文字</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>内部备注</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>' },
  ];
  const embedName = 'word/embeddings/Microsoft_Excel_Worksheet1.xlsx';

  const packed = await D.DWRZip.pack(xmlParts.concat([
    { name: embedName, data: new Uint8Array(await nestedZip.arrayBuffer()) },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Target="内部资料.docx"/></Relationships>' },
    { name: 'word/vbaProject.bin', data: new Uint8Array([1, 2, 3, 4]) },
  ]));

  const before = await D.DWRDoc.scanOffice(await packed.arrayBuffer(), engine);
  check('不变量-清理前能扫到全部敏感词',
    before.hits > 0 && WORDS.every((w) => before.matched.indexOf(w) >= 0),
    'hits=' + before.hits + ' matched=' + JSON.stringify(before.matched));

  const res = await D.DWRDoc.processOffice(await packed.arrayBuffer(), engine);
  check('不变量-清理过程判定为有改动', res.touched && res.hits === before.hits,
    'touched=' + res.touched + ' hits=' + res.hits);

  const after = await D.DWRDoc.scanOffice(await res.blob.arrayBuffer(), engine);
  check('不变量-清理后重新扫描 0 命中', after.hits === 0, 'hits=' + after.hits + ' matched=' + JSON.stringify(after.matched));

  const out = await D.DWRZip.load(await res.blob.arrayBuffer());
  const leaked = [];
  for (const p of xmlParts) {
    const txt = await out.getText(p.name);
    const hit = WORDS.filter((w) => txt && txt.indexOf(w) >= 0);
    if (hit.length) leaked.push(p.name + '=' + hit.join('|'));
  }
  check('不变量-逐个部件无残留', leaked.length === 0, leaked.join('; '));

  // 内嵌 Office 文档应被递归清理
  const nb = await out.getBytes(embedName);
  const nested = await D.DWRZip.load(nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength));
  const nestedWb = await nested.getText('xl/workbook.xml');
  const nestedSs = await nested.getText('xl/sharedStrings.xml');
  check('不变量-内嵌文档已递归清理',
    !!nestedWb && nestedWb.indexOf('内部') === -1 && !!nestedSs && nestedSs.indexOf('机密') === -1,
    'wb=' + nestedWb + ' ss=' + nestedSs);
  check('不变量-内嵌文档结构未坏', !!nestedWb && /name="[^"]+"/.test(nestedWb), 'wb=' + nestedWb);

  // .rels 与二进制部件按设计保持原样
  const rels = await out.getText('word/_rels/document.xml.rels');
  check('不变量-rels 目标保持原样', !!rels && rels.indexOf('Target="内部资料.docx"') >= 0, 'rels=' + rels);
  const vba = await out.getBytes('word/vbaProject.bin');
  check('不变量-二进制条目字节保真', !!vba && vba.length === 4 && vba[3] === 4, 'len=' + (vba && vba.length));

  // 同一份样本切回默认范围（仅首行+尾行）：元数据部件仍必须全清，正文才遵循范围
  const flEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  });
  const flRes = await D.DWRDoc.processOffice(await packed.arrayBuffer(), flEngine);
  const flOut = await D.DWRZip.load(await flRes.blob.arrayBuffer());
  const metaParts = [
    'docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml', 'customXml/item1.xml',
    'xl/workbook.xml', 'xl/tables/table1.xml',
    'xl/pivotCache/pivotCacheDefinition1.xml', 'xl/queryTables/queryTable1.xml',
    'xl/threadedComments/threadedComment1.xml', 'ppt/comments/modernComment1.xml',
  ];
  const flLeaks = [];
  for (const name of metaParts) {
    const txt = await flOut.getText(name);
    const hit = WORDS.filter((w) => txt && txt.indexOf(w) >= 0);
    if (hit.length) flLeaks.push(name + '=' + hit.join('|'));
  }
  check('不变量-首尾范围下元数据部件仍全清', flLeaks.length === 0, flLeaks.join('; '));
  const flDoc = await flOut.getText('word/document.xml');
  check('不变量-首尾范围下首段已清', flDoc.indexOf('<w:t>内部</w:t>') === -1, flDoc.slice(0, 200));
  check('不变量-首尾范围下尾段已清', flDoc.indexOf('绝密书签') === -1, flDoc.slice(-200));
  check('不变量-首尾范围下中间段保留', flDoc.indexOf('秘密附件') >= 0, flDoc.slice(0, 260));
  check('不变量-首尾范围下属性值全清', flDoc.indexOf('instr="内部指令"') === -1, flDoc.slice(-200));
}


// ---------- 8) firstlast #############tags ######## ----------
// word #### w:t / w:delText / w:instrText #### <w:p>#########
// ##################w:t ####################delText/instrText ########
{
  const fl = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  });

  // #########delText / instrText####w:t #############
  const parts = [
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:r><w:t>A0-内部附件</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>A1-秘密正文</w:t></w:r></w:p>' +
      '<w:p><w:del><w:r><w:delText>A2-机密删除记录</w:delText></w:r></w:del></w:p>' +
      '<w:p><w:r><w:instrText xml:space="preserve"> REF A3-绝密域 </w:instrText></w:r></w:p>' +
      '</w:body></w:document>' },
  ];
  const res = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), fl);
  const zip = await D.DWRZip.load(await res.blob.arrayBuffer());
  const doc = await zip.getText('word/document.xml');
  check('firstlast-跨标签-首段已清', doc.indexOf('A0-') !== -1 && doc.indexOf('内部附件') === -1, doc);
  check('firstlast-跨标签-中间段保留', doc.indexOf('A1-秘密正文') !== -1, doc);
  // ###############delText #################firstlast ####
  check('firstlast-跨标签-中间delText保留', doc.indexOf('A2-机密删除记录') !== -1, doc);

  // ########delText #########
  const parts4 = [
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:r><w:t>D0-内部附件</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>D1-秘密正文</w:t></w:r></w:p>' +
      '<w:p><w:del><w:r><w:delText>D2-机密删除记录</w:delText></w:r></w:del></w:p>' +
      '</w:body></w:document>' },
  ];
  const res4 = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts4)).arrayBuffer(), fl);
  const doc4 = await (await D.DWRZip.load(await res4.blob.arrayBuffer())).getText('word/document.xml');
  check('firstlast-delText尾段-首段已清', doc4.indexOf('D0-内部附件') === -1, doc4);
  check('firstlast-delText尾段-中间段保留', doc4.indexOf('D1-秘密正文') !== -1, doc4);
  check('firstlast-delText尾段-尾段已清', doc4.indexOf('D2-机密删除记录') === -1, doc4);
  check('firstlast-跨标签-instrText尾段已清', doc.indexOf('A3-绝密域') === -1, doc);
  check('firstlast-跨标签-首尾命中标记', res.firstHit === true && res.lastHit === true,
    JSON.stringify({ f: res.firstHit, l: res.lastHit }));

  // 文本框 <a:p> 嵌在 <w:p> 里：算不算首尾由外层段落决定（v2.21）
  const parts2 = [
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:r><w:t>B0-内部附件</w:t></w:r></w:p>' +
      '<w:p><w:pict><v:shape><v:textbox><w:txbxContent><a:p><a:r><a:t>B1-内部说明</a:t></a:r></a:p></w:txbxContent></v:textbox></v:shape></w:pict></w:p>' +
      '<w:p><w:r><w:t>B2-机密附件</w:t></w:r></w:p>' +
      '</w:body></w:document>' },
  ];
  const res2 = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts2)).arrayBuffer(), fl);
  const doc2 = await (await D.DWRZip.load(await res2.blob.arrayBuffer())).getText('word/document.xml');
  check('firstlast-跨标签-中段文本框保留', doc2.indexOf('B1-内部说明') !== -1, doc2);
  check('firstlast-跨标签-文本框不影响首尾判定', doc2.indexOf('B0-内部附件') === -1 && doc2.indexOf('B2-机密附件') === -1, doc2);

  // 文本框落在首段 / 尾段里时照旧清理（首段整段是文本框、无 <w:t> 也要算）
  const parts2b = [
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:pict><v:shape><v:textbox><w:txbxContent><a:p><a:r><a:t>D0-内部文本框</a:t></a:r></a:p></w:txbxContent></v:textbox></v:shape></w:pict></w:p>' +
      '<w:p><w:r><w:t>D1-秘密正文</w:t></w:r></w:p>' +
      '<w:p><w:pict><v:shape><v:textbox><w:txbxContent><a:p><a:r><a:t>D2-机密文本框</a:t></a:r></a:p></w:txbxContent></v:textbox></v:shape></w:pict></w:p>' +
      '</w:body></w:document>' },
  ];
  const res2b = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts2b)).arrayBuffer(), fl);
  const doc2b = await (await D.DWRZip.load(await res2b.blob.arrayBuffer())).getText('word/document.xml');
  check('firstlast-跨标签-首尾段文本框已清',
    doc2b.indexOf('D0-内部文本框') === -1 && doc2b.indexOf('D2-机密文本框') === -1
      && doc2b.indexOf('D1-秘密正文') !== -1, doc2b);
  check('firstlast-跨标签-首尾段文本框无残留', /<a:t>[^<]*(?:内部|机密)[^<]*<\/a:t>/.test(doc2b) === false, doc2b);

  // xlsx inlineStr：仅首行 / 尾行参与清理
  const parts3 = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
      '<row><c t="inlineStr"><is><t>C0-内部表头</t></is></c></row>' +
      '<row><c t="inlineStr"><is><t>C1-秘密数据</t></is></c></row>' +
      '<row><c t="inlineStr"><is><t>C2-机密表尾</t></is></c></row>' +
      '</sheetData></worksheet>' },
  ];
  const res3 = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts3)).arrayBuffer(), fl);
  const sheet = await (await D.DWRZip.load(await res3.blob.arrayBuffer())).getText('xl/worksheets/sheet1.xml');
  check('firstlast-xlsx-首行已清', sheet.indexOf('C0-内部表头') === -1, sheet);
  check('firstlast-xlsx-中间行保留', sheet.indexOf('C1-秘密数据') !== -1, sheet);
  check('firstlast-xlsx-尾行已清', sheet.indexOf('C2-机密表尾') === -1, sheet);

  // xlsx：共享字符串（xl/sharedStrings.xml 的 <si>）与内联字符串（sheet 里的 <is>）
  // 分处不同部件，各自按部件内首 / 尾取范围。Excel 通常按首次使用顺序写共享字符串，
  // 因此 si[0] / si[last] 与首行 / 尾行基本对得上；此处只锁定这一语义，避免回退。
  const parts2d = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>E0-内部共享</t></si><si><t>E1-秘密共享</t></si><si><t>E2-机密共享</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
      '<row><c t="inlineStr"><is><t>F0-内部内联</t></is></c></row>' +
      '<row><c t="inlineStr"><is><t>F1-秘密内联</t></is></c></row>' +
      '<row><c t="inlineStr"><is><t>F2-机密内联</t></is></c></row>' +
      '</sheetData></worksheet>' },
  ];
  const res2d = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts2d)).arrayBuffer(), fl);
  const out2d = await D.DWRZip.load(await res2d.blob.arrayBuffer());
  const sst2d = await out2d.getText('xl/sharedStrings.xml');
  const sheet2d = await out2d.getText('xl/worksheets/sheet1.xml');
  check('firstlast-共享字符串-首尾已清中段保留',
    sst2d.indexOf('E0-内部共享') === -1 && sst2d.indexOf('E2-机密共享') === -1
      && sst2d.indexOf('E1-秘密共享') !== -1, 'sst=' + sst2d);
  check('firstlast-内联字符串-首尾已清中段保留',
    sheet2d.indexOf('F0-内部内联') === -1 && sheet2d.indexOf('F2-机密内联') === -1
      && sheet2d.indexOf('F1-秘密内联') !== -1, 'sheet=' + sheet2d);
  check('firstlast-si/is-清理后重扫 0 命中',
    (await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(parts2d)).arrayBuffer(), fl)).hits > 0
      && (await D.DWRDoc.scanOffice(await res2d.blob.arrayBuffer(), fl)).hits === 0,
    'hits=' + res2d.hits);
  // 页眉页脚 / 脚注 / 尾注 / 批注 / 术语库是跨页附属自由文本，没有「首行 / 尾行」语义，
  // 一律整部件清理（与 xl/comments*、xl/threadedComments、ppt/comments 对齐，v2.22）；
  // 只有 word/document.xml 才谈首尾范围。
  const auxParts = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body>'
      + '<w:p><w:r><w:t>G0-内部首段</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>G1-秘密中段</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>G2-机密尾段</w:t></w:r></w:p>'
      + '</w:body></w:document>' },
    { name: 'word/footnotes.xml', data: '<w:footnotes>'
      + '<w:p><w:r><w:t>H0-内部脚注一</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>H1-秘密脚注二</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>H2-绝密脚注三</w:t></w:r></w:p></w:footnotes>' },
    { name: 'word/endnotes.xml', data: '<w:endnotes>'
      + '<w:p><w:r><w:t>I0-内部尾注一</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>I1-秘密尾注二</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>I2-绝密尾注三</w:t></w:r></w:p></w:endnotes>' },
    { name: 'word/comments.xml', data: '<w:comments>'
      + '<w:comment w:id="1" w:author="内部作者"><w:p><w:r><w:t>J0-内部批注一</w:t></w:r></w:p></w:comment>'
      + '<w:comment w:id="2" w:author="机密作者"><w:p><w:r><w:t>J1-秘密批注二</w:t></w:r></w:p></w:comment>'
      + '<w:comment w:id="3" w:author="绝密作者"><w:p><w:r><w:t>J2-绝密批注三</w:t></w:r></w:p></w:comment></w:comments>' },
    { name: 'word/header1.xml', data: '<w:hdr>'
      + '<w:p><w:r><w:t>K0-内部页眉一</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>K1-秘密页眉二</w:t></w:r></w:p></w:hdr>' },
    { name: 'word/footer1.xml', data: '<w:ftr>'
      + '<w:p><w:r><w:t>L0-机密页脚</w:t></w:r></w:p></w:ftr>' },
    { name: 'word/glossary/document.xml', data: '<w:glossaryDocument><w:docParts>'
      + '<w:p><w:r><w:t>M0-内部术语一</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>M1-秘密术语二</w:t></w:r></w:p></w:docParts></w:glossaryDocument>' },
  ];
  const auxScan = await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(auxParts)).arrayBuffer(), fl);
  // 16 处正文命中 + comments.xml 里 3 个评论作者属性值
  check('firstlast-附属部件-扫描全部命中', auxScan.hits === 19
    && ['内部', '机密', '秘密', '绝密'].every((w) => auxScan.matched.indexOf(w) >= 0),
    'hits=' + auxScan.hits + ' ' + JSON.stringify(auxScan.matched));
  const auxRes = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(auxParts)).arrayBuffer(), fl);
  check('firstlast-附属部件-清理命中数与扫描一致', auxRes.hits === auxScan.hits, 'res=' + auxRes.hits + ' scan=' + auxScan.hits);
  const auxOut = await D.DWRZip.load(await auxRes.blob.arrayBuffer());
  const auxDoc = await auxOut.getText('word/document.xml');
  check('firstlast-附属部件-正文仍遵守首尾范围',
    auxDoc.indexOf('G0-内部首段') === -1 && auxDoc.indexOf('G2-机密尾段') === -1
      && auxDoc.indexOf('G1-秘密中段') !== -1, auxDoc);
  const auxLeak = [];
  for (const p of auxParts) {
    if (p.name === 'word/document.xml' || p.name === '[Content_Types].xml') continue;
    const txt = await auxOut.getText(p.name);
    const hit = ['内部', '秘密', '机密', '绝密'].filter((w) => txt.indexOf(w) >= 0);
    if (hit.length) auxLeak.push(p.name + '=' + hit.join('|'));
  }
  check('firstlast-附属部件-页眉页脚脚注尾注批注术语全清', auxLeak.length === 0, auxLeak.join('; '));
  check('firstlast-附属部件-清理后重扫 0 命中',
    (await D.DWRDoc.scanOffice(await auxRes.blob.arrayBuffer(), fl)).hits === 0);
}

// ---------- 9) ppt 附属部件：版式 / 母版 / 备注 / 讲义 / 图示整部件，仅幻灯片谈首尾 ----------
// 版式 / 母版是占位符与页脚提示的模板，备注母版 / 讲义母版覆盖全部备注页与讲义页，
// drawings（SmartArt 图示）是自由文本——都没有「首行 / 尾行」语义，按首尾取范围只会清掉
// 第一个 / 最后一个文本块，中段的密级标识整段留下。故这些部件一律整部件清理（v2.23），
// 与 word 附属部件、xl/comments*、ppt/comments 口径一致；只有 ppt/slides/* 按首尾范围。
{
  const mkEng = (scope) => D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: scope, action: 'delete', custom: '',
  });
  const fl = mkEng('firstlast');
  const all = mkEng('all');
  const mk3 = (a, b, c) => '<p:sp><p:txBody><a:p><a:r><a:t>' + a + '</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>' + b + '</a:t></a:r></a:p>'
    + '<a:p><a:r><a:t>' + c + '</a:t></a:r></a:p></p:txBody></p:sp>';
  const pptParts = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld><p:cSld><p:spTree>' + mk3('内部标题一', '秘密正文二', '绝密结尾三') + '</p:spTree></p:cSld></p:sld>' },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: '<p:sldLayout><p:cSld><p:spTree>' + mk3('内部版式一', '秘密版式二', '绝密版式三') + '</p:spTree></p:cSld></p:sldLayout>' },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: '<p:sldMaster><p:cSld><p:spTree>' + mk3('内部母版一', '秘密母版二', '绝密母版三') + '</p:spTree></p:cSld></p:sldMaster>' },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes><p:cSld><p:spTree>' + mk3('内部备注一', '秘密备注二', '绝密备注三') + '</p:spTree></p:cSld></p:notes>' },
    { name: 'ppt/notesMasters/notesMaster1.xml', data: '<p:notesMaster><p:cSld><p:spTree>' + mk3('内部备注母版一', '秘密备注母版二', '绝密备注母版三') + '</p:spTree></p:cSld></p:notesMaster>' },
    { name: 'ppt/handoutMasters/handoutMaster1.xml', data: '<p:handoutMaster><p:cSld><p:spTree>' + mk3('内部讲义一', '秘密讲义二', '绝密讲义三') + '</p:spTree></p:cSld></p:handoutMaster>' },
    { name: 'ppt/drawings/drawing1.xml', data: '<dsp:dataModel>' + mk3('机密图示一', '秘密图示二', '绝密图示三') + '</dsp:dataModel>' },
  ];
  // 幻灯片 3 段只命中首尾 2 处，其余 6 个附属部件各 3 处 = 20
  const pptScan = await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(pptParts)).arrayBuffer(), fl);
  check('ppt-附属部件-扫描全部命中', pptScan.hits === 20
    && ['内部', '机密', '秘密', '绝密'].every((w) => pptScan.matched.indexOf(w) >= 0),
    'hits=' + pptScan.hits + ' ' + JSON.stringify(pptScan.matched));
  const pptRes = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(pptParts)).arrayBuffer(), fl);
  check('ppt-附属部件-清理命中数与扫描一致', pptRes.hits === pptScan.hits, 'res=' + pptRes.hits + ' scan=' + pptScan.hits);
  const pptOut = await D.DWRZip.load(await pptRes.blob.arrayBuffer());
  const slide1 = await pptOut.getText('ppt/slides/slide1.xml');
  const auxNames = pptParts.filter((p) => p.name !== 'ppt/slides/slide1.xml' && p.name !== '[Content_Types].xml').map((p) => p.name);
  check('ppt-附属部件-幻灯片仍遵守首尾范围',
    slide1.indexOf('内部标题一') === -1 && slide1.indexOf('绝密结尾三') === -1
      && slide1.indexOf('秘密正文二') !== -1, slide1);
  const pptLeak = [];
  for (const n of auxNames) {
    const txt = await pptOut.getText(n);
    const hit = ['内部', '秘密', '机密', '绝密'].filter((w) => txt.indexOf(w) >= 0);
    if (hit.length) pptLeak.push(n + '=' + hit.join('|'));
  }
  check('ppt-附属部件-版式母版备注讲义图示全清', pptLeak.length === 0, pptLeak.join('; '));
  // 默认范围下唯一残留是幻灯片中段那一处：幻灯片是逐页流动内容，仍按首尾口径（与 word 正文一致）
  check('ppt-附属部件-全量口径仅剩幻灯片中段',
    (await D.DWRDoc.scanOffice(await pptRes.blob.arrayBuffer(), all)).hits === 1,
    'hits=' + (await D.DWRDoc.scanOffice(await pptRes.blob.arrayBuffer(), all)).hits);
  const resAll = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(pptParts)).arrayBuffer(), all);
  const outAll = await D.DWRZip.load(await resAll.blob.arrayBuffer());
  const leakAll = [];
  for (const n of pptParts.filter((p) => p.name !== '[Content_Types].xml').map((p) => p.name)) {
    if (/内部|秘密|机密|绝密/.test(await outAll.getText(n))) leakAll.push(n);
  }
  check('ppt-scope=all-幻灯片中段也已清', leakAll.length === 0 && resAll.hits === 21,
    'hits=' + resAll.hits + ' leak=' + leakAll.join('|'));
}

// ---------- 10) Word 文本框（w:txbxContent）内的 <w:p> 嵌在外层 <w:p> 里 ----------
// 旧实现按 <w:p> 的懒惰匹配只到内层 </w:p> 就结束，两个后果：
//   ① 外层段里「文本框之后」的 run 落在所有块之外，即使 scope=all 也整段漏清；
//   ② 外层段的文本节点把文本框里的文字一并吸进来，重建时整段文本被搬进第一个 run，
//      文本框自己反而被清空（内容错位）。
// 现由 maskNestedWord 把文本框内部的 <w:p> / <w:t> 临时改名，外层段与文本框内段落各自成块，
// 算不算首尾仍由外层 <w:p> 决定（v2.24）。
{
  const mk = (scope) => D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true, notBefore: p.notBefore, notAfter: p.notAfter })),
    scope: scope, action: 'delete', custom: '',
  });
  const fl = mk('firstlast');
  const all = mk('all');
  const t = (x) => '<w:r><w:t>' + x + '</w:t></w:r>';
  const tbx = (inner) => '<w:drawing><wp:anchor><a:graphic><a:graphicData uri="u"><wps:wsp><wps:txbx><w:txbxContent>'
    + inner + '</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>';
  const doc = '<w:document><w:body>'
    + '<w:p>' + t('T0-内部首段') + '</w:p>'
    + '<w:p>' + t('正文前半') + '<w:r>' + tbx('<w:p>' + t('机密文本框') + '</w:p>') + '</w:r>' + t('正文后半绝密字样') + '</w:p>'
    + '<w:p>' + t('T2-秘密尾段') + '</w:p>'
    + '</w:body></w:document>';
  const parts = [{ name: 'word/document.xml', data: doc }];
  const sAll = await D.DWRDoc.scanOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), all);
  check('tbx-全文范围扫描全部命中', sAll.hits === 4 && sAll.matched.length === 4, 'scan=' + sAll.hits + ' ' + JSON.stringify(sAll.matched));
  const rAll = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), all);
  check('tbx-全文范围清理命中数与扫描一致', rAll.hits === sAll.hits, 'res=' + rAll.hits);
  const outAll = await (await D.DWRZip.load(await rAll.blob.arrayBuffer())).getText('word/document.xml');
  check('tbx-全文范围无残留', !/内部|秘密|机密|绝密/.test(outAll), outAll);
  // 文本框内的文字必须留在文本框里，不能被搬进外层段落的第一个 run
  check('tbx-文本框内容原位保留', /<w:txbxContent><w:p><w:r><w:t>文本框<\/w:t><\/w:r><\/w:p><\/w:txbxContent>/.test(outAll), outAll);
  check('tbx-外层段文字不串位', outAll.indexOf('正文前半正文后半字样') >= 0, outAll);
  check('tbx-无临时标签残留', outAll.indexOf('dwr-nest') < 0, outAll);
  // 默认范围（首行+尾行）：中段段落（含它的文本框）应原样保留
  const rFl = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), fl);
  const outFl = await (await D.DWRZip.load(await rFl.blob.arrayBuffer())).getText('word/document.xml');
  check('tbx-首尾段已清中段保留',
    outFl.indexOf('T0-内部首段') === -1 && outFl.indexOf('T2-秘密尾段') === -1
      && outFl.indexOf('机密文本框') !== -1 && outFl.indexOf('正文后半绝密字样') !== -1, outFl);
  // 多段文本框、同段两个文本框、嵌套文本框、VML 文本框、表格内文本框：全文范围下都要清零
  const shapes = {
    '多段文本框': tbx('<w:p>' + t('内部一') + '</w:p><w:p>' + t('秘密二') + '</w:p>'),
    '同段两个文本框': tbx('<w:p>' + t('机密一号') + '</w:p>') + t('中间绝密') + tbx('<w:p>' + t('秘密二号') + '</w:p>'),
    '嵌套文本框': tbx('<w:p>' + t('机密外层') + tbx('<w:p>' + t('绝密内层') + '</w:p>') + '</w:p>'),
    'VML文本框': '<w:pict><v:shape><v:textbox>' + tbx('<w:p>' + t('机密VML') + '</w:p>') + '</v:textbox></v:shape></w:pict>',
    '表格内文本框': '<w:tbl><w:tr><w:tc><w:p>' + t('机密表格') + '</w:p><w:p>' + tbx('<w:p>' + t('绝密格内') + '</w:p>') + '</w:p></w:tc></w:tr></w:tbl>',
  };
  for (const label of Object.keys(shapes)) {
    const d = '<w:document><w:body><w:p>' + shapes[label] + '</w:p></w:body></w:document>';
    const r = await D.DWRDoc.processOffice(await (await D.DWRZip.pack([{ name: 'word/document.xml', data: d }])).arrayBuffer(), all);
    const o = await (await D.DWRZip.load(await (r.blob ? r.blob.arrayBuffer() : (await D.DWRZip.pack([{ name: 'word/document.xml', data: d }])).arrayBuffer()))).getText('word/document.xml');
    check('tbx-' + label + '-全文范围清零', !/内部|秘密|机密|绝密/.test(o) && o.indexOf('dwr-nest') < 0, o);
  }
  // 预览口径与处理一致：文本框前后的正文都不缺、不重
  const t2 = await D.DWRDoc.extractText(await (await D.DWRZip.pack([{ name: 'word/document.xml', data: doc }])).arrayBuffer());
  // 首行是以方括号包裹的可读定位行（[正文]），不是文档内容，剥掉再逐行断言
  const lines = t2.split('\n').slice(1);
  // 预览按段合并 run（与 processXml 同口径）：同段的「正文前半 / 正文后半绝密字样」是一行，
  // 逐 <w:t> 成行会让被 run 拆写的词断行判不中，扫描报命中而预览不高亮。
  check('tbx-预览覆盖全部文本且不重复',
    lines.indexOf('T0-内部首段') >= 0 && lines.indexOf('正文前半正文后半绝密字样') >= 0
      && lines.indexOf('机密文本框') >= 0 && lines.indexOf('T2-秘密尾段') >= 0
      && lines.filter(function (l) { return l === '机密文本框'; }).length === 1,
    JSON.stringify(lines));
  // 未命中的文档必须字节级不变（改名后必须完整改回）
  const clean = '<w:document><w:body><w:p>' + t('普通正文') + '</w:p><w:p>' + t('段落A') + tbx('<w:p>' + t('框内普通文字') + '</w:p>') + '</w:p></w:body></w:document>';
  const rClean = await D.DWRDoc.processOffice(await (await D.DWRZip.pack([{ name: 'word/document.xml', data: clean }])).arrayBuffer(), all);
  const outClean = rClean.blob ? await (await D.DWRZip.load(await rClean.blob.arrayBuffer())).getText('word/document.xml') : clean;
  check('tbx-未命中文档字节级不变', rClean.hits === 0 && outClean === clean, JSON.stringify(outClean));
}

// ---------- 11) 空运行清理不得跨 run 吞内容（v2.25 准确性修复） ----------
// 旧实现用一条整段正则清理「被合并清空的运行」，其中可选的 rPr 组是 [\s\S]*?</w:rPr>：
// 当某个带 rPr 的 run 仍有文字时该组失配，回溯会越过若干 run 去接后面的 </w:rPr>，
// 于是「粗体标题 run + 斜体密级词 run + 斜体正文 run」这种最常见的三段式会被整段删空。
// 现在按 <x:r> 边界切片后逐个判定，绝不跨 run 匹配。
{
  const mk = (scope) => D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: "text", enabled: true, notBefore: p.notBefore, notAfter: p.notAfter })),
    scope: scope, action: "delete", custom: "",
  });
  const all = mk("all");
  const fl = mk("firstlast");
  const t = (x) => "<w:r><w:t>" + x + "</w:t></w:r>";
  const one = async (doc, e) => {
    const parts = [{ name: "word/document.xml", data: doc }];
    const r = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(parts)).arrayBuffer(), e);
    const out = r.blob ? await (await D.DWRZip.load(await r.blob.arrayBuffer())).getText("word/document.xml") : doc;
    return { r: r, out: out };
  };
  const WORDS_RE = /内部|秘密|机密|绝密/;

  // ① 标题 + 密级词 + 正文：标题与正文都必须留下（旧版会整段删空）
  const docA = "<w:document><w:body><w:p>"
    + "<w:r><w:rPr><w:b/></w:rPr><w:t>文字绝密</w:t></w:r>"
    + "<w:r><w:rPr><w:i/></w:rPr><w:t>尾部</w:t></w:r>"
    + "<w:r><w:t>内部</w:t></w:r>"
    + "</w:p></w:body></w:document>";
  const a = await one(docA, all);
  check("emptyrun-三段run不吞内容", a.out.indexOf("文字尾部") >= 0 && !WORDS_RE.test(a.out)
    && /<w:rPr><w:b\/><\/w:rPr><w:t>文字尾部<\/w:t>/.test(a.out), a.out);
  check("emptyrun-三段run只剩一个run", (a.out.match(/<w:r(?:\s|>)/g) || []).length === 1, a.out);
  check("emptyrun-命中数与扫描一致", a.r.hits === 2, "hits=" + a.r.hits);

  // ② 含 <w:drawing/> / <w:br/> 的 run 不参与清理（删掉会改变换行与排版）
  const docB = "<w:document><w:body><w:p>"
    + "<w:r><w:rPr><w:b/></w:rPr><w:t>标题绝密</w:t></w:r>"
    + "<w:r><w:drawing/><w:br/></w:r>"
    + "<w:r><w:rPr><w:i/></w:rPr><w:t>正文</w:t></w:r>"
    + "</w:p></w:body></w:document>";
  const b = await one(docB, all);
  check("emptyrun-含drawing的run保留", b.out.indexOf("<w:drawing/><w:br/>") >= 0 && b.out.indexOf("标题正文") >= 0
    && !WORDS_RE.test(b.out), b.out);

  // ③ 被合并清空的 run（rPr + 空文本节点）应被清掉；只有 rPr / 自闭合空文本节点 /
  //    含 <w:br/> 等其它内容的 run 一律保留（删掉会改变换行与排版）
  const docC = "<w:document><w:body><w:p>"
    + "<w:r><w:rPr><w:b/></w:rPr><w:t>机密内容</w:t></w:r>"
    + "<w:r><w:rPr><w:b/></w:rPr><w:t></w:t></w:r>"
    + "<w:r><w:t></w:t></w:r>"
    + "<w:r><w:br/></w:r>"
    + "<w:r><w:rPr><w:b/></w:rPr></w:r>"
    + "<w:r><w:t/></w:r>"
    + "<w:r><w:t>正文</w:t></w:r>"
    + "</w:p></w:body></w:document>";
  const c = await one(docC, all);
  check("emptyrun-空文本节点run被清理", (c.out.match(/<w:r(?:\s|>)/g) || []).length === 4 && c.out.indexOf("内容正文") >= 0, c.out);
  check("emptyrun-只留有效run", c.out.indexOf("<w:br/>") >= 0 && c.out.indexOf("<w:t/>") >= 0
    && /<w:r><w:rPr><w:b\/><\/w:rPr><\/w:r>/.test(c.out) && !/<w:t><\/w:t>/.test(c.out), c.out);

  // ④ firstlast：首段里的多段文本框，所有子段都算首段范围（中段不误清）
  const tbx = (inner) => "<w:drawing><wp:anchor><a:graphic><a:graphicData uri=\"u\"><wps:wsp><wps:txbx><w:txbxContent>"
    + inner + "</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>";
  const docD = "<w:document><w:body>"
    + "<w:p>" + tbx("<w:p>" + t("A-绝密甲") + "</w:p><w:p>" + t("B-机密乙") + "</w:p><w:p>" + t("C-秘密丙") + "</w:p>") + "</w:p>"
    + "<w:p>" + t("D-内部中段") + "</w:p>"
    + "<w:p>" + t("E-绝密尾段") + "</w:p>"
    + "</w:body></w:document>";
  const d = await one(docD, fl);
  check("nest-首段多段文本框全部清除", !/绝密|机密|秘密/.test(d.out) && d.out.indexOf("D-内部中段") >= 0, d.out);
  check("nest-中段文本框不误清", d.out.indexOf("D-内部中段") >= 0 && d.out.indexOf("dwr-nest") < 0, d.out);
  const d2 = await one(docD, all);
  check("nest-首段多段文本框全文清除", !WORDS_RE.test(d2.out), d2.out);

  // ⑤ 真实 VML 文本框（<v:textbox> 里直接放 <w:p>，没有 w:txbxContent）
  const vml = (inner) => "<w:pict><v:shape id=\"s\"><v:textbox>" + inner + "</v:textbox></v:shape></w:pict>";
  const docE = "<w:document><w:body>"
    + "<w:p>" + vml("<w:p>" + t("F-机密VML一") + "</w:p><w:p>" + t("G-秘密VML二") + "</w:p>") + "</w:p>"
    + "<w:p>" + t("H-内部中段") + "</w:p>"
    + "<w:p>" + t("I-绝密尾段") + "</w:p>"
    + "</w:body></w:document>";
  const e = await one(docE, fl);
  check("nest-VML文本框首段全清", !/机密|秘密|绝密/.test(e.out) && e.out.indexOf("H-内部中段") >= 0, e.out);
  check("nest-VML文本框结构完整",
    (e.out.match(/<v:textbox>/g) || []).length === 1 && (e.out.match(/<\/v:textbox>/g) || []).length === 1
      && (e.out.match(/<w:pict>/g) || []).length === 1 && e.out.indexOf("dwr-nest") < 0
      && e.out.indexOf("<w:document>") >= 0, e.out);

  // ⑥ 两层嵌套 + 外层尾部 run：外层段尾 run 不能被漏清，也不能把框内文字吸进来
  const docF = "<w:document><w:body><w:p>"
    + t("J-机密前") + tbx("<w:p>" + t("K-机密一层") + tbx("<w:p>" + t("L-绝密二层") + "</w:p>") + t("M-秘密一层尾") + "</w:p>")
    + t("N-内部后")
    + "</w:p></w:body></w:document>";
  const f = await one(docF, fl);
  check("nest-两层嵌套首段全清", !WORDS_RE.test(f.out), f.out);
  check("nest-外层尾run文字保留", f.out.indexOf("J-前N-后") >= 0, f.out);
  check("nest-框内文字不被搬进外层段", f.out.indexOf("<w:txbxContent><w:p><w:r><w:t>K-一层") >= 0, f.out);

  // ⑥.2 ppt 幻灯片：drawingML 里自闭合 <a:rPr b="1"/> 的空 run 同样要清掉
  const slideParts = [{ name: "ppt/slides/slide1.xml", data: "<p:sld><p:cSld><p:spTree><p:sp><p:txBody>"
    + "<a:p><a:r><a:rPr b=\"1\"/><a:t>机密A</a:t></a:r><a:r><a:rPr i=\"1\"/><a:t>正文B</a:t></a:r></a:p>"
    + "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>" }];
  const gRes = await D.DWRDoc.processOffice(await (await D.DWRZip.pack(slideParts)).arrayBuffer(), all);
  const gOut = await (await D.DWRZip.load(await gRes.blob.arrayBuffer())).getText("ppt/slides/slide1.xml");
  check("emptyrun-ppt自闭合rPr空run清理",
    gOut.indexOf("<a:p><a:r><a:rPr b=\"1\"/><a:t>A正文B</a:t></a:r></a:p>") >= 0 && !/机密|秘密|绝密|内部/.test(gOut), gOut);

  // ⑦ 内容守恒：全文跑一遍引擎的期望字符集合，必须与逐块输出一致（专抓「多吃」）
  const textOf = (xml) => {
    const re = /<(?:w:t|a:t|w:delText|w:instrText)(?:\s[^>]*)?>([^<]*)<\/(?:w:t|a:t|w:delText|w:instrText)>/g;
    let s = "", m;
    while ((m = re.exec(xml)) !== null) s += m[1];
    return s;
  };
  const bag = (s) => {
    const b = new Map();
    for (const ch of s) b.set(ch, (b.get(ch) || 0) + 1);
    return b;
  };
  const bagEq = (x, y) => {
    if (x.size !== y.size) return false;
    for (const [k, v] of x) if (y.get(k) !== v) return false;
    return true;
  };
  for (const [nm, doc] of [["A", docA], ["D", docD], ["E", docE], ["F", docF]]) {
    const g = await one(doc, all);
    check("keep-内容守恒-" + nm, bagEq(bag(all.apply(textOf(doc), true, true).text), bag(textOf(g.out)))
      && !WORDS_RE.test(g.out), JSON.stringify(textOf(g.out)));
  }

  // (8) 真实形态文本框：嵌套段落带 w14:paraId / rsid 等属性，改名后必须一个字符不改地还原。
  //    旧 unmask 正则只匹配「以 > 结尾」的标签，真实 Word 段落几乎都带属性，
  //    于是 <w:dwr-nest1-p w14:paraId=...> 原样漏进输出，Word 直接判定文档损坏。
  //    XML 属性值这里用单引号包裹（同样合法），只为在测试源码里避开双引号转义。
  const realTbx = (inner) => "<w:drawing><wp:anchor><a:graphic><a:graphicData uri='u'><wps:wsp><wps:txbx><w:txbxContent>" + inner + "</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing>";
  const docH = "<w:document><w:body><w:p>"
    + t("O-机密标题") + realTbx("<w:p w14:paraId='1A2B3C4D' w14:textId='77777777' w:rsidR='00390768'>"
      + "<w:pPr><w:ind w:left='840'/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>绝密内容</w:t></w:r>"
      + "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space='preserve'>   </w:t></w:r></w:p>")
    + t("P-内部尾") + "</w:p></w:body></w:document>";
  const h = await one(docH, all);
  check("nest-带属性的嵌套标签完全还原",
    h.out.indexOf("dwr-nest") < 0
      && h.out.indexOf("<w:p w14:paraId='1A2B3C4D' w14:textId='77777777' w:rsidR='00390768'>") >= 0
      && h.out.indexOf("</w:p></w:txbxContent>") >= 0
      && h.out.indexOf(`<w:t xml:space="preserve">内容   </w:t>`) >= 0
      && !WORDS_RE.test(h.out), h.out);

  // (9) 嵌在文本框里的纯空白 run：只要它不属于「本次合并清空」的范围，就必须原样留下。
  //    旧实现无差别扫描整个重建串，把文本框里的空白 run 也当空运行删掉，空白随之净丢失。
  const docI = "<w:document><w:body><w:p>"
    + t("Q-机密外层") + realTbx("<w:p w14:paraId='AAAA1111'><w:r><w:t>框内无命中</w:t></w:r>"
      + "<w:r><w:t xml:space='preserve'>     </w:t></w:r></w:p>")
    + "</w:p></w:body></w:document>";
  const i = await one(docI, all);
  check("nest-文本框内纯空白run保留",
    i.out.indexOf("dwr-nest") < 0 && i.out.indexOf("<w:t xml:space='preserve'>     </w:t>") >= 0
      && i.out.indexOf("框内无命中") >= 0 && !WORDS_RE.test(i.out), i.out);

  // (10) 自闭合 <w:t/> 在文本框里也要原样还原（改名 → 还原不得写成开标签）
  const docJ = "<w:document><w:body><w:p>"
    + t("R-机密") + realTbx("<w:p w14:paraId='BBBB2222'><w:r><w:t/></w:r><w:r><w:t>框内文字</w:t></w:r></w:p>")
    + "</w:p></w:body></w:document>";
  const j = await one(docJ, all);
  check("nest-自闭合空文本节点原样还原",
    j.out.indexOf("dwr-nest") < 0 && j.out.indexOf("<w:t/>") >= 0 && j.out.indexOf("框内文字") >= 0
      && j.out.indexOf("<w:p w14:paraId='BBBB2222'>") >= 0 && !WORDS_RE.test(j.out), j.out);

  // (11) 自闭合空段（<w:p/>，Word 空段落常见序列化写法）不得压垮标签栈——
  //     旧实现把它当开标签入栈且永不弹出，闭合标签配对从此错位，掩码后的 XML
  //     里不再有 </w:p>，整部件块正则全部失配：扫描 0 命中、清理零改动（静默漏检）。
  const docK = "<w:document><w:body>"
    + "<w:p>" + t("S-内部标题") + "<w:r><w:pict><v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox></w:pict></w:r>" + t("T-框后正文") + "</w:p>"
    + "<w:p>" + t("U-内部中段") + "</w:p>"
    + "<w:p>" + t("V-机密落款") + "</w:p>"
    + "</w:body></w:document>";
  const k = await one(docK, fl);
  check("selfclose-文本框内自闭合空段不致漏检",
    k.r.hits >= 2 && k.out.indexOf('S-内部标题') === -1
      && k.out.indexOf("T-框后正文") >= 0 && k.out.indexOf("U-内部中段") >= 0, JSON.stringify(k.r.hits) + " " + k.out);
  check("selfclose-自闭合空段原样保留且无改名残留",
    k.out.indexOf("<w:p/>") >= 0 && k.out.indexOf("dwr-nest") < 0, k.out);

  const docL = "<w:document><w:body>"
    + "<w:p>" + t("W-绝密首段") + "</w:p>"
    + "<w:p w14:paraId='7F00001' w14:textId='7F00001'/>"
    + "<w:p>" + t("X-内部中段") + "</w:p>"
    + "<w:p>" + t("Y-机密尾段") + "</w:p>"
    + "</w:body></w:document>";
  const l = await one(docL, fl);
  check("selfclose-正文自闭合空段不致漏检",
    l.r.hits >= 2 && l.out.indexOf("W-首段") >= 0 && l.out.indexOf("X-内部中段") >= 0
      && l.out.indexOf("Y-尾段") >= 0, JSON.stringify(l.r.hits) + " " + l.out);
}
// ---------- 9) 清除后自检：外部保密检查软件的口径（全文 + 全部部件） ----------
//   目的：把「按词库范围清理完」与「换个检索口径是否还能查出」拆开验证。
//   扫描 / 清理都遵循部件策略与范围，而外部检查工具是解包后全文检索，
//   因此这里专门验证 verifyOffice 能报出这些「换个口径就现形」的残留。
{
  const fl = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  });
  const all = engine;

  const cleanDoc = '<w:document><w:body><w:p><w:r><w:t>公开标题</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>普通正文</w:t></w:r></w:p></w:body></w:document>';
  const docx = (docData, extra) => D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: docData },
  ].concat(extra || []));
  const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const verify = (bytes) => D.DWRDoc.verifyOffice(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), all);

  // (1) 全文范围清理干净后：自检应为 0 命中
  const cleanParts = {
    name: 'word/document.xml',
    data: '<w:document><w:body><w:p><w:r><w:t>内部资料</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>机密正文</w:t></w:r></w:p></w:body></w:document>',
  };
  const cleanRes = await D.DWRDoc.processOffice(await (await docx(cleanParts.data)).arrayBuffer(), all);
  const cleanV = await verify(await u8(cleanRes.blob));
  check('自检-全文清理后 0 残留', cleanV.hits === 0 && cleanV.parts.length === 0,
    JSON.stringify(cleanV));

  // (2) 首行+尾行范围：中段跨 run 的敏感词清不到，自检必须报出来
  const midParts = {
    name: 'word/document.xml',
    data: '<w:document><w:body><w:p><w:r><w:t>内部资料</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>公</w:t><w:r><w:t>机密</w:t><w:r><w:t>正文</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>普通结尾</w:t></w:r></w:p></w:body></w:document>',
  };
  const midRes = await D.DWRDoc.processOffice(await (await docx(midParts.data)).arrayBuffer(), fl);
  const midV = await verify(await u8(midRes.blob));
  check('自检-首尾范围下中段残留被报出',
    midV.hits === 1 && midV.parts.length === 1 && midV.parts[0].name === 'word/document.xml',
    JSON.stringify(midV));
  check('自检-残留带上命中词', midV.matched.indexOf('机密') >= 0, JSON.stringify(midV.matched));

  // (3) .rels 的 Target 属性：引擎按设计不动，自检必须能看见（外部工具读得到）
  const relsParts = await docx(cleanParts.data, [
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Target="内部资料.docx"/></Relationships>' },
  ]);
  const relsV = await verify(await u8(relsParts));

  check('自检-rels 属性残留被报出',
    relsV.hits >= 1 && relsV.parts.some((p) => /rels·属性$/.test(p.name)), JSON.stringify(relsV));

  // (4) 内嵌 Office 文档：外层干净、内嵌有残留时要能定位到内层部件
  const inner = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>机密内嵌</w:t></w:r></w:p></w:body></w:document>' },
  ]);
  const embedV = await verify(await u8(await docx(cleanDoc, [
    { name: 'word/embeddings/inner.docx', data: await u8(inner) },
  ])));
  check('自检-内嵌文档残留被报出',
    embedV.hits === 1 && embedV.parts.some((p) => p.name.indexOf('word/embeddings/inner.docx!') === 0),
    JSON.stringify(embedV));

  // (5) 旧版 OLE 容器里的 UTF-16 文本
  const oleText = '机密附件说明';
  const ole = new Uint8Array(oleText.length * 2 + 16);
  ole[0] = 0xd0; ole[1] = 0xcf; ole[2] = 0x11; ole[3] = 0xe0;
  for (let i = 0; i < oleText.length; i++) {
    ole[16 + i * 2] = oleText.charCodeAt(i) & 0xff;
    ole[17 + i * 2] = (oleText.charCodeAt(i) >> 8) & 0xff;
  }
  const oleV = await verify(await u8(await docx(cleanDoc, [
    { name: 'word/embeddings/legacy.doc', data: ole },
  ])));
  check('自检-OLE 容器内文本被报出',
    oleV.hits === 1 && oleV.parts.some((p) => /·OLE$/.test(p.name)), JSON.stringify(oleV));

  // (6) XML 注释 / CDATA：普通文本节点检索会漏掉，自检要覆盖
  const hideV = await verify(await u8(await docx(cleanDoc, [
    { name: 'docProps/core.xml', data: '<props><!-- 内部说明 --><x><![CDATA[机密草稿]]></x></props>' },
  ])));
  check('自检-注释与 CDATA 内容被报出', hideV.hits >= 2, JSON.stringify(hideV));

  // (7) 纯文本文件走 verifyBytes：命中即残留
  const txtV = await D.DWRDoc.verifyBytes(new TextEncoder().encode('标题\n正文里的机密内容\n'), all);
  check('自检-纯文本残留被报出', txtV.hits === 1 && txtV.matched.indexOf('机密') >= 0, JSON.stringify(txtV));
  const txtClean = await D.DWRDoc.verifyBytes(new TextEncoder().encode('干净的正文\n'), all);
  check('自检-纯文本干净为 0', txtClean.hits === 0, JSON.stringify(txtClean));

  // (8) 条目名残留：ZIP 本地文件头 / 中央目录里明文存放，保密检查软件解包前就能检索到
  const innerParts = [
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>绝密内部数据</t></si></sst>' },
  ];
  const nameZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/word/document.xml" ContentType="c"/>'
      + '<Override PartName="/word/embeddings/绝密资料.xlsx" ContentType="d"/></Types>' },
    { name: 'word/document.xml', data: cleanDoc },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Id="rId9" Type="ole" Target="embeddings/绝密资料.xlsx"/></Relationships>' },
    { name: 'word/embeddings/绝密资料.xlsx', data: await u8(await D.DWRZip.pack(innerParts)) },
  ]);
  const nameV = await verify(await u8(nameZip));
  check('自检-条目名残留被报出',
    nameV.hits >= 1 && nameV.parts.some((p2) => /·条目名$/.test(p2.name)), JSON.stringify(nameV));

  // (9) 清理把条目名一起改掉：重命名 + Content_Types + rels 引用同步，复检 0 残留
  const nameRes = await D.DWRDoc.processOffice(await (await nameZip).arrayBuffer(), all);
  const outZip = await D.DWRZip.load(await nameRes.blob.arrayBuffer());
  const outNames = outZip.names();
  check('结构-条目名已重命名',
    outNames.indexOf('word/embeddings/绝密资料.xlsx') < 0 && outNames.indexOf('word/embeddings/资料.xlsx') >= 0,
    JSON.stringify(outNames));
  const ctOut = await outZip.getText('[Content_Types].xml');
  check('结构-Content_Types 引用同步',
    ctOut.indexOf('绝密') < 0 && ctOut.indexOf('资料.xlsx') >= 0, ctOut);
  const relsOut = await outZip.getText('word/_rels/document.xml.rels');
  check('结构-rels 引用同步',
    relsOut.indexOf('绝密') < 0 && relsOut.indexOf('embeddings/资料.xlsx') >= 0, relsOut);
  const nameAfter = await verify(await u8(nameRes.blob));
  check('结构-改名后自检 0 残留', nameAfter.hits === 0, JSON.stringify(nameAfter));
  const innerOut = await outZip.getBytes('word/embeddings/资料.xlsx');
  const innerZip = await D.DWRZip.load(innerOut.buffer.slice(innerOut.byteOffset, innerOut.byteOffset + innerOut.byteLength));
  check('结构-改名后内嵌内容仍可读且已清',
    !/绝密|内部/.test(await innerZip.getText('xl/sharedStrings.xml')), 'inner unreadable');

  // (10) 缩略图（首页渲染图）整部件移除，声明与关系一并清理
  const thumbZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types><Default Extension="jpeg" ContentType="image/jpeg"/>'
      + '<Override PartName="/word/document.xml" ContentType="c"/>'
      + '<Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships><Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>' },
    { name: 'word/document.xml', data: cleanDoc },
    { name: 'docProps/thumbnail.jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]) },
  ]);
  const thumbRes = await D.DWRDoc.processOffice(await (await thumbZip).arrayBuffer(), all);
  const thumbZip2 = await D.DWRZip.load(await thumbRes.blob.arrayBuffer());
  const thumbNames = thumbZip2.names();
  check('结构-缩略图已移除',
    thumbNames.indexOf('docProps/thumbnail.jpeg') < 0 && thumbNames.indexOf('word/document.xml') >= 0,
    JSON.stringify(thumbNames));
  const ct3 = await thumbZip2.getText('[Content_Types].xml');
  const rels3 = await thumbZip2.getText('_rels/.rels');
  check('结构-缩略图声明与关系已清',
    ct3.indexOf('thumbnail') < 0 && rels3.indexOf('thumbnail') < 0 && rels3.indexOf('word/document.xml') >= 0,
    ct3 + ' | ' + rels3);
  check('结构-移除缩略图后自检 0 残留', (await verify(await u8(thumbRes.blob))).hits === 0);

  // (11) 扩展名必须保留（删除动作可能把 “xlsx” 一起吃掉）
  const extZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/embeddings/绝密.xlsx', data: await u8(await D.DWRZip.pack([{ name: 'xl/sharedStrings.xml', data: '<sst/>' }])) },
  ]);
  const extRes = await D.DWRDoc.processOffice(await (await extZip).arrayBuffer(), all);
  const extZip2 = await D.DWRZip.load(await extRes.blob.arrayBuffer());
  check('结构-改名保留扩展名',
    extZip2.names().indexOf('word/embeddings/part.xlsx') >= 0, JSON.stringify(extZip2.names()));

  // (12) 改名撞名自动加序号：两个不同条目清理后落到同一个名字
  const colZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/media/机密1.png', data: new Uint8Array([1, 2, 3]) },
    { name: 'word/media/绝密1.png', data: new Uint8Array([4, 5, 6]) },
  ]);
  const colRes = await D.DWRDoc.processOffice(await (await colZip).arrayBuffer(), all);
  const colZip2 = await D.DWRZip.load(await colRes.blob.arrayBuffer());
  const colNames = colZip2.names();
  check('结构-撞名自动加序号',
    colNames.indexOf('word/media/1.png') >= 0 && colNames.indexOf('word/media/1_1.png') >= 0,
    JSON.stringify(colNames));
  check('结构-撞名后内容依然对',
    (await colZip2.getBytes('word/media/1.png'))[2] === 3 && (await colZip2.getBytes('word/media/1_1.png'))[2] === 6,
    JSON.stringify(colNames));

  // (13) rels 的相对 Target（../media/）同样要同步改写
  const relZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld/>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="image" Target="../media/机密图.png"/></Relationships>' },
    { name: 'ppt/media/机密图.png', data: new Uint8Array([7, 8, 9]) },
  ]);
  const relRes = await D.DWRDoc.processOffice(await (await relZip).arrayBuffer(), all);
  const relZip2 = await D.DWRZip.load(await relRes.blob.arrayBuffer());
  const slideRels = await relZip2.getText('ppt/slides/_rels/slide1.xml.rels');
  check('结构-相对 Target 同步改写',
    slideRels.indexOf('机密') < 0 && slideRels.indexOf('../media/图.png') >= 0, slideRels);
  check('结构-相对路径条目已改名',
    relZip2.names().indexOf('ppt/media/图.png') >= 0, JSON.stringify(relZip2.names()));

  // (14) 扫描口径同步：仅条目名含敏感词的文件也要被报出（否则没人去清它）
  const nameScan = await D.DWRDoc.scanOffice(await (await nameZip).arrayBuffer(), all);
  check('结构-扫描能报出条目名残留',
    nameScan.hits >= 1 && nameScan.matched.indexOf('绝密') >= 0, JSON.stringify(nameScan));
}
console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
