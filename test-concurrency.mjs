#!/usr/bin/env node
/**
 * test-concurrency.mjs —— 并发调度与引擎并发安全回归测试
 *
 * 覆盖：
 *  - mapPool：全部完成、顺序保持、并发上限、单任务失败隔离
 *  - 引擎并发安全：同一文档并发 scan / process 与串行结果一致，且输出均可重新解析
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console,
    setTimeout, clearTimeout,
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

const D = await loadEngine();
const mapPool = D.DWRUtil.mapPool;

// ---------- 1) mapPool：全部完成 + 顺序保持 ----------
{
  const items = Array.from({ length: 20 }, (_, i) => i);
  const res = await mapPool(items, 4, function (x) {
    return Promise.resolve(x * 2);
  });
  check('mapPool-全部完成', res.length === 20);
  check('mapPool-顺序保持', res.every(function (v, i) { return v === i * 2; }));
}

// ---------- 2) mapPool：并发上限不被突破 ----------
{
  const items = Array.from({ length: 30 }, (_, i) => i);
  let maxActive = 0, active = 0;
  await mapPool(items, 5, function () {
    active++; if (active > maxActive) maxActive = active;
    return new Promise(function (r) { setTimeout(function () { active--; r(0); }, 5); });
  });
  check('mapPool-并发上限', maxActive <= 5, 'maxActive=' + maxActive);
}

// ---------- 3) mapPool：单任务失败隔离 ----------
{
  const res = await mapPool([1, 2, 3], 2, function (x) {
    return x === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(x);
  });
  check('mapPool-错误隔离',
    res[0] === 1 && res[2] === 3 && res[1] && res[1].__error,
    JSON.stringify(res));
}

// ---------- 4) 引擎：并发扫描与串行命中一致 ----------
{
  const engine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'all', action: 'delete', custom: '',
  });
  const blob = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:p><w:t>这是内部资料正文</w:t></w:p>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>机密字符串</t></si></sst>' },
  ]);
  const buf = await blob.arrayBuffer();

  let seqHits = 0;
  for (let i = 0; i < 40; i++) { const r = await D.DWRDoc.scanOffice(buf, engine); seqHits += r.hits; }

  const par = await mapPool(Array.from({ length: 40 }), 8, function () {
    return D.DWRDoc.scanOffice(buf, engine);
  });
  const parHits = par.reduce(function (a, r) { return a + (r.hits || 0); }, 0);
  check('engine-并发与串行命中一致', seqHits === parHits, 'seq=' + seqHits + ' par=' + parHits);
}

// ---------- 5) 引擎：并发 processOffice 输出均可重新解析 ----------
{
  const engine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'all', action: 'delete', custom: '',
  });
  const blob = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:p><w:t>这是内部资料正文</w:t></w:p>' },
    { name: 'ppt/slides/slide1.xml', data: '<a:p><a:t>绝密幻灯片</a:t></a:p>' },
  ]);
  const buf = await blob.arrayBuffer();

  const results = await mapPool(Array.from({ length: 20 }), 6, function () {
    return D.DWRDoc.processOffice(buf, engine);
  });
  let ok = true, totalHits = 0;
  for (const r of results) {
    if (!r.touched) continue;
    totalHits += r.hits;
    const z = await D.DWRZip.load(await r.blob.arrayBuffer());
    if (!z) ok = false;
  }
  check('engine-并发处理输出可重新解析', ok, 'totalHits=' + totalHits);
  check('engine-并发处理命中非空', totalHits > 0, 'totalHits=' + totalHits);
}

console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
