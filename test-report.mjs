#!/usr/bin/env node
/**
 * test-report.mjs —— 回归测试：保密检查报告解析（js/report.js）
 *
 * 覆盖：
 *  - decodeBytes：UTF-16LE/BE、UTF-8 BOM、无 BOM UTF-16 启发式
 *  - parseHtml：通用检查报告（配置行 + 表头行 + 数据行）、跨分节去重与关键字合并、
 *    文件名含「路径」二字不误判为表头、HTML 实体解码、命中关键字拆分、文件大小解析
 *  - parsePathList / parseJsonList / parseAny：三种清单入口与分发
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadReport() {
  const ctx = { TextDecoder, TextEncoder, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/report.js'), 'utf8'), ctx);
  return ctx.window;
}

const D = loadReport();
const R = D.DWRReport;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + ']' + (extra ? '  ' + extra : '')); }
}

/* ---------- 1) decodeBytes：报告编码探测 ---------- */
{
  const u16le = Buffer.from('中文路径', 'utf16le');
  check('decodeBytes-UTF-16LE 带 BOM', R.decodeBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), u16le])) === '中文路径');
  check('decodeBytes-UTF-16LE 无 BOM（隔位零启发式，报告含大量 ASCII 标签/路径）',
    R.decodeBytes(Buffer.from('D:\\工作\\a.txt', 'utf16le')) === 'D:\\工作\\a.txt');
  const u16be = Buffer.from('中文路径', 'utf16le');
  const be = Buffer.alloc(u16be.length);
  for (let i = 0; i < u16be.length; i += 2) { be[i] = u16be[i + 1]; be[i + 1] = u16be[i]; }
  check('decodeBytes-UTF-16BE 带 BOM', R.decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])) === '中文路径');
  check('decodeBytes-UTF-8 带 BOM', R.decodeBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文路径', 'utf8')])) === '中文路径');
  check('decodeBytes-UTF-8 无 BOM', R.decodeBytes(Buffer.from('<html>中文</html>', 'utf8')) === '<html>中文</html>');
  check('decodeBytes-空输入', R.decodeBytes(Buffer.alloc(0)) === '');
  check('decodeBytes-Uint8Array 输入（浏览器侧 ArrayBuffer 场景）', R.decodeBytes(new Uint8Array(Buffer.from('abc', 'utf8'))) === 'abc');
}

/* ---------- 2) parseHtml：通用检查报告 ---------- */
const rowHtml = (cells) => '<tr>' + cells.map((c) => '<td><p align="center"><font size="3">' + c + '</font></p></td>').join('') + '</tr>';
function dingpuReport() {
  return '<html><head><title>示例检查报告</title></head><body>'
    + '<div class="groupHeader" onclick="ToggleTable(&#39;关键词命中文件记录&#39;,this)">'
    + '<table id="关键词命中文件记录" class="tb_Item">'
    + rowHtml(['查询方式', '配置参数'])
    + rowHtml(['文件名称', '绝密,机密,秘密,内部'])
    + rowHtml(['检查范围', 'C:,D:,E:'])
    + rowHtml(['结果总数', '591'])
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比', '标记密级', '涉密情况'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '秘密(1)|内部(2)', '50.0%', '待鉴定', '涉嫌越级存储'])
    + rowHtml(['b.docx', 'D:\\资料\\b.docx', '20480', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '内部(1)', '25.0%', '待鉴定', '涉嫌越级存储'])
    + '</table>'
    + '<div class="groupHeader" onclick="ToggleTable(&#39;标密文件记录&#39;,this)">'
    + '<table id="标密文件记录" class="tb_Item">'
    + rowHtml(['文件名称', '文件路径', '文件大小', '创建时间', '修改时间', '文件类别', '命中关键字', '命中百分比', '标记密级', '涉密情况'])
    + rowHtml(['a.txt', 'C:\\工作\\a.txt', '1234', '2025-01-01 10:00:00', '2025-01-02 10:00:00', '正常文件', '机密(3)', '50.0%', '秘密', '涉密'])
    + '</table></body></html>';
}
{
  const r = R.parseHtml(dingpuReport());
  check('parseHtml-分节识别（ToggleTable 参数）',
    r.sections.join(',') === '关键词命中文件记录,标密文件记录', JSON.stringify(r.sections));
  check('parseHtml-行数与去重（3 数据行，a.txt 跨节重复）', r.files.length === 2, JSON.stringify(r.files));
  check('parseHtml-首行字段（合并后 hits=3）', r.files[0].file === 'C:\\工作\\a.txt' && r.files[0].size === 1234
    && r.files[0].hits === 3 && r.files[0].matched.join(',') === '秘密,内部,机密', JSON.stringify(r.files[0]));
  check('parseHtml-跨节重复合并命中关键字', r.files[0].matched.join(',') === '秘密,内部,机密', JSON.stringify(r.files[0].matched));
  check('parseHtml-第二分节文件正常收录', r.files.length === 2 && /b\.docx$/.test(r.files[1].file));
}

// 配置行 / 表头行都不是数据；文件名含「路径」二字的数据行不能被误判为表头
{
  const html = '<table>'
    + rowHtml(['文件名称', '文件路径', '文件大小', '命中关键字'])
    + rowHtml(['路径说明.txt', 'D:\\文档\\路径说明.txt', '512', '机密(1)'])
    + rowHtml(['远程路径.docx', 'D:\\文档\\远程路径.docx', '900', '内部(1)'])
    + '</table>';
  const r = R.parseHtml(html);
  check('parseHtml-文件名含「路径」不误判表头', r.files.length === 2
    && r.files[0].file === 'D:\\文档\\路径说明.txt'
    && r.files[1].file === 'D:\\文档\\远程路径.docx', JSON.stringify(r.files));
  check('parseHtml-配置行不被当作数据', r.files.every((f) => /\.(txt|docx)$/.test(f.file)));
}

// 无表头时退化为「路径单元格 + 关键字形状」启发式；实体要解码
{
  const html = '<table>'
    + rowHtml(['x&amp;y.txt', 'D:\\x&amp;y.txt', '机密(2)'])
    + rowHtml(['乱码行', '没有路径', '没有命中'])
    + '</table>';
  const r = R.parseHtml(html);
  check('parseHtml-无表头启发式仍解析', r.files.length === 1 && r.files[0].file === 'D:\\x&y.txt', JSON.stringify(r.files));
  check('parseHtml-无表头时关键字兜底识别', r.files[0] && r.files[0].matched.join(',') === '机密', JSON.stringify(r.files[0] || {}));
  check('parseHtml-无关行被忽略', r.files.length === 1);
}

// 路径单元格本身以「路径」结尾时是数据行不是表头（文件落在 …\文件路径 这类目录/文件名下），
// 曾被误判成表头导致该行连同其后数据一起丢失
{
  const html = '<table>'
    + rowHtml(['文件名称', '文件路径', '文件大小', '命中关键字'])
    + rowHtml(['备份路径', 'D:\\备份路径', '512', '机密(1)'])
    + rowHtml(['普通文件', 'D:\\文档\\a.docx', '900', '内部(1)'])
    + '</table>';
  const r = R.parseHtml(html);
  check('parseHtml-路径结尾的数据行不误判表头', r.files.length === 2
    && r.files[0].file === 'D:\\备份路径' && r.files[1].file === 'D:\\文档\\a.docx', JSON.stringify(r.files));
}

// 文件大小：兼容「1,024」「45 B」「12.5 KB」「2MB」等单位写法（旧实现只拼接数字，「12.5 MB」会变成 125）
{
  const sizes = [['1234', 1234], ['1,024', 1024], ['45 B', 45], ['12.5 KB', 12800], ['2MB', 2097152], ['1.5 GB', 1610612736], ['没有大小', 0]];
  const html = '<table>'
    + rowHtml(['文件名称', '文件路径', '文件大小', '命中关键字'])
    + sizes.map(([cell], i) => rowHtml(['f' + i, 'D:\\f' + i + '.txt', cell, '机密(1)'])).join('')
    + '</table>';
  const r = R.parseHtml(html);
  sizes.forEach(([cell, expect], i) => {
    check('parseHtml-大小解析「' + cell + '」→ ' + expect, r.files[i] && r.files[i].size === expect,
      JSON.stringify(r.files[i] || {}));
  });
}

/* ---------- 3) parsePathList ---------- */
{
  const r = R.parsePathList('# 注释\nD:\\a\\b.txt\nC:\\x\\c.docx, C:\\x\\d.docx\n  \n\\\\srv\\share\\e.txt\n');
  check('parsePathList-逐行解析 + 一行多路径', r.files.length === 4, JSON.stringify(r.files));
  check('parsePathList-UNC 路径支持', r.files[3].file === '\\\\srv\\share\\e.txt', JSON.stringify(r.files[3] || {}));
  const r2 = R.parsePathList('D:\\a.txt\nd:\\A.TXT\n');
  check('parsePathList-大小写去重', r2.files.length === 1);
}

/* ---------- 4) parseJsonList ---------- */
{
  const r = R.parseJsonList(JSON.stringify({ meta: {}, files: [{ file: 'D:\\a.txt', hits: 3, matched: ['机密'], size: 10 }, { file: 'D:\\a.txt' }] }));
  check('parseJsonList-对象包装 + 去重', r.files.length === 1 && r.files[0].hits === 3, JSON.stringify(r.files));
  const r2 = R.parseJsonList(JSON.stringify([{ path: 'D:\\b.txt' }, { nope: 1 }]));
  check('parseJsonList-纯数组 + path 字段', r2.files.length === 1 && r2.files[0].file === 'D:\\b.txt', JSON.stringify(r2.files));
  check('parseJsonList-坏 JSON 不炸', R.parseJsonList('{oops').files.length === 0);
}

/* ---------- 5) parseAny 分发 ---------- */
{
  const html = dingpuReport();
  check('parseAny-HTML 扩展名走 parseHtml', R.parseAny('标密文件(2026-09-28).html', html).files.length === 2);
  check('parseAny-无扩展名但内容以 < 开头按 HTML 解析', R.parseAny('report', html).files.length === 2);
  check('parseAny-.txt 走路径清单', R.parseAny('list.txt', 'D:\\a.txt\nD:\\b.txt').files.length === 2);
  check('parseAny-.json 走 JSON 清单', R.parseAny('r.json', JSON.stringify([{ file: 'D:\\a.txt' }])).files.length === 1);
}


/* C13) v4.51 报告解析的单元格工具：isPathLike / parseKeywords / isKeywordCell / toSize。
   这四个函数决定「哪些行算文件、大小列准不准、关键词怎么显示」，
   此前只有 parseHtml 的端到端断言，没有一条直接验它们。
   toSize 尤其重要：注释明说「不能只拼接数字——12.5 MB 会拼成 125」，
   而这个警告本身从没被测试锁过。 */
{
  const RJ = fs.readFileSync(path.join(__dirname, 'js', 'report.js'), 'utf8');
  const grabFn = (sig) => {
    const s = RJ.indexOf(sig);
    if (s < 0) return null;
    let d = 0, e = -1;
    for (let i = RJ.indexOf('{', s); i < RJ.length; i++) {
      if (RJ.charAt(i) === '{') d++;
      else if (RJ.charAt(i) === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return RJ.slice(s, e);
  };
  const fns = ['function isPathLike(s)', 'function normCell(c)',
    'function parseKeywords(cell)', 'function isKeywordCell(c)', 'function toSize(v)'];
  const bodies = fns.map(grabFn);
  check('v451-五个单元格函数都在 report.js 中', bodies.every(Boolean),
    bodies.map((b, i) => (b ? '' : fns[i])).filter(Boolean).join(','));
  const BS = String.fromCharCode(92);
  if (bodies.every(Boolean)) {
    const c = {
      String: String, RegExp: RegExp, parseFloat: parseFloat,
      Math: Math, isFinite: isFinite, console: { log() {}, error() {} },
    };
    vm.createContext(c);
    vm.runInContext(bodies.join(String.fromCharCode(10))
      + '; result = { isPathLike: isPathLike, parseKeywords: parseKeywords,'
      + ' isKeywordCell: isKeywordCell, toSize: toSize };', c);
    const T = c.result;

    /* ---- toSize：单位换算 ---- */
    check('v451-toSize 无单位按字节', T.toSize('1024') === 1024, JSON.stringify(T.toSize('1024')));
    check('v451-toSize 去千分位逗号', T.toSize('1,024') === 1024, JSON.stringify(T.toSize('1,024')));
    check('v451-toSize 小数 KB 不拼数（12.5 KB = 12800，不是 125）',
      T.toSize('12.5 KB') === 12800, JSON.stringify(T.toSize('12.5 KB')));
    check('v451-toSize MB 换算', T.toSize('2MB') === 2097152, JSON.stringify(T.toSize('2MB')));
    check('v451-toSize 单位与数字间有空格也认',
      T.toSize('2 MB') === 2097152, JSON.stringify(T.toSize('2 MB')));
    check('v451-toSize 单字母单位（K/M/G）',
      T.toSize('3K') === 3072 && T.toSize('2M') === 2097152,
      JSON.stringify([T.toSize('3K'), T.toSize('2M')]));
    check('v451-toSize GB 换算',
      T.toSize('1.5 GB') === 1610612736, JSON.stringify(T.toSize('1.5 GB')));
    check('v451-toSize 单位大小写不敏感',
      T.toSize('2mb') === 2097152 && T.toSize('2Mb') === 2097152,
      JSON.stringify([T.toSize('2mb'), T.toSize('2Mb')]));
    check('v451-toSize 空与非法输入返回 0',
      T.toSize('') === 0 && T.toSize('abc') === 0 && T.toSize(null) === 0,
      JSON.stringify([T.toSize(''), T.toSize('abc'), T.toSize(null)]));
    // v4.51 fix: regex was unanchored, so '1e3' skipped 1e and matched the trailing 3
    check('v451-toSize rejects mid-string digits (1e3 does not become 3)',
      T.toSize('1e3') === 0, JSON.stringify(T.toSize('1e3')));
    // v4.51 fix: negative size must not be abs()'d
    check('v451-toSize negative returns 0 (no abs)',
      T.toSize('-5') === 0, JSON.stringify(T.toSize('-5')));
    // v4.51 fix: empty parens in 'secret()' were not stripped, keyword showed with bare parens
    check('v451-parseKeywords strips empty-paren count',
      JSON.stringify(T.parseKeywords('secret()')) === '["secret"]',
      JSON.stringify(T.parseKeywords('secret()')));
    check('v451-toSize 0 与负值都不放大',
      T.toSize('0') === 0, JSON.stringify(T.toSize('0')));

    /* ---- parseKeywords：词(次数) 拆分 ---- */
    check('v451-parseKeywords 剥掉出现次数',
      JSON.stringify(T.parseKeywords('秘密(1)|内部(2)')) === '["秘密","内部"]',
      JSON.stringify(T.parseKeywords('秘密(1)|内部(2)')));
    check('v451-parseKeywords 中英文分隔符都认',
      JSON.stringify(T.parseKeywords('秘密(1)，内部(2)；绝密(3)')) === '["秘密","内部","绝密"]',
      JSON.stringify(T.parseKeywords('秘密(1)，内部(2)；绝密(3)')));
    check('v451-parseKeywords 无次数词原样保留',
      JSON.stringify(T.parseKeywords('a(10)|b|c(2)')) === '["a","b","c"]',
      JSON.stringify(T.parseKeywords('a(10)|b|c(2)')));
    check('v451-parseKeywords 去重且空段忽略',
      JSON.stringify(T.parseKeywords('机密|机密|')) === '["机密"]',
      JSON.stringify(T.parseKeywords('机密|机密|')));
    check('v451-parseKeywords 空输入返回空数组',
      T.parseKeywords('').length === 0 && T.parseKeywords(null).length === 0,
      JSON.stringify(T.parseKeywords(null)));

    /* ---- isKeywordCell：整格形状判定 ---- */
    check('v451-isKeywordCell 认「词(次数)」整格',
      T.isKeywordCell('秘密(1)|内部(2)') === true,
      JSON.stringify(T.isKeywordCell('秘密(1)|内部(2)')));
    check('v451-isKeywordCell 拒纯词与路径',
      !T.isKeywordCell('机密') && !T.isKeywordCell('D:' + BS + 'a.txt'),
      JSON.stringify([T.isKeywordCell('机密'), T.isKeywordCell('D:' + BS + 'a.txt')]));
    check('v451-isKeywordCell 拒无分隔符的连续括号',
      !T.isKeywordCell('a(1)b(2)'), JSON.stringify(T.isKeywordCell('a(1)b(2)')));

    /* ---- isPathLike：路径单元格判定 ---- */
    check('v451-isPathLike 认 Windows 绝对路径（两种分隔符）',
      T.isPathLike('C:' + BS + 'a.txt') && T.isPathLike('c:/a.txt'),
      JSON.stringify([T.isPathLike('C:' + BS + 'a.txt'), T.isPathLike('c:/a.txt')]));
    check('v451-isPathLike 认 UNC',
      T.isPathLike(BS + BS + 'srv' + BS + 'share'),
      JSON.stringify(T.isPathLike(BS + BS + 'srv' + BS + 'share')));
    check('v451-isPathLike 认 POSIX 绝对路径',
      T.isPathLike('/usr/a.txt'), JSON.stringify(T.isPathLike('/usr/a.txt')));
    check('v451-isPathLike 拒相对路径与表头字样',
      !T.isPathLike('relative') && !T.isPathLike('路径') && !T.isPathLike(''),
      JSON.stringify([T.isPathLike('relative'), T.isPathLike('路径'), T.isPathLike('')]));
  }
}

/* C14) v4.52 parseHtml 的 hits 语义与跨节合并。
   README 承诺「同一文件跨分节重复出现时合并命中关键字、按路径小写去重」，
   而 hits 的语义是**关键字种类数**（不是出现总次数）——这个区别此前后被锁过：
   既有断言只验了「三词场景 hits===3」，而那种场景下「种类数」与「累加次数」结果相同，
   夹具没有区分力。这里用同词跨节复现场景把两种实现区分开。 */
{
  const BS = String.fromCharCode(92);
  const H = (head, body) =>
    '<table><tr>' + head.map((h) => '<td>' + h + '</td>').join('') + '</tr>'
      + body.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('')
      + '</table>';
  // ① hits 是关键字种类数：同一词出现 2 次（秘密(2)）也只算 1 种
  {
    const html = H(['文件路径', '名称', '关键字', '大小'],
      [['C:' + BS + 'a.txt', 'a', '秘密(2)', '10']]);
    const r = R.parseHtml(html);
    check('v452-hits 是关键字种类数（同词出现 2 次仍算 1）',
      r.files.length === 1 && r.files[0].hits === 1
        && r.files[0].matched.length === 1,
      JSON.stringify(r.files[0]));
  }
  // ② 跨节同词：去重后 hits 仍为 1（若实现改成累加次数，这里会变成 2+5=7）
  {
    const html = H(['文件路径', '名称', '关键字', '大小'],
        [['C:' + BS + 'a.txt', 'a', '秘密(2)', '10']])
      + H(['文件路径', '名称', '关键字'],
        [['c:' + BS + 'A.TXT', 'a', '秘密(5)']]);
    const r = R.parseHtml(html);
    check('v452-跨节同词去重后 hits 仍为 1（不累加出现次数）',
      r.files.length === 1 && r.files[0].hits === 1,
      JSON.stringify(r.files[0]));
  }
  // ③ 跨节异词：合并后 hits 为 2，matched 顺序稳定
  {
    const html = H(['文件路径', '名称', '关键字', '大小'],
        [['C:' + BS + 'a.txt', 'a', '秘密(1)', '10']])
      + H(['文件路径', '名称', '关键字'],
        [['c:' + BS + 'A.TXT', 'a', '内部(1)']]);
    const r = R.parseHtml(html);
    check('v452-跨节异词合并后 hits 为种类数',
      r.files.length === 1 && r.files[0].hits === 2
        && r.files[0].matched.join(',') === '秘密,内部',
      JSON.stringify(r.files[0]));
  }
  // ④ 路径大小写去重：C:\A.TXT 与 c:\a.txt 是同一文件
  {
    const html = H(['文件路径', '名称', '关键字'],
      [['C:' + BS + 'a.txt', 'a', '秘密(1)'], ['c:' + BS + 'A.TXT', 'a', '内部(1)']]);
    const r = R.parseHtml(html);
    check('v452-路径大小写去重（同一文件只收录一次）',
      r.files.length === 1 && r.files[0].file === 'C:' + BS + 'a.txt',
      JSON.stringify(r.files));
  }
  // ⑤ 大小后节补齐：首节没给大小时，后节的值要补上（而不是停在 0）
  {
    const html = H(['文件路径', '关键字'],
        [['C:' + BS + 'b.txt', '机密(1)']])
      + H(['文件路径', '关键字', '大小'],
        [['c:' + BS + 'B.txt', '内部(1)', '2 KB']]);
    const r = R.parseHtml(html);
    check('v452-大小后节补齐（首节缺失时取后节值）',
      r.files.length === 1 && r.files[0].size === 2048,
      JSON.stringify(r.files[0]));
  }
  // ⑥ 各分节有自己的表头：第二节列序不同也能正确取到关键字
  {
    const html = H(['文件路径', '名称', '关键字'],
        [['C:' + BS + 'a.txt', 'a', '秘密(1)']])
      + H(['关键字', '文件路径'],
        [['内部(1)', 'D:' + BS + 'c.txt']]);
    const r = R.parseHtml(html);
    check('v452-各分节独立记忆表头列序',
      r.files.length === 2 && r.files[1].file === 'D:' + BS + 'c.txt'
        && r.files[1].matched.join(',') === '内部',
      JSON.stringify(r.files));
  }
  // ⑦ sections：HTML 有节名，txt / json 清单返回空数组（调用方据此判断要不要显示分节信息）
  {
    const html = "<script>ToggleTable('secA', 1)</script>"
      + H(['文件路径', '关键字'], [['C:' + BS + 'a.txt', '秘密(1)']]);
    const sec = R.parseHtml(html).sections;
    const txtSec = R.parsePathList('C:' + BS + 'a.txt').sections;
    const jsonSec = R.parseJsonList('[{"file":"C:' + BS + 'a.txt"}]').sections;
    check('v452-sections 仅 HTML 有值，清单返回空数组',
      sec.length === 1 && sec[0] === 'secA'
        && Array.isArray(txtSec) && txtSec.length === 0
        && Array.isArray(jsonSec) && jsonSec.length === 0,
      JSON.stringify([sec, txtSec, jsonSec]));
  }
  // ⑧ 空 HTML 不炸
  {
    const r = R.parseHtml('');
    check('v452-空 HTML 返回空结果',
      Array.isArray(r.files) && r.files.length === 0 && Array.isArray(r.sections),
      JSON.stringify(r));
  }
}
console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
