#!/usr/bin/env node
/**
 * test-docx.mjs —— Word 报告导出（js/reportdocx.js）回归测试
 *
 * 外部保密检查系统的报告能导出 Word，我们 v4.91 起也补上。
 * 这里不只验「函数存在」，而是真打一个 .docx 出来，再自己解包读回：
 *   1. 包里必须有 OOXML 必需的那几个部件；
 *   2. 正文里要有标题、概要、每一条明细，命中词按数组拼成顿号分隔；
 *   3. 尖括号 / & / 引号要转义，否则 Word 打开就报「文件已损坏」；
 *   4. XML 必须是良构的（借 Python 的 ElementTree 独立解析，Python 不在就跳过这条）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('PASS [' + name + ']');
  } else {
    failed++;
    console.log('FAIL [' + name + '] ' + String(detail || ''));
  }
}

function loadEngine() {
  const files = ['js/zip.js', 'js/reportdocx.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console
  };
  ctx.window = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

const MODEL = {
  title: '文档敏感词扫描报告',
  generatedAt: '2026-11-12 10:00:00',
  conclusion: '共扫描 10 个文件，命中 "内部" & 机密 共 3 处。',
  summary: [
    ['扫描文件数', 10, 'obs', '本次遍历的文件数'],
    ['命中文件数', 2, 'obs', '命中任一敏感词的文件数']
  ],
  steps: ['按当前词库做归一化匹配。', '逐文件统计命中处数。'],
  limits: ['旧版二进制格式只做只读检测。'],
  cols: [
    { k: 'file', label: '文件路径' },
    { k: 'hits', label: '命中处数' },
    { k: 'matched', label: '命中词' },
    { k: 'status', label: '状态' }
  ],
  rows: [
    { file: 'C:\\资料&说明\\内部文件.docx', hits: 3, matched: ['内部', '机密'], status: 'hit' },
    { file: 'D:\\<公开>\\普通.txt', hits: 0, matched: [], status: 'clean' }
  ],
  note: '本报告由本地工具生成，数据未离开本机。'
};

const W = loadEngine();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-docx-'));

try {
  check('docx 模块在场', !!W.DWRReportDocx && typeof W.DWRReportDocx.build === 'function');

  const blob = await W.DWRReportDocx.build(MODEL);
  check('build 返回 Blob', !!blob && typeof blob.arrayBuffer === 'function');

  const buf = Buffer.from(await blob.arrayBuffer());
  const docxPath = path.join(base, 'report.docx');
  fs.writeFileSync(docxPath, buf);
  check('docx 体积大于 1KB（不是空壳）', buf.length > 1024, 'size=' + buf.length);

  // 用自带的解包器读回，验证包结构与正文内容
  const zip = await W.DWRZip.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const names = zip.names();
  const want = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml',
    'word/_rels/document.xml.rels'];
  const missing = want.filter((n) => names.indexOf(n) < 0);
  check('docx 包含 OOXML 必需部件', missing.length === 0, '缺: ' + missing.join(', '));

  const doc = await zip.getText('word/document.xml');
  check('正文含报告标题', doc.indexOf('文档敏感词扫描报告') >= 0);
  check('正文含结论段', doc.indexOf('命中') >= 0 && doc.indexOf('结论') >= 0);
  check('正文含概要两条', doc.indexOf('扫描文件数') >= 0 && doc.indexOf('命中文件数') >= 0);
  check('正文含两条明细路径', doc.indexOf('内部文件.docx') >= 0 && doc.indexOf('普通.txt') >= 0);
  check('命中词按顿号拼接', doc.indexOf('内部、机密') >= 0);
  check('命中词为空时占位为破折号', doc.indexOf('—') >= 0);
  check('处理范围与局限段落在场', doc.indexOf('处理范围与局限') >= 0);
  check('本次做法段落在场', doc.indexOf('本次做法') >= 0);

  // 特殊字符必须转义，否则 Word 报文件损坏
  check('& 已转义', doc.indexOf('&amp;') >= 0 && doc.indexOf('资料&说明') < 0);
  check('< > 已转义', doc.indexOf('&lt;公开&gt;') >= 0 && doc.indexOf('<公开>') < 0);
  check('引号已转义', doc.indexOf('&quot;内部&quot;') >= 0);

  // 表格数量：概要表 + 明细表；每张表至少表头 + 行
  const tblCount = (doc.match(/<w:tbl>/g) || []).length;
  check('生成两张表（概要 + 明细）', tblCount === 2, 'tbl=' + tblCount);
  const trCount = (doc.match(/<w:tr>/g) || []).length;
  check('表格行数正确（概要 1+2，明细 1+2）', trCount === 6, 'tr=' + trCount);
  check('页面为 A4 横向', doc.indexOf('w:orient="landscape"') >= 0);

  // XML 良构性：借 Python 独立解析（没有 Python 就跳过，不算失败）
  const py = spawnSync('python', ['-c', [
    'import sys,zipfile,xml.etree.ElementTree as ET',
    'z=zipfile.ZipFile(sys.argv[1])',
    'names=z.namelist()',
    'assert "[Content_Types].xml" in names, names',
    'for n in names:',
    '    if n.endswith(".xml") or n.endswith(".rels"):',
    '        ET.fromstring(z.read(n))',
    'print("OK")'
  ].join('\n'), docxPath], { encoding: 'utf8' });
  if (py.error || py.status === null) {
    console.log('SKIP [docx-XML 良构（未找到 python，跳过）]');
  } else {
    check('docx 各 XML 部件均可被独立解析（良构）', py.status === 0,
      'stderr=' + String(py.stderr || '').slice(0, 300));
  }

  // 列宽不能超出版心，否则 Word 里表格会跑出页面（逐张表算，不看全篇合计）
  const tables = doc.split('<w:tbl>').slice(1);
  const sums = tables.map((t) => (t.match(/<w:gridCol w:w="(\d+)"\/>/g) || [])
    .map((s) => parseInt(s.replace(/\D/g, ''), 10))
    .reduce((a, b) => a + b, 0));
  check('每张表的总宽都不超版心',
    sums.length === 2 && sums.every((s) => s > 0 && s <= 15400), 'sums=' + sums.join('/'));

  // 缺 zip 打包器时要明确报错，不能静默产出一份坏文件
  const bare = { window: {} };
  vm.createContext(bare);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'reportdocx.js'), 'utf8'), bare);
  let rejected = false;
  try {
    await bare.window.DWRReportDocx.build(MODEL);
  } catch (e) {
    rejected = true;
  }
  check('缺打包器时明确报错', rejected);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* test cleanup */ }
}

console.log('\n==== docx summary ====');
console.log('PASS: ' + passed + '  FAIL: ' + failed);
if (failed) process.exit(1);
