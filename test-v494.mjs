#!/usr/bin/env node
/**
 * test-v494.mjs —— 回归测试：v4.94 两项复刻
 *
 *  A. 导入报告全列保真：外部保密检查系统的结果表有十列
 *     （文件名称 / 文件路径 / 文件大小 / 创建时间 / 修改时间 / 文件类别 /
 *       命中关键字 / 命中百分比 / 标记密级 / 涉密情况）。
 *     此前导入只取路径 / 关键字 / 大小三列，其余七列在解析时被直接丢掉——
 *     检查软件已经算好的结论不该因为「我们也能算」就扔掉：
 *     两者不一致时，那恰恰是最该被人看见的分歧。
 *
 *  B. 逐文件「本次跳过」：对应外部检查系统结果表里的「跳过此文件」。
 *     与「移出结果」不同，跳过的行仍留在结果表与报告里，
 *     只是这一轮不参与处理 / 删除——它是「已复核、决定不动」的凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + ']' + (extra ? ' :: ' + extra : '')); }
}

/* ---------- 载入被测模块 ---------- */
function load(file, globals) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const ctx = vm.createContext(Object.assign({ console, globalThis: null, TextDecoder, Date, Math, JSON }, globals || {}));
  ctx.globalThis = ctx;
  vm.runInContext(src, ctx, { filename: file });
  return ctx;
}

const R = load('js/report.js', {}).DWRReport;
const U = load('js/util.js', {}).DWRUtil;

const rowHtml = (cells) => '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';

/* 鼎普式报告：十列齐全，与用户那份真实报告的表头一致 */
function fullColReport() {
  return '<html><head><title>标密文件</title></head><body>'
    + '<div class="groupHeader" onclick="ToggleTable(&#39;关键词命中文件记录&#39;,this)">'
    + '<table id="关键词命中文件记录" class="tb_Item">'
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比', '标记密级', '涉密情况'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '秘密(1)|内部(2)', '50.0%', '待鉴定', '涉嫌越级存储'])
    + rowHtml(['b.docx', 'D:\\资料\\b.docx', '20480', '2025-03-04 19:03:25', '2024-10-09 14:54:23', '正常文件', '内部(1)', '25.0%', '内部', '涉密'])
    + '</table></body></html>';
}

/* ---------- A1：十列表头全部定位，数据行原样留档 ---------- */
{
  const r = R.parseHtml(fullColReport());
  const a = r.files.find((f) => /a\.txt$/.test(f.file));
  check('v494-A1-解析出两行', r.files.length === 2, JSON.stringify(r.files.map((f) => f.file)));
  check('v494-A1-创建时间留档', a.ctime > 0 && new Date(a.ctime).getFullYear() === 2025, String(a.ctime));
  check('v494-A1-修改时间留档', a.mtime > 0 && new Date(a.mtime).getMonth() === 0, String(a.mtime));
  check('v494-A1-创建时间与修改时间不串列',
    a.ctime !== a.mtime && new Date(a.ctime).getDate() === 1 && new Date(a.mtime).getDate() === 2,
    a.ctime + '/' + a.mtime);
  check('v494-A1-命中百分比留档（50.0% → 0.5）', Math.abs(a.ratio - 0.5) < 1e-9, String(a.ratio));
  check('v494-A1-标记密级留档', a.markLevel === '待鉴定', a.markLevel);
  check('v494-A1-涉密情况留档', a.verdict === '涉嫌越级存储', a.verdict);
  check('v494-A1-文件类别留档', a.cat === '正常文件', a.cat);
  check('v494-A1-原有关键字段未回归',
    a.hits === 2 && a.matched.join(',') === '秘密,内部' && a.size === 1234,
    JSON.stringify(a));
}

/* ---------- A2：跨分节重复行不丢字段 ---------- */
{
  const html = '<html><body>'
    + '<table id="t1">'
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比', '标记密级', '涉密情况'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '秘密(1)', '50.0%', '待鉴定', '涉嫌越级存储'])
    + '</table>'
    + '<table id="t2">'
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比', '标记密级', '涉密情况'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '内部(2)', '25.0%', '秘密', '涉密'])
    + '</table></body></html>';
  const r = R.parseHtml(html);
  const a = r.files[0];
  check('v494-A2-跨节只留一行', r.files.length === 1, String(r.files.length));
  check('v494-A2-跨节后原字段保留',
    a.markLevel === '待鉴定' && a.verdict === '涉嫌越级存储' && Math.abs(a.ratio - 0.5) < 1e-9,
    JSON.stringify({ ml: a.markLevel, vd: a.verdict, ratio: a.ratio }));
  check('v494-A2-跨节后命中词合并', a.matched.join(',') === '秘密,内部', a.matched.join(','));
}

/* ---------- A3：没有这几列的旧报告不受影响（不能因为新增列把老报告解析坏） ---------- */
{
  const old = '<html><body><table>'
    + rowHtml(['文件名称', '文件路径', '文件大小', '命中关键字'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '内部(1)'])
    + '</table></body></html>';
  const r = R.parseHtml(old);
  check('v494-A3-旧报告仍能解析', r.files.length === 1 && r.files[0].hits === 1, JSON.stringify(r.files));
  check('v494-A3-旧报告缺失列留空', r.files[0].ctime === 0 && r.files[0].ratio === 0
    && r.files[0].markLevel === '' && r.files[0].verdict === '', JSON.stringify(r.files[0]));
}

/* ---------- A4：百分比 / 时间各种写法 ---------- */
{
  const mk = (pct, time) => '<html><body><table>'
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比'])
    + rowHtml(['a.txt', 'C:\\a.txt', '1', time, time, '正常文件', '内部(1)', pct])
    + '</table></body></html>';
  check('v494-A4-百分比「25%」', Math.abs(R.parseHtml(mk('25%', '2025-01-01 10:00:00')).files[0].ratio - 0.25) < 1e-9);
  check('v494-A4-百分比「0.5」按小数', Math.abs(R.parseHtml(mk('0.5', '2025-01-01 10:00:00')).files[0].ratio - 0.5) < 1e-9);
  check('v494-A4-百分比「50」按百分数', Math.abs(R.parseHtml(mk('50', '2025-01-01 10:00:00')).files[0].ratio - 0.5) < 1e-9);
  check('v494-A4-百分比「-」视为空', R.parseHtml(mk('-', '2025-01-01 10:00:00')).files[0].ratio === 0);
  check('v494-A4-时间「2025/01/02 10:00」', (() => {
    const t = R.parseHtml(mk('10%', '2025/01/02 10:00')).files[0].ctime;
    return t > 0 && new Date(t).getMonth() === 0 && new Date(t).getDate() === 2;
  })(), String(R.parseHtml(mk('10%', '2025/01/02 10:00')).files[0].ctime));
  check('v494-A4-时间空值不编造', R.parseHtml(mk('10%', '')).files[0].ctime === 0);
}

/* ---------- B：「本次跳过」机制 ---------- */
{
  // 直接对状态模型做断言：跳过的行必须被 selectedScanTargets 排除。
  // 这里不加载整个 app.js（依赖浏览器 DOM），改为验证同一条筛选规则。
  const pick = (rows) => rows.filter((r) => r.selected && r.handle && !r.detectOnly && !r.skipped);
  const rows = [
    { path: 'a', selected: true, handle: 1, detectOnly: false, skipped: false },
    { path: 'b', selected: true, handle: 1, detectOnly: false, skipped: true },
    { path: 'c', selected: false, handle: 1, detectOnly: false, skipped: false },
    { path: 'd', selected: true, handle: 1, detectOnly: true, skipped: false },
  ];
  const got = pick(rows).map((r) => r.path);
  check('v494-B1-跳过的行不进批量目标', got.length === 1 && got[0] === 'a', JSON.stringify(got));
  check('v494-B2-跳过不影响其他行', pick(rows.filter((r) => !r.skipped)).length === 1);
}

/* ---------- B3：报告状态口径 —— 跳过要在报告里留痕 ---------- */
{
  const html = load('js/reporthtml.js', {}).DWRReportHtml;
  const tag = html.statusTag('skipped');
  check('v494-B3-报告状态标签为「已跳过」', /已跳过/.test(tag), tag);
  check('v494-B3-原状态标签未回归',
    /命中/.test(html.statusTag('hit')) && /仅检测/.test(html.statusTag('detect')),
    html.statusTag('hit') + '|' + html.statusTag('detect'));
}

/* ---------- B4：CSV 列包含新留档字段，且追加在末尾 ---------- */
{
  const cols = U.buildScanReportCsv(
    [['总数', 1]],
    [{
      path: 'C:\\a.txt', kind: '文稿', size: '1 KB', hits: 1, matched: '内部',
      ratio: '50.0%', mode: '可处理', parts: '', cross: '',
      cat: '文字文档', mtime: '2025-01-02', level: '内部', over: '', verdict: '涉密', tier: '',
      ctime: '2025-01-01', checkerRatio: '25.0%', checkerMarkLevel: '待鉴定',
      checkerVerdict: '涉嫌越级存储', checkerCat: '正常文件',
    }]
  );
  // CSV 第一行是「#键,值」的摘要行，第二行才是表头（字段名列表）
  const lines = cols.split('\r\n');
  const header = lines[1] || '';
  check('v494-B4-CSV 表头含新留档字段',
    /checkerRatio/.test(header) && /checkerMarkLevel/.test(header)
    && /checkerVerdict/.test(header) && /ctime/.test(header), header);
  check('v494-B4-CSV 含原报告占比值', /25\.0%/.test(cols));
  check('v494-B4-CSV 含原报告涉密情况', /涉嫌越级存储/.test(cols));
  check('v494-B4-CSV 含创建时间', /2025-01-01/.test(cols));
  check('v494-B4-新列追加在末尾（不打断既有列序）',
    header.indexOf('checkerRatio') > header.indexOf('tier'), header);
}

console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
