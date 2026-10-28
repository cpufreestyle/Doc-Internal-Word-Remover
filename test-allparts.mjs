#!/usr/bin/env node
/**
 * test-allparts.mjs —— 全部件脱敏回归自测
 * 构造 docx/xlsx/pptx，把敏感词分散在正文/页眉/页脚/文本框/绘图/批注等部件，
 * 经 processOffice 处理后，断言每个部件内都不再残留敏感词。
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
const NOT_TOUCHED = ['保密', '受控', '商密', '严禁外传']; // 词库外词汇：不应被默认处理

function partsFor(fmt) {
  if (fmt === 'docx') return [
    { name: 'word/document.xml', data: '<w:p><w:t>这是内部资料正文，保密、受控、商密、严禁外传等词保持原样</w:t></w:p>' },
    { name: 'word/header1.xml',  data: '<w:p><w:t>内部资料页眉</w:t></w:p>' },
    { name: 'word/footer1.xml',  data: '<w:p><w:t>机密页脚</w:t></w:p>' },
    { name: 'word/comments.xml',  data: '<w:comments><w:comment w:id="1"><w:p><w:t>秘密批注</w:t></w:p></w:comment></w:comments>' },
    { name: 'word/drawing1.xml',  data: '<a:p><a:t>绝密文本框</a:t></a:p>' },
  ];
  if (fmt === 'xlsx') return [
    { name: 'xl/sharedStrings.xml',       data: '<sst><si><t>内部资料字符串</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml',   data: '<worksheet><sheetData><row><c><is><t>机密单元格</t></is></c></row></sheetData></worksheet>' },
    { name: 'xl/comments1.xml',           data: '<comments><commentList><comment ref="A1"><text><t>绝密批注</t></text></comment></commentList></comments>' },
    { name: 'xl/drawings/drawing1.xml',   data: '<a:p><a:t>秘密绘图</a:t></a:p>' },
  ];
  if (fmt === 'pptx') return [
    { name: 'ppt/slides/slide1.xml',          data: '<p:sp><p:txBody><a:p><a:t>内部资料幻灯片</a:t></a:p></p:txBody></p:sp>' },
    { name: 'ppt/notesSlides/notesSlide1.xml',data: '<p:notes><p:txBody><a:p><a:t>绝密备注</a:t></a:p></p:txBody></p:notes>' },
    { name: 'ppt/comments/modernComment1.xml',data: '<p:cmLst><p:cm><p:txtSp><p:spPr/><p:txBody><a:p><a:t>秘密评论</a:t></a:p></p:txBody></p:cm></p:cmLst>' },
  ];
  return [];
}

const D = await loadEngine();
const engine = D.DWRRules.createEngine({
  rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
  scope: 'all', action: 'delete', custom: '',
});

let allPass = true;
for (const fmt of ['docx', 'xlsx', 'pptx']) {
  const blob = await D.DWRZip.pack(partsFor(fmt));
  const ab = await blob.arrayBuffer();
  const res = await D.DWRDoc.processOffice(ab, engine);
  if (!res.touched) { console.log('FAIL [' + fmt + '] 未触发任何命中'); allPass = false; continue; }
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer());
  const bad = [];
  for (const e of zip2.entries) {
    const xml = await zip2.getText(e.name);
    for (const w of SENSITIVE) {
      if (xml && xml.includes(w)) bad.push(e.name + ' 仍含「' + w + '」');
    }
  }
  if (bad.length) { console.log('FAIL [' + fmt + ']\n  ' + bad.join('\n  ')); allPass = false; }
  else console.log('PASS [' + fmt + '] 所有部件敏感词已清除 (hits=' + res.hits + ')');
  if (fmt === 'docx') {
    const doc = await zip2.getText('word/document.xml');
    const missing = NOT_TOUCHED.filter((w) => !doc || doc.indexOf(w) === -1);
    if (missing.length) { console.log('FAIL [' + fmt + '] 词库外词汇被误处理，缺失: ' + missing.join('、')); allPass = false; }
    else console.log('PASS [' + fmt + '] 词库外词汇保留校验 (' + NOT_TOUCHED.join('、') + ')');
  }
}
console.log(allPass ? '\n==== 全部通过 ====' : '\n==== 存在失败 ====');
process.exit(allPass ? 0 : 1);
