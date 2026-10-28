#!/usr/bin/env node
/**
 * test-formats.mjs —— 格式覆盖 / 规则语义 / 命令行集成回归测试
 *
 * 覆盖三类此前缺少自动化保护的能力：
 *  A. 格式覆盖：Office OOXML 的宏与模板变体（docm / xlsm / pptm 等）被正确识别与脱敏，
 *     含宏文档被标记 vba=true（提示人工复核）。
 *  B. 规则语义：正则规则含反向引用（\1）时语义不被组合正则破坏；命中标签正确归属到规则本身。
 *  C. 命令行集成：scan.mjs 的 CSV 报告带 UTF-8 BOM + RFC4180 转义；
 *     `--from-report` 可与 `--move-to` 组合而不崩溃（历史 TDZ 缺陷）；
 *     脱敏副本内容正确且原始文件不被修改。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEngine(extra = []) {
  const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js'].concat(extra);
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

const D = await loadEngine();
const presetsEngine = D.DWRRules.createEngine({
  rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
  scope: 'all', action: 'delete', custom: '',
});

/* ================= A. 格式覆盖：宏 / 模板变体 ================= */
{
  const officeOkay = ['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm',
    'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'];
  const notOffice = ['doc', 'xls', 'ppt', 'xlsb', 'txt', 'pdf', 'zip'];
  check('formats-宏与模板变体均识别为 Office',
    officeOkay.every((e) => D.DWRDoc.isOfficeFile('样本.' + e)),
    officeOkay.filter((e) => !D.DWRDoc.isOfficeFile('样本.' + e)).join(','));
  check('formats-旧版二进制格式不误判为 Office',
    notOffice.every((e) => !D.DWRDoc.isOfficeFile('样本.' + e)),
    notOffice.filter((e) => D.DWRDoc.isOfficeFile('样本.' + e)).join(','));

  const kindCases = [
    ['a.docm', 'doc'], ['a.dotm', 'doc'],
    ['a.xlsm', 'xls'], ['a.xltx', 'xls'],
    ['a.pptm', 'ppt'], ['a.ppsx', 'ppt'],
    ['a.txt', 'txt'], ['a.md', 'txt'],
  ];
  check('formats-kindOf 归类正确',
    kindCases.every(([n, k]) => D.DWRDoc.kindOf(n) === k),
    kindCases.filter(([n, k]) => D.DWRDoc.kindOf(n) !== k).map(([n]) => n).join(','));

  // 含宏文档：正文脱敏 + vba 标记（宏内文本无法自动处理，须提示人工复核）
  const blob = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内部资料正文</w:t></w:p></w:body></w:document>' },
    { name: 'word/vbaProject.bin', data: new Uint8Array([1, 2, 3, 4]) },
  ]);
  const res = await D.DWRDoc.processOffice(await blob.arrayBuffer(), presetsEngine);
  const zip2 = await D.DWRZip.load(await res.blob.arrayBuffer());
  const doc = await zip2.getText('word/document.xml');
  check('formats-docm 正文已脱敏', res.touched && doc && doc.indexOf('内部') === -1, 'doc=' + doc);
  check('formats-docm 标记含宏待复核', res.vba === true, 'vba=' + res.vba);

  // 模板变体走同一条处理链：pptm 的备注/母版部件也应被覆盖
  const pptmBlob = await D.DWRZip.pack([
    { name: 'ppt/slides/slide1.xml', data: '<a:p><a:t>绝密幻灯片</a:t></a:p>' },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: '<a:p><a:t>机密备注</a:t></a:p>' },
  ]);
  const pptmRes = await D.DWRDoc.processOffice(await pptmBlob.arrayBuffer(), presetsEngine);
  const pz = await D.DWRZip.load(await pptmRes.blob.arrayBuffer());
  const s1 = await pz.getText('ppt/slides/slide1.xml');
  const n1 = await pz.getText('ppt/notesSlides/notesSlide1.xml');
  check('formats-pptm 幻灯片与备注均已脱敏',
    s1 && n1 && s1.indexOf('绝密') === -1 && n1.indexOf('机密') === -1,
    'slide=' + s1 + ' notes=' + n1);
}

/* ================= B. 规则语义：正则反向引用与标签归属 ================= */
{
  // 规则 (.)\1 表示「重复字符」。早期实现把规则包进捕获组拼接为 ((.)\1)，
  // \1 变成对自身未闭合分组的引用（匹配空串），语义被破坏。
  const eng = D.DWRRules.createEngine({
    rules: [{ text: '(.)\\1', type: 'regex', enabled: true }],
    scope: 'all', action: 'delete', custom: '',
  });
  const r = eng.apply('哈哈ab真好');
  check('regex-反向引用语义未被破坏', r.text === 'ab真好', 'text=' + r.text);
  check('regex-命中标签归属规则本身', r.matched.length === 1 && r.matched[0] === '(.)\\1',
    JSON.stringify(r.matched));

  // 规则自带分组 + 多条规则混合：标签仍应精确归属
  const eng2 = D.DWRRules.createEngine({
    rules: [
      { text: '内(部|容)', type: 'regex', enabled: true },
      { text: '机密', type: 'text', enabled: true },
    ],
    scope: 'all', action: 'mask', custom: '',
  });
  const r2 = eng2.apply('内部与机密');
  // v3.7 智能打码：中文词按字数打对应星号（「内部」→ **），不再固定 ***
  check('regex-混合规则替换正确', r2.text === '**与**', 'text=' + r2.text);
  check('regex-混合规则标签完整',
    r2.matched.indexOf('内(部|容)') >= 0 && r2.matched.indexOf('机密') >= 0,
    JSON.stringify(r2.matched));
  check('regex-命中计数正确', r2.hits === 2, 'hits=' + r2.hits);

  // 长词优先仍生效：避免「内部」先命中导致「内部资料」整体漏删语义
  const eng3 = D.DWRRules.createEngine({
    rules: [{ text: '内部', type: 'text', enabled: true }, { text: '内部资料', type: 'text', enabled: true }],
    scope: 'all', action: 'delete', custom: '',
  });
  const r3 = eng3.apply('内部资料');
  check('regex-长词优先仍生效', r3.text === '' && r3.matched[0] === '内部资料',
    'text=' + JSON.stringify(r3.text) + ' matched=' + JSON.stringify(r3.matched));
}

/* ================= C. 命令行集成 ================= */
{

/* C12) v4.50 HTML 报告的 fileUrl / escapeHtml：报告承诺「可点击索引」，
   链接由 fileUrl 生成。它有三个易错点此前零覆盖：
   ① 盘符段（D:）不能被 encodeURIComponent 编码，否则 file:///D%3A/... 打不开；
   ② 路径里的 # 必须编码——不编码会被浏览器当 fragment 截断，链接静默失效；
   ③ 中文要 percent-encode，否则 file:///D:/工作/... 在某些环境下打不开。
   escapeHtml 则是 XSS 防线：报告里会印出文件名与命中词，含 < > & 的文件名存在。 */
{
  const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  const grabFn = (sig) => {
    const s = SCAN.indexOf(sig);
    if (s < 0) return null;
    let d = 0, e = -1;
    for (let i = SCAN.indexOf('{', s); i < SCAN.length; i++) {
      if (SCAN.charAt(i) === '{') d++;
      else if (SCAN.charAt(i) === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return SCAN.slice(s, e);
  };
  const fEsc = grabFn('function escapeHtml(s)');
  const fUrl = grabFn('function fileUrl(p)');
  const fDoc = grabFn('function isDocFile(name)');
  check('v450-escapeHtml / fileUrl / isDocFile 都在 scan.mjs 中',
    !!fEsc && !!fUrl && !!fDoc,
    'esc=' + !!fEsc + ' url=' + !!fUrl + ' doc=' + !!fDoc);
  const BS = String.fromCharCode(92);
  if (fEsc && fUrl) {
    const c = { String: String, RegExp: RegExp, console: { log() {}, error() {} } };
    vm.createContext(c);
    vm.runInContext(fEsc + String.fromCharCode(10) + fUrl
      + '; result = { escapeHtml: escapeHtml, fileUrl: fileUrl };', c);
    const H = c.result;
    // ① 盘符段不编码（这是链接能打开的前提）
    check('v450-fileUrl 盘符段不被编码',
      H.fileUrl('D:' + BS + 'work' + BS + 'a.docx') === 'file:///D:/work/a.docx',
      JSON.stringify(H.fileUrl('D:' + BS + 'work' + BS + 'a.docx')));
    // ② 反斜杠归一成正斜杠（同一路径两种写法应得同一 URL）
    check('v450-fileUrl 反斜杠与正斜杠等价',
      H.fileUrl('D:' + BS + 'w' + BS + 'a.docx') === H.fileUrl('D:/w/a.docx'),
      JSON.stringify(H.fileUrl('D:' + BS + 'w' + BS + 'a.docx'))
        + ' vs ' + JSON.stringify(H.fileUrl('D:/w/a.docx')));
    // ③ # 必须编码：不编码会被当 fragment 截断，链接静默打不开
    check('v450-fileUrl 编码 #（防 fragment 截断）',
      H.fileUrl('D:' + BS + 'a' + BS + 'c#d.docx') === 'file:///D:/a/c%23d.docx',
      JSON.stringify(H.fileUrl('D:' + BS + 'a' + BS + 'c#d.docx')));
    // ④ 空格编码
    check('v450-fileUrl 编码空格',
      H.fileUrl('D:' + BS + 'a b.docx') === 'file:///D:/a%20b.docx',
      JSON.stringify(H.fileUrl('D:' + BS + 'a b.docx')));
    // ⑤ 中文 percent-encode
    check('v450-fileUrl 中文 percent-encode',
      H.fileUrl('D:' + BS + '工作.docx') === 'file:///D:/' + encodeURIComponent('工作.docx'),
      JSON.stringify(H.fileUrl('D:' + BS + '工作.docx')));
    // ⑥ UNC：四斜杠是 file:////server/... 的正确形式
    check('v450-fileUrl UNC 生成四斜杠形式',
      H.fileUrl(BS + BS + 'server' + BS + 'share' + BS + 'a.docx')
        === 'file:////server/share/a.docx',
      JSON.stringify(H.fileUrl(BS + BS + 'server' + BS + 'share' + BS + 'a.docx')));
    // ⑦ 生成的 URL 必须能被 URL 解析回去（不抛错、协议正确）
    let parsed = null;
    try { parsed = new URL(H.fileUrl('D:' + BS + '工作' + BS + '报告.docx')); } catch (e) { parsed = null; }
    check('v450-fileUrl 输出可被 URL 解析',
      !!parsed && parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname).indexOf('工作') >= 0,
      parsed ? parsed.href : 'threw');
    // ⑧ escapeHtml：五个 XML 实体全转义
    check('v450-escapeHtml 转义全部五个实体',
      H.escapeHtml('<a href="x">&\'</a>')
        === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;',
      JSON.stringify(H.escapeHtml('<a href="x">&\'</a>')));
    // ⑨ escapeHtml：空串与非串值安全
    check('v450-escapeHtml 空串与非串值安全',
      H.escapeHtml('') === '' && H.escapeHtml(null) === 'null'
        && H.escapeHtml(42) === '42',
      JSON.stringify(H.escapeHtml(null)));
    // ⑩ 端到端：报告里的链接。fileUrl 已用 encodeURIComponent 把 < > " 编码成 %3C %3E %22，
    //    escapeHtml 再包一层是第二道防线。要验的是**属性不会被撑破**：
    //    href 里除首尾两个引号外不得再出现裸双引号，否则后面的内容会溢出属性。
    const rawUrl = H.fileUrl('D:' + BS + 'a<b>.docx');
    const attr = H.escapeHtml(rawUrl);
    // 属性值里不得出现裸双引号 / 尖括号：出现任何一个都会撑破 href 属性
    check('v450-报告链接不撑破属性（URL 编码 + HTML 转义双重防线）',
      rawUrl.indexOf('%3C') >= 0
        && attr.indexOf('"') < 0
        && attr.indexOf('<') < 0
        && attr.indexOf('>') < 0
        && attr.indexOf('&') < 0,
      'attr=' + attr);
  }
  // isDocFile：--docs-only 的判定基础（README 承诺「只扫真文档，过滤代码与配置噪音」）
  if (fDoc) {
    const c2 = { String: String, RegExp: RegExp, Array: Array, console: { log() {}, error() {} } };
    vm.createContext(c2);
    const docExt = grabFn('const DOC_EXT = [');
    if (!docExt) { console.log('MISS DOC_EXT'); process.exit(1); }
    vm.runInContext(docExt + String.fromCharCode(10) + fDoc + '; result = isDocFile;', c2);
    const isDoc = c2.result;
    check('v450-isDocFile 认主流文档格式',
      ['a.docx', 'b.xlsx', 'c.pptx', 'd.txt', 'e.md', 'f.csv'].every((n) => isDoc(n)),
      ['a.docx', 'b.xlsx', 'c.pptx', 'd.txt', 'e.md', 'f.csv'].filter((n) => !isDoc(n)).join(','));
    check('v450-isDocFile 排除代码与配置',
      ['a.js', 'b.json', 'c.py', 'd.xml', 'e.html', 'f.log'].every((n) => !isDoc(n)),
      ['a.js', 'b.json', 'c.py', 'd.xml', 'e.html', 'f.log'].filter((n) => isDoc(n)).join(','));
    check('v450-isDocFile 大小写不敏感且容忍无扩展名',
      isDoc('A.DOCX') && !isDoc('README') && !isDoc(''),
      'A.DOCX=' + isDoc('A.DOCX'));
  }
}

/* C11) v4.49 输出镜像的三个路径函数：uniqueDest / commonRoot / mirrorRel。
   README 承诺「--out 结构按原路径镜像」「同名自动改名」「多盘符清单按盘符\\路径镜像，
   避免不同盘同名文件互相覆盖」——这三个函数是这三句承诺的全部实现，此前零覆盖。
   同名不改名会静默覆盖已生成的副本；盘符前缀丢了会让 C 盘与 D 盘的 report.docx
   落到同一个目标路径、后写的覆盖先写的。都是数据丢失，且都发生在成功路径上。 */
{
  const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  const grabFn = (sig) => {
    const s = SCAN.indexOf(sig);
    if (s < 0) return null;
    let d = 0, e = -1;
    for (let i = SCAN.indexOf('{', s); i < SCAN.length; i++) {
      if (SCAN.charAt(i) === '{') d++;
      else if (SCAN.charAt(i) === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return SCAN.slice(s, e);
  };
  const fUnique = grabFn('async function uniqueDest(p)');
  const fRoot = grabFn('function commonRoot(files)');
  const fMirror = grabFn('function mirrorRel(file)');
  check('v449-三个路径函数都在 scan.mjs 中',
    !!fUnique && !!fRoot && !!fMirror,
    'unique=' + !!fUnique + ' root=' + !!fRoot + ' mirror=' + !!fMirror);
  const BS = String.fromCharCode(92);
  if (fUnique && fRoot && fMirror) {
    /* ---- uniqueDest：同名自动改名 ---- */
    const loadUd = () => {
      const c = { fsp: fs.promises, path: path, console: { log() {}, error() {} } };
      vm.createContext(c);
      vm.runInContext(grabFn('async function pathExists(p)') + String.fromCharCode(10) + fUnique
        + '; result = uniqueDest;', c);
      return c.result;
    };
    const udBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-ud-'));
    {
      const ud = loadUd();
      const p1 = path.join(udBase, 'a.docx');
      // ① 不存在：原样返回（不改名）
      check('v449-uniqueDest 不存在时原样返回', (await ud(p1)) === p1, 'got ' + (await ud(p1)));
      fs.writeFileSync(p1, 'x');
      // ② 撞名：加 ' (2)'
      const r2 = await ud(p1);
      check('v449-uniqueDest 撞名加序号 (2)',
        r2 === path.join(udBase, 'a (2).docx'), 'got ' + r2);
      // ③ 连续撞名：递增到 (3)
      fs.writeFileSync(r2, 'x');
      const r3 = await ud(p1);
      check('v449-uniqueDest 连续撞名递增到 (3)',
        r3 === path.join(udBase, 'a (3).docx'), 'got ' + r3);
      // ④ 无扩展名：序号加在名字后，不丢文件名
      const p4 = path.join(udBase, 'noext');
      fs.writeFileSync(p4, 'x');
      const r4 = await ud(p4);
      check('v449-uniqueDest 无扩展名时序号加在名字后',
        r4 === path.join(udBase, 'noext (2)'), 'got ' + r4);
      // ⑤ 多段扩展名：只在最后一段前插入（b.tar (2).gz）
      const p6 = path.join(udBase, 'b.tar.gz');
      fs.writeFileSync(p6, 'x');
      const r6 = await ud(p6);
      check('v449-uniqueDest 多段扩展名只在末段前插序号',
        r6 === path.join(udBase, 'b.tar (2).gz'), 'got ' + r6);
      // ⑥ 98 个候选全被占用：抛错而不是无限循环或覆盖
      const p5 = path.join(udBase, 'many.txt');
      for (let i = 0; i < 100; i++) {
        fs.writeFileSync(i === 0 ? p5 : path.join(udBase, 'many (' + i + ').txt'), 'x');
      }
      let exhausted = null;
      try { await ud(p5); } catch (e) { exhausted = e.message; }
      check('v449-uniqueDest 候选耗尽时抛错（不静默覆盖）',
        !!exhausted && exhausted.indexOf('同名文件过多') === 0, 'msg=' + exhausted);
    }
    try { fs.rmSync(udBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    /* ---- commonRoot + mirrorRel：多盘符防覆盖 ---- */
    const loadPaths = () => {
      // 这组断言验证的是 Windows 盘符与 UNC 的规范化结果；显式固定
      // process.platform，避免在 Linux CI 上退回 POSIX 路径语义而误报。
      const c = { process: { platform: 'win32' }, path: path, console: { log() {}, error() {} } };
      vm.createContext(c);
      vm.runInContext(fRoot + String.fromCharCode(10) + fMirror
        + '; result = { commonRoot: commonRoot, mirrorRel: mirrorRel };', c);
      return c.result;
    };
    const P = loadPaths();
    // ① 同目录多文件：公共根是该目录
    check('v449-commonRoot 同目录取该目录',
      P.commonRoot(['D:' + BS + 'w' + BS + 'a.docx', 'D:' + BS + 'w' + BS + 'b.docx'])
        === 'D:' + BS + 'w',
      JSON.stringify(P.commonRoot(['D:' + BS + 'w' + BS + 'a.docx', 'D:' + BS + 'w' + BS + 'b.docx'])));
    // ② 不同子目录：公共根收敛到盘符（Windows 下带尾反斜杠）
    check('v449-commonRoot 不同子目录收敛到盘符',
      P.commonRoot(['D:' + BS + 'w' + BS + 'a.docx', 'D:' + BS + 'o' + BS + 'b.docx'])
        === 'D:' + BS,
      JSON.stringify(P.commonRoot(['D:' + BS + 'w' + BS + 'a.docx', 'D:' + BS + 'o' + BS + 'b.docx'])));
    // ③ 跨盘无公共根：返回空串（触发 mirrorRel 分支）
    check('v449-commonRoot 跨盘返回空串',
      P.commonRoot(['C:' + BS + 'a.docx', 'D:' + BS + 'b.docx']) === '',
      JSON.stringify(P.commonRoot(['C:' + BS + 'a.docx', 'D:' + BS + 'b.docx'])));
    // ④ 空清单安全
    check('v449-commonRoot 空清单返回空串', P.commonRoot([]) === '', 'not empty');
    // ⑤ mirrorRel：盘符冒号换成反斜杠，形成盘符前缀
    check('v449-mirrorRel 盘符变前缀',
      P.mirrorRel('D:' + BS + 'work' + BS + 'a.docx') === 'D' + BS + 'work' + BS + 'a.docx',
      JSON.stringify(P.mirrorRel('D:' + BS + 'work' + BS + 'a.docx')));
    // ⑥ mirrorRel：UNC 路径去掉开头的双反斜杠
    check('v449-mirrorRel UNC 去掉前导双反斜杠',
      P.mirrorRel(BS + BS + 'server' + BS + 'share' + BS + 'a.docx')
        === 'server' + BS + 'share' + BS + 'a.docx',
      JSON.stringify(P.mirrorRel(BS + BS + 'server' + BS + 'share' + BS + 'a.docx')));
    // ⑦b mirrorRel：混合分隔符归一（v4.49 修的缺陷）
    // 保密检查报告的 HTML / JSON 清单不受作者习惯约束，C:/a 与 C\a 会同时出现；
    // 旧实现只换盘符那一处，产出「C\a/b.docx」这种怪异目录名。
    check('v449-mirrorRel 混合分隔符归一为反斜杠',
      P.mirrorRel('d:/work/a.docx') === 'd' + BS + 'work' + BS + 'a.docx',
      JSON.stringify(P.mirrorRel('d:/work/a.docx')));
    // ⑦c 平台保护：POSIX 上原样返回（单盘不会走到这分支，但别把 /home 剥成 home）
    const loadPosix = () => {
      const c = { process: { platform: 'linux' }, String: String, console: { log() {}, error() {} } };
      vm.createContext(c);
      vm.runInContext(fMirror + '; result = mirrorRel;', c);
      return c.result;
    };
    const posix = loadPosix();
    check('v449-mirrorRel POSIX 上原样返回（不剥绝对路径）',
      posix('/home/user/a.docx') === '/home/user/a.docx'
        && posix('D:' + BS + 'work' + BS + 'a.docx') === 'D:' + BS + 'work' + BS + 'a.docx',
      JSON.stringify(posix('/home/user/a.docx')));
    // ⑦ mirrorRel：相对路径原样
    check('v449-mirrorRel 相对路径原样返回',
      P.mirrorRel('relative' + BS + 'a.docx') === 'relative' + BS + 'a.docx',
      JSON.stringify(P.mirrorRel('relative' + BS + 'a.docx')));
    // ⑧ 端到端口径：跨盘同名文件不得落到同一目标（防覆盖）
    {
      const cross = ['C:' + BS + 'a' + BS + 'report.docx', 'D:' + BS + 'b' + BS + 'report.docx'];
      const root = P.commonRoot(cross);
      const dests = cross.map(function (f) {
        const rel = root ? path.relative(root, f) : P.mirrorRel(f);
        return path.join('out', rel);
      });
      check('v449-跨盘同名文件落到不同目标（不互相覆盖）',
        dests[0] !== dests[1] && root === '',
        JSON.stringify(dests));
    }
  }
}

/* C9b) v4.67 格式跳过计数：把检查文件类型列为检查项——
   我们把不支持格式静默 continue 掉时，用户会误以为扫过但没命中。
   本块用真实 CLI 扫一个含图片 + .doc + .txt 的目录，验证概要出现「格式未匹配」行。 */
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-ext-'));
  fs.writeFileSync(path.join(base, 'a.txt'), '内部资料首行\n正文\n机密尾行\n', 'utf8');
  fs.writeFileSync(path.join(base, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(base, 'd.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const rr = spawnSync(process.execPath, [path.join(__dirname, 'scan.mjs'),
    '--dir', base, '--json'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  const out = String(rr.stdout || '');
  check('v467-CLI 概要含格式未匹配行',
    /格式未匹配\s+: 2 个/.test(out),
    out.slice(-400));
  check('v467-CLI 格式未匹配行说明图片需人工复核',
    /图片内文字需人工复核/.test(out),
    out.slice(-300));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* C10) v4.48 moveFile 的跨盘回退与数据安全：--move-to 承诺「跨盘自动回退为复制+校验+删除」，
   但此前只测过同盘 rename 与 dry-run。复制不完整还把源文件删掉会是数据丢失事故，
   而这条路径零覆盖——真实跨盘（EXDEV）在测试机上无法触发，只能抽函数 + 伪造 fsp。 */
{
  const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  // 按花括号配平抽出 moveFile 整体（不用非贪婪正则，函数体里有缩进两格的 }）
  const mstart = SCAN.indexOf('async function moveFile(from, to)');
  check('v448-moveFile 实现在 scan.mjs 中', mstart >= 0, '未找到 moveFile');
  let mend = -1, d = 0;
  for (let i = SCAN.indexOf('{', mstart); i < SCAN.length; i++) {
    if (SCAN.charAt(i) === '{') d++;
    else if (SCAN.charAt(i) === '}') { d--; if (d === 0) { mend = i + 1; break; } }
  }
  check('v448-moveFile 函数体完整截取', mend > mstart, '花括号未配平');
  if (mstart >= 0 && mend > mstart) {
    const body = SCAN.slice(mstart, mend);
    const load = (fspStub) => {
      const c = { fsp: fspStub, console: { log() {}, error() {} } };
      vm.createContext(c);
      vm.runInContext(body + '; result = moveFile;', c);
      return c.result;
    };
    const mvBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-move-'));
    // ① 同盘 rename：源消失、目标就位
    {
      const a = path.join(mvBase, 'a.txt');
      const b = path.join(mvBase, 'b.txt');
      fs.writeFileSync(a, 'hello');
      await load(fs.promises)(a, b);
      check('v448-同盘走 rename：源消失且目标内容正确',
        !fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(b, 'utf8') === 'hello',
        'src=' + fs.existsSync(a) + ' dst=' + fs.existsSync(b));
    }
    // ② rename 抛非 EXDEV 错误时必须原样抛出（不能吞）
    {
      const c2 = path.join(mvBase, 'c.txt');
      const d2 = path.join(mvBase, 'd.txt');
      fs.writeFileSync(c2, 'x');
      const stub = Object.assign({}, fs.promises, {
        rename: async () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; },
      });
      let msg = null;
      try { await load(stub)(c2, d2); } catch (e) { msg = e.message; }
      check('v448-非 EXDEV 的 rename 错误原样抛出', msg === 'permission denied', 'msg=' + msg);
    }
    // ③ EXDEV 回退复制 + 大小校验：复制不完整时抛错、删目标、**保留源文件**
    {
      const e2 = path.join(mvBase, 'e.txt');
      const f2 = path.join(mvBase, 'f.txt');
      fs.writeFileSync(e2, 'abcdefghij');
      const exdev = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; return e; };
      const stub = Object.assign({}, fs.promises, {
        rename: async () => { throw exdev(); },
        copyFile: async (from, to) => { fs.writeFileSync(to, 'partial'); }, // 复制不完整
        stat: async (p) => ({ size: fs.statSync(p).size }),
        unlink: async (p) => { fs.unlinkSync(p); },
      });
      let msg = null;
      try { await load(stub)(e2, f2); } catch (e) { msg = e.message; }
      check('v448-跨盘复制大小不一致时抛错', msg === '跨盘复制后大小不一致', 'msg=' + msg);
      check('v448-复制不完整时删除半成品目标', !fs.existsSync(f2), 'dst still exists');
      check('v448-复制不完整时保留源文件（防数据丢失）',
        fs.existsSync(e2) && fs.readFileSync(e2, 'utf8') === 'abcdefghij',
        'src content=' + (fs.existsSync(e2) ? fs.readFileSync(e2, 'utf8') : '<gone>'));
    }
    // ④ EXDEV 回退且复制完整：正常删源
    {
      const g2 = path.join(mvBase, 'g.txt');
      const h2 = path.join(mvBase, 'h.txt');
      fs.writeFileSync(g2, 'complete');
      const exdev = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; return e; };
      const stub = Object.assign({}, fs.promises, {
        rename: async () => { throw exdev(); },
        copyFile: async (from, to) => { fs.copyFileSync(from, to); },
        stat: async (p) => ({ size: fs.statSync(p).size }),
        unlink: async (p) => { fs.unlinkSync(p); },
      });
      let msg = null;
      try { await load(stub)(g2, h2); } catch (e) { msg = e.message; }
      check('v448-跨盘复制完整时正常完成并删除源',
        msg === null && !fs.existsSync(g2) && fs.readFileSync(h2, 'utf8') === 'complete',
        'msg=' + msg + ' src=' + fs.existsSync(g2));
    }
    // ⑤ 删源失败时回删目标（不能留下「目标是新的、源也在」的双份）
    {
      const i2 = path.join(mvBase, 'i.txt');
      const j2 = path.join(mvBase, 'j.txt');
      fs.writeFileSync(i2, 'data');
      const exdev = () => { const e = new Error('cross-device link'); e.code = 'EXDEV'; return e; };
      const stub = Object.assign({}, fs.promises, {
        rename: async () => { throw exdev(); },
        copyFile: async (from, to) => { fs.copyFileSync(from, to); },
        stat: async (p) => ({ size: fs.statSync(p).size }),
        unlink: async (p) => { if (p === i2) throw new Error('cannot unlink src'); fs.unlinkSync(p); },
      });
      let msg = null;
      try { await load(stub)(i2, j2); } catch (e) { msg = e.message; }
      check('v448-删源失败时抛错且回删目标',
        msg === 'cannot unlink src' && !fs.existsSync(j2) && fs.existsSync(i2),
        'msg=' + msg + ' dst=' + fs.existsSync(j2) + ' src=' + fs.existsSync(i2));
    }
    try { fs.rmSync(mvBase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}
  // v4.63 坏 ZIP 的降级门禁：`Zip.load()` 对无效数据是**同步 throw**（不是 reject），
  //   而 ooxml.js 五处调用都写成 `Zip.load(ab).then(...)` 且没有 .catch()。
  //   此前所有测试只喂合法 ZIP——「不是有效的 ZIP/OOXML 文件」这条用户可见错误零覆盖。
  //   本块锁三件事：① 错误信息可读；② 同步抛（调用方必须包 try 或用 await）；
  //   ③ 端到端：坏文件带上下文报错、不影响同批其它文件。
  {
    const ZSRC = fs.readFileSync(path.join(__dirname, 'js', 'zip.js'), 'utf8');
    const mk = () => {
      const c2 = {
        TextEncoder, TextDecoder,
        CompressionStream: globalThis.CompressionStream,
        DecompressionStream: globalThis.DecompressionStream,
        Blob: globalThis.Blob, Response: globalThis.Response,
        Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise,
        console: { log() {}, warn() {}, error() {} },
      };
      c2.window = c2;
      vm.createContext(c2);
      vm.runInContext(ZSRC, c2);
      return c2.DWRZip;
    };
    // ① 四种坏输入的共同点：错误信息点明「不是有效的 ZIP/OOXML 文件」
    const bads = {
      '空 buffer': new ArrayBuffer(0),
      '随机垃圾': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      '纯文本': new TextEncoder().encode('这不是 ZIP，只是纯文本').buffer,
      '截断的 zip 头': new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
    };
    const msgs = [];
    for (const k of Object.keys(bads)) {
      let msg = null;
      try { mk().load(bads[k]); } catch (e) { msg = e && e.message; }
      msgs.push(k + ':' + (msg || 'NO-THROW'));
    }
    check('v463-坏 ZIP 一律抛出可读错误（四种输入）',
      msgs.every((m) => m.indexOf('不是有效的 ZIP/OOXML 文件') >= 0),
      msgs.join(' | '));
    // ② 契约：同步抛而不是 reject——调用方必须包 try 或写 await
    //   （ooxml.js 五处 `Zip.load(ab).then(...)` 没有 .catch，靠这个契约才没漏）
    let gotPromise = null;
    try { gotPromise = mk().load(new ArrayBuffer(0)); } catch (e) { gotPromise = 'THREW'; }
    check('v463-坏 ZIP 是同步抛（不是 Promise reject）',
      gotPromise === 'THREW',
      'got=' + (gotPromise === 'THREW' ? 'THREW' : typeof gotPromise));
    // 只有 EOCD、没有中央目录时不抛（空归档合法），返回可用的空 ZipArchive
    {
      const empty = new Uint8Array(22);
      const dv = new DataView(empty.buffer);
      dv.setUint32(0, 0x06054b50, true);
      let z = null, threw = null;
      try { z = await mk().load(empty.buffer); } catch (e) { threw = e.message; }
      check('v463-只有 EOCD 的空归档合法（不抛，entries 为空）',
        threw === null && !!z && typeof z.names === 'function' && z.names().length === 0,
        'threw=' + threw + ' names=' + (z ? JSON.stringify(z.names()) : 'n/a'));
    }
    // ③ 端到端：坏文件带上下文报错、不影响同批其它文件（scan.mjs 的 [错误] 行）
    {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-badzip-'));
      fs.writeFileSync(path.join(base, 'good.txt'), '首行内部资料\n正文\n尾行机密\n', 'utf8');
      fs.writeFileSync(path.join(base, 'broken.docx'), '这不是 ZIP，只是纯文本', 'utf8');
      const rr = spawnSync(process.execPath, [path.join(__dirname, 'scan.mjs'),
        '--dir', base, '--json', '--scope', 'all'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
      const out = String(rr.stdout || '');
      check('v463-端到端坏文件带路径与原因报错',
        /\[错误\] .*broken\.docx => 不是有效的 ZIP\/OOXML 文件/.test(out),
        out.slice(0, 300));
      check('v463-端到端坏文件不阻断同批其它文件',
        rr.status === 0 && /\[命中 2\]/.test(out) && /good\.txt/.test(out) && /命中文档数 : 1/.test(out),
        'status=' + rr.status + ' ' + out.slice(0, 200));
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-formats-'));
  const src = path.join(base, 'src');
  const out = path.join(base, 'out');
  const quarantine = path.join(base, 'quarantine');
  fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), '内部资料首行\n正文\n机密尾行\n', 'utf8');
  fs.writeFileSync(path.join(src, 'b,comma.txt'), '秘密首行\n正文\n', 'utf8');
  fs.writeFileSync(path.join(src, 'sub', 'c.md'), '绝密封面\n正文\n', 'utf8');

  const scan = path.join(__dirname, 'scan.mjs');
  const run = (args) => spawnSync(process.execPath, [scan, ...args], { cwd: __dirname, encoding: 'utf8' });

  // C1) JSON 报告 + 脱敏副本
  const reportJson = path.join(base, 'report.json');
  const r1 = run(['--dir', src, '--json', '--report', reportJson]);
  check('cli-扫描生成 JSON 报告', r1.status === 0 && fs.existsSync(reportJson), (r1.stderr || '').slice(0, 200));

  // C2) --from-report 与 --move-to 组合（历史 TDZ 缺陷会在此崩溃）
  const r2 = run(['--from-report', reportJson, '--authorized-root', src, '--out', out, '--concurrency', '4', '--move-to', quarantine]);
  check('cli-from-report+move-to 不再崩溃', r2.status === 0, (r2.stderr || '').slice(0, 300));
  const aOut = path.join(out, 'a.txt');
  const aOutText = fs.existsSync(aOut) ? fs.readFileSync(aOut, 'utf8') : '';
  check('cli-脱敏副本已生成且内容正确',
    aOutText.indexOf('内部') === -1 && aOutText.indexOf('机密') === -1 && aOutText.indexOf('正文') >= 0,
    JSON.stringify(aOutText));
  check('cli-原始文件未被修改',
    fs.readFileSync(path.join(src, 'a.txt'), 'utf8').indexOf('内部资料首行') === 0);

  // C3) CSV 报告：UTF-8 BOM + CRLF + RFC4180 转义
  const reportCsv = path.join(base, 'report.csv');
  const r3 = run(['--dir', src, '--report', reportCsv]);
  check('cli-CSV 报告已生成', r3.status === 0 && fs.existsSync(reportCsv), (r3.stderr || '').slice(0, 200));
  if (fs.existsSync(reportCsv)) {
    const bytes = fs.readFileSync(reportCsv);
    check('cli-CSV 带 UTF-8 BOM',
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
      'head=' + bytes.slice(0, 3).toString('hex'));
    const text = bytes.toString('utf8').slice(1);
    check('cli-CSV 使用 CRLF 行尾', text.indexOf('\r\n') >= 0);
    check('cli-CSV 含逗号的路径被引号包裹',
      /"([^"]*b,comma\.txt)"/.test(text), text.split('\r\n')[1] || '');
    check('cli-CSV 列数正确（5 列）',
      text.trim().split('\r\n').every((ln) => {
        if (!ln) return true;
        let n = 1, inQ = false;
        for (const ch of ln) {
          if (ch === '"') inQ = !inQ;
          else if (ch === ',' && !inQ) n++;
        }
        return n === 5;
      }), text);
  }

  /* C4) --delete / --delete-dry-run：命中文件删除、非命中保留、演练不删 */
  const dbase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-del-'));
  const dsrc = path.join(dbase, 'src');
  fs.mkdirSync(dsrc, { recursive: true });
  fs.writeFileSync(path.join(dsrc, 'hit.txt'), '机密首行\n正文\n', 'utf8');
  fs.writeFileSync(path.join(dsrc, 'ok.txt'), '普通内容首行\n正文\n', 'utf8');
  const dDry = run(['--dir', dsrc, '--delete-dry-run', '--report', path.join(dbase, 'rep.json')]);
  check('cli-delete 演练不删文件',
    dDry.status === 0 && fs.existsSync(path.join(dsrc, 'hit.txt')) && /删除演练/.test(dDry.stdout || ''),
    (dDry.stderr || '').slice(0, 200));
  const dReal = run(['--dir', dsrc, '--delete', '--report', path.join(dbase, 'rep2.json')]);
  check('cli-delete 删除命中文件、保留非命中',
    dReal.status === 0 && !fs.existsSync(path.join(dsrc, 'hit.txt')) && fs.existsSync(path.join(dsrc, 'ok.txt')),
    JSON.stringify((dReal.stdout || '').slice(-160)) + (dReal.stderr || '').slice(0, 200));
  check('cli-delete 汇总行正确', /已删除文件\s+:\s*1 个/.test(dReal.stdout || ''), (dReal.stdout || '').slice(-200));

  /* C4b) --clean --out 不可写 + --delete：写回失败必须可见，且不得删掉唯一副本（v4.69 数据丢失缺陷） */
  const cfb = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-cleanfail-'));
  const cfsrc = path.join(cfb, 'src');
  fs.mkdirSync(cfsrc, { recursive: true });
  const cfHit = path.join(cfsrc, 'secret.txt');
  fs.writeFileSync(cfHit, '机密首行\n正文\n', 'utf8');
  // 用普通文件占住输出路径的前缀，mkdir(<文件>/out) 必然失败（ENOTDIR / EEXIST）
  const cfBlock = path.join(cfb, 'blocker');
  fs.writeFileSync(cfBlock, 'x', 'utf8');
  const cfRun = run(['--dir', cfsrc, '--clean', '--out', path.join(cfBlock, 'out'), '--delete',
                     '--report', path.join(cfb, 'rep.json')]);
  check('v469-写回失败报出文件与目标路径',
    /\[写回失败\]/.test(cfRun.stdout || '') && /secret\.txt/.test(cfRun.stdout || ''),
    JSON.stringify((cfRun.stdout || '').slice(-300)) + (cfRun.stderr || '').slice(0, 200));
  check('v469-写回失败时不删除源文件', fs.existsSync(cfHit), '源文件已被删除，副本没写出去——静默丢数据');
  check('v469-写回失败透传到概要', /写回失败\s+: 1/.test(cfRun.stdout || ''), (cfRun.stdout || '').slice(-300));
  check('v469-写回失败退出码非 0', cfRun.status !== 0, 'status=' + cfRun.status);
  // 正常输出目录仍应「先写成功、后删除」，两条都有
  const cfOk = path.join(cfb, 'good');
  fs.mkdirSync(cfOk, { recursive: true });
  fs.writeFileSync(cfHit, '机密首行\n正文\n', 'utf8');
  const cfRun2 = run(['--dir', cfsrc, '--clean', '--out', cfOk, '--delete',
                      '--report', path.join(cfb, 'rep2.json')]);
  check('v469-写回成功时照常删除源文件并留下副本',
    cfRun2.status === 0 && !fs.existsSync(cfHit) && fs.existsSync(path.join(cfOk, 'secret.txt')),
    JSON.stringify((cfRun2.stdout || '').slice(-260)) + (cfRun2.stderr || '').slice(0, 200));
  try { fs.rmSync(cfb, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  /* C4c) --dir 指向文件 / 不存在路径：不得报「扫描 0 个、命中 0」冒充扫过了（v4.69） */
  const tfb = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-badroot-'));
  const tfFile = path.join(tfb, 'notadir.txt');
  fs.writeFileSync(tfFile, '机密首行\n正文\n', 'utf8');
  const tfRep = path.join(tfb, 'rep.json');
  const tfR1 = run(['--dir', tfFile, '--report', tfRep]);
  check('v469-目标不是目录时报错并非零退出',
    tfR1.status !== 0 && /不是目录/.test((tfR1.stdout || '') + (tfR1.stderr || '')),
    'status=' + tfR1.status + ' out=' + JSON.stringify((tfR1.stdout || '').slice(-200)));
  const tfR2 = run(['--dir', path.join(tfb, 'nope-missing'), '--report', tfRep]);
  check('v469-目标不存在时报错并非零退出',
    tfR2.status !== 0 && /不存在/.test((tfR2.stdout || '') + (tfR2.stderr || '')),
    'status=' + tfR2.status + ' out=' + JSON.stringify((tfR2.stdout || '').slice(-200)));
  check('v469-目标无效时不写出误导性报告', !fs.existsSync(tfRep), tfRep + ' 已存在');
  try { fs.rmSync(tfb, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  /* C4d) --from-report 的输出必须锁在 --out 之内（v4.70 路径穿越）
     复现：报告条目 <t>\a\x.txt，--root 给成更深的 <t>\a\b（打错、或报告跨层级），
     path.relative(root, file) 得到 '..\x.txt'，path.join(<t>\out, '..\x.txt') 就是 <t>\x.txt。
     实测此前 --out 目录压根没建起来，脱敏副本写到旁边，退出码仍是 0、日志一句「生成副本 1 个」。 */
  const tvb = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-traversal-'));
  const tva = path.join(tvb, 'a');
  fs.mkdirSync(tva, { recursive: true });
  const tvSrc = path.join(tva, 'x.txt');
  fs.writeFileSync(tvSrc, '机密首行\n正文\n', 'utf8');
  const tvList = path.join(tvb, 'list.txt');
  fs.writeFileSync(tvList, tvSrc + '\n', 'utf8');
  const tvOut = path.join(tvb, 'out');
  const tvRun = run(['--from-report', tvList, '--authorized-root', tva, '--out', tvOut, '--root', path.join(tva, 'b')]);
  check('v470-越界条目不得写到 --out 之外', !fs.existsSync(path.join(tvb, 'x.txt')),
    '副本写到了 ' + path.join(tvb, 'x.txt') + '，--out 之外');
  // 夹回的位置沿用既有的跨盘回退（源路径去掉盘符后镜像进 --out），不断层级叫什么，只断言：
  // --out 之内恰好一份，且那份是脱敏后的内容。
  const tvFound = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return; // 未夹回时 --out 压根没建起来：出 FAIL 而不是把套件抛断
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else tvFound.push(p);
    }
  })(tvOut);
  check('v470-越界条目夹回 --out 之内且只出一份副本', tvFound.length === 1,
    'out 内文件数=' + tvFound.length + ' ' + JSON.stringify(tvFound.map((p) => path.relative(tvb, p))));
  check('v470-夹回的副本确已脱敏',
    tvFound.length === 1 && !/机密/.test(fs.readFileSync(tvFound[0], 'utf8')),
    tvFound.length === 1 ? fs.readFileSync(tvFound[0], 'utf8').slice(0, 60) : '无副本');
  check('v470-越界要在日志里点名', /\[路径越界\]/.test(tvRun.stdout || '') && /x\.txt/.test(tvRun.stdout || ''),
    (tvRun.stdout || '').slice(-300));
  check('v470-越界计数透传到概要', /路径越界\s*:/.test(tvRun.stdout || ''), (tvRun.stdout || '').slice(-300));
  check('v470-夹回后仍算成功（退出码 0、副本数 1）',
    tvRun.status === 0 && /生成脱敏副本\s*:\s*1 个/.test(tvRun.stdout || ''),
    'status=' + tvRun.status);
  // 正常清单（root 与条目同层级）不能被这套夹回逻辑改坏
  const tvOk = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-traverse-ok-'));
  const tvMirror = path.join(tvOk, 'out2');
  const tvSrc2 = path.join(tvOk, 'a', 'y.txt');
  fs.mkdirSync(path.dirname(tvSrc2), { recursive: true });
  fs.writeFileSync(tvSrc2, '机密首行\n正文\n', 'utf8');
  const tvList2 = path.join(tvOk, 'list.txt');
  fs.writeFileSync(tvList2, tvSrc2 + '\n', 'utf8');
  const tvRun2 = run(['--from-report', tvList2, '--authorized-root', path.dirname(tvSrc2), '--out', tvMirror]);
  check('v470-正常报告仍按镜像层级写出',
    tvRun2.status === 0 && fs.existsSync(path.join(tvMirror, 'y.txt'))
      && !/\[路径越界\]/.test(tvRun2.stdout || ''),
    'status=' + tvRun2.status + ' out=' + (tvRun2.stdout || '').slice(-240));
  try { fs.rmSync(tvb, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(tvOk, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  /* C5) --verify：清除后按「全文 + 全部部件」复查输出，有残留时退出码 2 */
  const vbase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-verify-'));
  const vsrc = path.join(vbase, 'src');
  fs.mkdirSync(vsrc, { recursive: true });
  // 首段命中（firstlast 能清）+ 中段跨 run 命中（firstlast 清不到 → 残留）
  const midDocx = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body>'
      + '<w:p><w:r><w:t>内部资料</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>公</w:t><w:r><w:t>机密</w:t><w:r><w:t>正文</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>普通结尾</w:t></w:r></w:p></w:body></w:document>' },
  ]);
  const vdoc = path.join(vsrc, 'mid.docx');
  fs.writeFileSync(vdoc, Buffer.from(await midDocx.arrayBuffer()));
  const vout = path.join(vbase, 'out');
  const vRes = run(['--dir', vsrc, '--clean', '--out', vout, '--verify', '--report', path.join(vbase, 'rep.json')]);
  check('cli-verify 首尾范围下报出残留且退出码 2',
    vRes.status === 2 && /\[残留 1\]/.test(vRes.stdout || '')
      && /清除后自检\s+: 复检 1 个输出，仍有残留 1 个 \/ 1 处/.test(vRes.stdout || ''),
    JSON.stringify((vRes.stdout || '').slice(-260)) + (vRes.stderr || '').slice(0, 200));
  const vAll = run(['--dir', vsrc, '--clean', '--out', vout, '--verify', '--scope', 'all', '--report', path.join(vbase, 'rep2.json')]);
  check('cli-verify 全文范围清理后 0 残留',
    vAll.status === 0 && /仍有残留 0 个/.test(vAll.stdout || ''),
    JSON.stringify((vAll.stdout || '').slice(-200)));
  const vClean = fs.readFileSync(path.join(vout, 'mid.docx'));
  const vZip = await D.DWRZip.load(vClean.buffer.slice(vClean.byteOffset, vClean.byteOffset + vClean.byteLength));
  const vDocXml = await vZip.getText('word/document.xml');
  check('cli-verify 输出确实已无敏感词',
    !!vDocXml && vDocXml.indexOf('内部') === -1 && vDocXml.indexOf('机密') === -1, vDocXml || '');
  try { fs.rmSync(vbase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(dbase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }

/* C5b) 重复条目名：包内两份 word/document.xml 时，脱敏只改到 readers 实际取用的那份，
        另一份按原始字节原样导出——敏感词留在包里，而 getText / 自检都看不见（v4.69） */
{
  const dupBlob = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>内部机密甲</w:t></w:r></w:p></w:body></w:document>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>内部机密乙</w:t></w:r></w:p></w:body></w:document>' },
  ]);
  const dupAb = await dupBlob.arrayBuffer();
  const zDup = await D.DWRZip.load(dupAb);
  check('v469-重名条目解析后只保留一份',
    zDup.names().filter(function (n) { return n === 'word/document.xml'; }).length === 1,
    'names=' + zDup.names().join(','));
  const dupRes = await D.DWRDoc.processOffice(dupAb, presetsEngine);
  const zOut = await D.DWRZip.load(await dupRes.blob.arrayBuffer());
  const dupNames = zOut.names();
  check('v469-输出包内不得存在重名条目',
    dupNames.length === new Set(dupNames).size, dupNames.join(','));
  const dupDoc = await zOut.getText('word/document.xml');
  check('v469-重名包脱敏后正文无敏感词',
    !!dupDoc && dupDoc.indexOf('内部') === -1 && dupDoc.indexOf('机密') === -1, dupDoc || '(无)');
}

/* C6) 条目名 / 缩略图残留：ZIP 原始字节里明文可见，清理后复检应为 0 */
{
  const nbase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-name-'));
  const nsrc = path.join(nbase, 'src');
  fs.mkdirSync(nsrc, { recursive: true });
  const innerXlsx = await D.DWRZip.pack([
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>绝密内部数据</t></si></sst>' },
  ]);
  const nameDocx = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/word/document.xml" ContentType="c"/>'
      + '<Override PartName="/word/embeddings/绝密资料.xlsx" ContentType="d"/>'
      + '<Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships><Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>公开标题</w:t></w:r></w:p></w:body></w:document>' },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Id="rId9" Type="ole" Target="embeddings/绝密资料.xlsx"/></Relationships>' },
    { name: 'word/embeddings/绝密资料.xlsx', data: Buffer.from(await innerXlsx.arrayBuffer()) },
    { name: 'docProps/thumbnail.jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2]) },
  ]);
  fs.writeFileSync(path.join(nsrc, '附件.docx'), Buffer.from(await nameDocx.arrayBuffer()));
  const nout = path.join(nbase, 'out');
  const nRes = run(['--dir', nsrc, '--clean', '--out', nout, '--verify', '--report', path.join(nbase, 'rep.json')]);
  check('cli-条目名残留清理后退出码 0 且 0 残留',
    nRes.status === 0 && /仍有残留 0 个/.test(nRes.stdout || ''),
    JSON.stringify((nRes.stdout || '').slice(-300)) + (nRes.stderr || '').slice(0, 200));
  const outFile = fs.readFileSync(path.join(nout, '附件.docx'));
  const outZip = await D.DWRZip.load(outFile.buffer.slice(outFile.byteOffset, outFile.byteOffset + outFile.byteLength));
  const outNames = outZip.names();
  check('cli-条目名已重命名、缩略图已移除',
    outNames.indexOf('word/embeddings/绝密资料.xlsx') < 0
      && outNames.indexOf('word/embeddings/资料.xlsx') >= 0
      && outNames.indexOf('docProps/thumbnail.jpeg') < 0,
    JSON.stringify(outNames));
  // 模拟不解包、直接搜原始字节的保密检查软件：敏感词的 UTF-8 字节一定找不到
  check('cli-输出 ZIP 原始字节检索不到敏感词',
    outFile.indexOf(Buffer.from('绝密', 'utf8')) < 0
      && outFile.indexOf(Buffer.from('内部', 'utf8')) < 0,
    'raw bytes still contain sensitive word');
  try { fs.rmSync(nbase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/* C6b) v4.45 缩略图定位收窄：正文插图不得被当成缩略图删掉。
   旧 THUMB_RE 是 /(?:^|\/)thumbnail\.(emf|wmf|jpg|jpeg|png)$/i，
   word/media/thumbnail.png 这类被 document.xml 的 r:embed 引用的**正文插图**也会中招，
   删完 .rels 的 Target 仍指向已删除部件，Word / WPS 打开即报「文档损坏需修复」。
   OOXML 规范里文档缩略图固定是 docProps/thumbnail.*，此处锁死该口径。 */
{
  const tbase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-thumb-'));
  const tsrc = path.join(tbase, 'src');
  fs.mkdirSync(tsrc, { recursive: true });
  // 一份带正文插图（word/media/thumbnail.png）+ 真缩略图（docProps/thumbnail.jpeg）的 docx
  const thumbDocx = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/word/document.xml" ContentType="c"/>'
      + '<Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/>'
      + '<Default Extension="png" ContentType="image/png"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships><Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>'
      + '<Relationship Id="rId2" Type="metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>机密正文</w:t></w:r></w:p>'
      + '<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:body></w:document>' },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="image" Target="media/thumbnail.png"/></Relationships>' },
    { name: 'docProps/thumbnail.jpeg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
    { name: 'word/media/thumbnail.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  fs.writeFileSync(path.join(tsrc, '插图.docx'), Buffer.from(await thumbDocx.arrayBuffer()));
  const tout = path.join(tbase, 'out');
  const tRes = run(['--dir', tsrc, '--clean', '--out', tout, '--json', '--scope', 'all']);
  check('v445-带正文插图的 docx 清理后退出码 0', tRes.status === 0,
    JSON.stringify((tRes.stdout || '').slice(-200)) + (tRes.stderr || '').slice(0, 200));
  const tFile = fs.readFileSync(path.join(tout, '插图.docx'));
  const tZip = await D.DWRZip.load(tFile.buffer.slice(tFile.byteOffset, tFile.byteOffset + tFile.byteLength));
  const tNames = tZip.names();
  // 真缩略图应被移除（首页渲染图可能带出敏感内容）
  check('v445-docProps 缩略图仍被移除',
    tNames.indexOf('docProps/thumbnail.jpeg') < 0,
    JSON.stringify(tNames));
  // 正文插图必须保留：它是被 r:embed 引用的真实内容
  check('v445-正文插图不被误删（修 v4.45 前的误删）',
    tNames.indexOf('word/media/thumbnail.png') >= 0,
    JSON.stringify(tNames));
  // 插图保留后，引用它的 .rels 不得悬空
  const tRels = await tZip.getText('word/_rels/document.xml.rels');
  check('v445-插图的关系引用仍然有效（不悬空）',
    !!tRels && /Target="media\/thumbnail\.png"/.test(tRels),
    'rels=' + String(tRels).slice(0, 200));
  try { fs.rmSync(tbase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

  /* C7) --from-report：导入通用检查软件 HTML 报告（UTF-16LE 编码）批量脱敏 */
  {
    const hbase = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-htmlrep-'));
    const hsrc = path.join(hbase, 'src');
    fs.mkdirSync(path.join(hsrc, '工作'), { recursive: true });
    const hDocx = await D.DWRZip.pack([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内部资料</w:t></w:p><w:p><w:t>普通结尾</w:t></w:p></w:body></w:document>' },
    ]);
    const docxPath = path.join(hsrc, '工作', 'a.docx');
    fs.writeFileSync(docxPath, Buffer.from(await hDocx.arrayBuffer()));
    fs.writeFileSync(path.join(hsrc, 'b.txt'), '机密说明\n普通内容\n', 'utf8');
    fs.writeFileSync(path.join(hsrc, 'c.pdf'), Buffer.from([1, 2, 3]));

    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const htmlRows = [
      ['a.docx', docxPath, '1024', '内部(1)'],
      ['b.txt', path.join(hsrc, 'b.txt'), '32', '机密(2)|内部(1)'],
      ['c.pdf', path.join(hsrc, 'c.pdf'), '2048', '秘密(1)'],
      ['a.docx', docxPath, '1024', '内部(1)'], // 跨分节重复：应去重
    ];
    let html = '<html><body><table>'
      + '<tr><td>文件名称</td><td>文件路径</td><td>文件大小</td><td>命中关键字</td><td>命中百分比</td></tr>';
    htmlRows.forEach((r) => { html += '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>'; });
    html += '</table><script>ToggleTable(\'关键词命中文件记录\')</script></body></html>';
    const htmlReport = path.join(hbase, '标密报告.html');
    fs.writeFileSync(htmlReport, Buffer.from('\uFEFF' + html, 'utf16le')); // 常见检查报告编码

    const hout = path.join(hbase, 'out');
    const hr = run(['--from-report', htmlReport, '--authorized-root', hsrc, '--out', hout, '--root', hsrc]);
    check('cli-from-report 解析 HTML 报告（UTF-16LE，4 行去重为 3 条）',
      hr.status === 0 && /3 条/.test(hr.stdout || ''), (hr.stdout || '').slice(-200) + (hr.stderr || '').slice(0, 200));
    check('cli-from-report 生成 2 个副本、跳过 1 个不支持的 PDF',
      /生成脱敏副本: 2 个/.test(hr.stdout || '') && /不支持格式\s+: 1 个/.test(hr.stdout || ''), (hr.stdout || '').slice(-260));
    check('cli-from-report 输出镜像目录结构',
      fs.existsSync(path.join(hout, '工作', 'a.docx')) && fs.existsSync(path.join(hout, 'b.txt')),
      JSON.stringify(fs.readdirSync(hout)));
    const hTxt = fs.readFileSync(path.join(hout, 'b.txt'), 'utf8');
    check('cli-from-report 副本内容已脱敏',
      hTxt.indexOf('机密') < 0 && hTxt.indexOf('普通内容') >= 0, hTxt);
    try { fs.rmSync(hbase, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

﻿/* ================= D. 内部 XML 覆盖盲区（v2.2） ================= */
{
  // D1) 跟踪修改的删除运行：历史记录仍可被 unzip 读出，必须一并清理
  const delBlob = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:r><w:t>正文内部资料</w:t></w:r>' +
        '<w:del w:id="1" w:author="a"><w:r><w:delText>该处保留机密历史</w:delText></w:r></w:del></w:p>' +
        '<w:p><w:ins w:id="2"><w:r><w:t>插入的绝密新增</w:t></w:r></w:ins></w:p></w:body></w:document>',
    },
  ]);
  const delRes = await D.DWRDoc.processOffice(await delBlob.arrayBuffer(), presetsEngine);
  const delZip = await D.DWRZip.load(await delRes.blob.arrayBuffer());
  const delDoc = await delZip.getText('word/document.xml');
  check('盲区-跟踪删除文本已清理', delDoc.indexOf('机密历史') === -1, delDoc);
  check('盲区-跟踪插入文本已清理', delDoc.indexOf('绝密') === -1, delDoc);

  // D2) 域代码（instrText）与书签名 / 域指令属性
  const instrBlob = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:r><w:instrText> HYPERLINK "内部书签" </w:instrText></w:r></w:p>' +
        '<w:p><w:bookmarkStart w:id="9" w:name="内部书签"/><w:r><w:t>占位</w:t></w:r></w:p>' +
        '<w:p><w:fldSimple w:instr=" REF 内部 "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p></w:body></w:document>',
    },
  ]);
  const instrRes = await D.DWRDoc.processOffice(await instrBlob.arrayBuffer(), presetsEngine);
  const instrDoc = await (await D.DWRZip.load(await instrRes.blob.arrayBuffer())).getText('word/document.xml');
  check('盲区-域代码已清理', instrDoc.indexOf('内部书签') === -1, instrDoc);
  check('盲区-书签名已清理', instrDoc.indexOf('w:name="内部书签"') === -1, instrDoc);
  check('盲区-域指令属性已清理', instrDoc.indexOf('w:instr=" REF 内部 "') === -1, instrDoc);

  // D3) xlsx 公式里的字符串字面量
  const fBlob = await D.DWRZip.pack([
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData><row><c r="A1" t="str"><f>IF(A2=1,"内部资料","无")</f><v>无</v></c></row></sheetData></worksheet>',
    },
  ]);
  const fRes = await D.DWRDoc.processOffice(await fBlob.arrayBuffer(), presetsEngine);
  const fDoc = await (await D.DWRZip.load(await fRes.blob.arrayBuffer())).getText('xl/worksheets/sheet1.xml');
  check('盲区-公式字面量已清理', fDoc.indexOf('内部资料') === -1, fDoc);
  check('盲区-公式结构与引号转义保持',
    fDoc.indexOf('<f>IF(A2=1,&quot;资料&quot;,&quot;无&quot;)</f>') >= 0 && fDoc.indexOf('<v>无</v>') >= 0, fDoc);

  // D4) PPT 形状名称 / 替换文字（alt text）
  const pBlob = await D.DWRZip.pack([
    {
      name: 'ppt/slides/slide1.xml',
      data: '<p:spTree><p:sp><p:nvSpPr><p:cNvPr id="4" name="内部图示" descr="机密结构图"/></p:nvSpPr>' +
        '<p:txBody><a:p><a:t>绝密页</a:t></a:p></p:txBody></p:sp></p:spTree>',
    },
  ]);
  const pRes = await D.DWRDoc.processOffice(await pBlob.arrayBuffer(), presetsEngine);
  const pDoc = await (await D.DWRZip.load(await pRes.blob.arrayBuffer())).getText('ppt/slides/slide1.xml');
  check('盲区-PPT 形状名与描述已清理',
    pDoc.indexOf('内部图示') === -1 && pDoc.indexOf('机密结构图') === -1, pDoc);

  // D5) 扫描路径同样覆盖（只读）
  const scanDel = await D.DWRDoc.scanOffice(await delBlob.arrayBuffer(), presetsEngine);
  check('盲区-扫描也统计跟踪删除', scanDel.hits >= 3, 'hits=' + scanDel.hits);
}

﻿/* ================= E. 清除报告（v2.3） ================= */
{
  // E1) CSV：元信息以 # 注释行输出，明细表头规范，RFC 4180 转义
  const csv = D.DWRUtil.buildCleanReportCsv(
    [['生成时间', '2026-09-26 10:00'], ['文件总数', 3], ['清除敏感词处数', 5]],
    [
      { file: 'a,b.txt', hits: 2, matched: ['内部', '机密'], status: 'done', out: 'zip' },
      { file: 'c.txt', hits: 0, matched: [], status: 'error', out: 'zip' },
    ]
  );
  const csvLines = csv.split('\r\n');
  check('报告-CSV 元信息注释行', csvLines[0] === '#生成时间,2026-09-26 10:00', csvLines[0]);
  check('报告-CSV 汇总注释行', csvLines[1] === '#文件总数,3' && csvLines[2] === '#清除敏感词处数,5', csvLines.slice(1, 3).join('|'));
  check('报告-CSV 表头', csvLines[3] === 'file,hits,matched,status,out', csvLines[3]);
  check('报告-CSV 明细行', csvLines[4] === '"a,b.txt",2,内部 / 机密,done,zip', csvLines[4]);
  check('报告-CSV 空命中不产生多余空格', csvLines[5] === 'c.txt,0,,error,zip', csvLines[5]);
  check('报告-CSV 行尾 CRLF', csv.slice(-2) === '\r\n');

  // E2) 引号 / 换行 / 逗号三级转义
  const tricky = D.DWRUtil.buildCleanReportCsv([], [
    { file: 'say "hi", ok.txt', hits: 1, matched: ['内部'], status: 'done', out: 'zip' },
    { file: 'multi\nline.txt', hits: 1, matched: [], status: 'done', out: 'zip' },
  ]);
  check('报告-CSV 引号翻倍', tricky.indexOf('"say ""hi"", ok.txt",1') >= 0, tricky);
  check('报告-CSV 换行被引号包裹', tricky.indexOf('"multi\nline.txt"') >= 0, tricky);

  // E2b) CSV 公式注入防护（v4.70）：文件名与命中词都来自被扫描的文档，属于外来数据；
  // 检查人员拿 Excel 双击打开报告时，以 = / + / @ / 制表符 开头的单元格会被当公式求值。
  check('v470-csvCell 以 = 开头时加文本前缀', D.DWRUtil.csvCell('=2+3') === "'=2+3",
    JSON.stringify(D.DWRUtil.csvCell('=2+3')));
  check('v470-csvCell 对 + @ 制表符同样加前缀',
    D.DWRUtil.csvCell('+p') === "'+p" && D.DWRUtil.csvCell('@x') === "'@x"
      && D.DWRUtil.csvCell('\tx') === "'\tx" && D.DWRUtil.csvCell('-1+2') === "'-1+2",
    JSON.stringify([D.DWRUtil.csvCell('+p'), D.DWRUtil.csvCell('-1+2'), D.DWRUtil.csvCell('\tx')]));
  check('v470-csvCell 普通值与数字不多加前缀',
    D.DWRUtil.csvCell('abc') === 'abc' && D.DWRUtil.csvCell('12') === '12'
      && D.DWRUtil.csvCell('12.3 KB') === '12.3 KB' && D.DWRUtil.csvCell('-') === '-',
    JSON.stringify([D.DWRUtil.csvCell('abc'), D.DWRUtil.csvCell('12'), D.DWRUtil.csvCell('-')]));
  check('v470-csvCell 前缀在引号转义之前（RFC 转义不破）',
    D.DWRUtil.csvCell('=a,b') === "\"'=a,b\"" && D.DWRUtil.csvCell('=x"y') === "\"'=x\"\"y\"",
    JSON.stringify([D.DWRUtil.csvCell('=a,b'), D.DWRUtil.csvCell('=x\"y')]));
  // 真实命令行产出的报告也要带上这层防护（scan.mjs 与网页端共用同一份 csvCell）。
  // 注入载体用「词库里的词」：--words 可以只给一批外部词（导入的词库 / 上级下发的清单），
  // 命中的词直接进报告的 matched 列；路径列是绝对路径（以盘符开头），本身不会以 = 起头。
  const injB = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-csvinj-'));
  const injSrc = path.join(injB, 'src');
  fs.mkdirSync(injSrc, { recursive: true });
  fs.writeFileSync(path.join(injSrc, 'hit.txt'), '=2+3 首行\n正文\n', 'utf8');
  const injRep = path.join(injB, 'rep.csv');
  const injRun = spawnSync(process.execPath, [path.join(__dirname, 'scan.mjs'),
    '--dir', injSrc, '--report', injRep, '--words', '=2+3'], { cwd: __dirname, encoding: 'utf8' });
  const injCsv = fs.existsSync(injRep) ? fs.readFileSync(injRep, 'utf8') : '';
  check('v470-命令行报告里 = 开头的命中词不被当公式',
    injRun.status === 0 && /'=2\+3/.test(injCsv) && !/(^|\r\n|,)=2\+3/.test(injCsv),
    'status=' + injRun.status + ' csv=' + JSON.stringify(injCsv.slice(0, 300)));
  try { fs.rmSync(injB, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  // E3) JSON：meta + files 结构完整
  const json = JSON.parse(D.DWRUtil.buildCleanReportJson(
    [['文件总数', 3], ['清除敏感词处数', 5]],
    [{ file: 'a.txt', hits: 2, matched: ['内部', '机密'], status: 'done', out: 'zip' }]
  ));
  check('报告-JSON meta 键值', json.meta['文件总数'] === 3 && json.meta['清除敏感词处数'] === 5,
    JSON.stringify(json.meta));
  check('报告-JSON files 明细', json.files.length === 1 && json.files[0].hits === 2 &&
    json.files[0].matched.join('|') === '内部|机密' && json.files[0].out === 'zip',
    JSON.stringify(json.files));

  // E4) 空数据不抛错
  check('报告-空数据可用', D.DWRUtil.buildCleanReportCsv([], []) === 'file,hits,matched,status,out\r\n');
  check('报告-空 meta JSON', JSON.parse(D.DWRUtil.buildCleanReportJson([], [])).files.length === 0);
}

/* ================= F. 繁体写法覆盖（v2.5） ================= */
{
  // 繁体文档同样要清干净：正文、共享字符串、文档属性三处都验
  const docxTrad = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>內部資料正文</w:t></w:p></w:body></w:document>' },
    { name: 'docProps/core.xml', data: '<cp:coreProperties><dc:title>機密標題</dc:title><cp:keywords>內部,絕密</cp:keywords></cp:coreProperties>' },
  ]);
  const tradRes = await D.DWRDoc.processOffice(await docxTrad.arrayBuffer(), presetsEngine);
  const tradZip = await D.DWRZip.load(await tradRes.blob.arrayBuffer());
  const tradDoc = await tradZip.getText('word/document.xml');
  const tradCore = await tradZip.getText('docProps/core.xml');
  check('繁简-docx 正文繁体已清除',
    tradDoc && tradDoc.indexOf('內部') === -1 && tradDoc.indexOf('資料') >= 0, tradDoc);
  check('繁简-文档属性繁体已清除',
    tradCore && tradCore.indexOf('機密') === -1 && tradCore.indexOf('內部') === -1 &&
    tradCore.indexOf('絕密') === -1, tradCore);

  // xlsx 共享字符串（繁体）同样覆盖
  const xlsxTrad = await D.DWRZip.pack([
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>機密工作表</t></si><si><t>內部通知</t></si></sst>' },
  ]);
  const xlRes = await D.DWRDoc.processOffice(await xlsxTrad.arrayBuffer(), presetsEngine);
  const xlZip = await D.DWRZip.load(await xlRes.blob.arrayBuffer());
  const sst = await xlZip.getText('xl/sharedStrings.xml');
  check('繁简-xlsx 共享字符串繁体已清除',
    sst && sst.indexOf('機密') === -1 && sst.indexOf('內部') === -1 && sst.indexOf('工作表') >= 0, sst);

  // 一对多传统字不能被误删：「臺灣」不是「台」，「頭髮」不是「发」
  const ambDocx = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>臺灣分公司頭髮护理</w:t></w:p></w:body></w:document>' },
  ]);
  const ambRes = await D.DWRDoc.processOffice(await ambDocx.arrayBuffer(), presetsEngine);
  // 无命中：引擎直接返回 blob=null（保持原样不改写），这正说明没有误伤
  check('繁简-一对多字不误伤', ambRes.hits === 0 && ambRes.touched === false && ambRes.blob === null,
    'hits=' + ambRes.hits + ' touched=' + ambRes.touched + ' blob=' + ambRes.blob);
}

/* ================= G. 跨 run 合并后的空运行清理（v2.6） ================= */
{
  // G1) 跨 run 命中：文本合并进首个运行，被清空的运行应被清掉，输出 XML 不留垃圾
  const g1 = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p>' +
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">这是内</w:t></w:r>' +
        '<w:r><w:t>部资料</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>' +
        '<w:r><w:t>机密内容</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);
  const g1Res = await D.DWRDoc.processOffice(await g1.arrayBuffer(), presetsEngine);
  const g1Zip = await D.DWRZip.load(await g1Res.blob.arrayBuffer());
  const g1Doc = await g1Zip.getText('word/document.xml');
  check('空run-跨 run 命中已清除', g1Doc.indexOf('内部') === -1 && g1Doc.indexOf('机密') === -1, g1Doc);
  check('空run-被清空的运行已清理', !/<w:t(?:\s[^>]*)?>\s*<\/w:t>/.test(g1Doc), g1Doc);
  check('空run-首个运行的格式保留', g1Doc.indexOf('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">这是资料 内容</w:t>') >= 0, g1Doc);

  // G2) 含换行 / 制表 / 绘图的运行绝不能被动到（删了会改变排版）
  const g2 = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:r><w:t>内部</w:t></w:r><w:r><w:br/></w:r>' +
        '<w:r><w:tab/></w:r><w:r><w:drawing><a:blip/></w:drawing></w:r>' +
        '<w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);
  const g2Res = await D.DWRDoc.processOffice(await g2.arrayBuffer(), presetsEngine);
  const g2Doc = await (await D.DWRZip.load(await g2Res.blob.arrayBuffer())).getText('word/document.xml');
  check('空run-换行/制表/绘图运行保留',
    g2Doc.indexOf('<w:br/>') >= 0 && g2Doc.indexOf('<w:tab/>') >= 0 && g2Doc.indexOf('<w:drawing>') >= 0, g2Doc);

  // G3) 整段即敏感词：段落本身要保留（不能吃掉空行结构）。合并后整个 run 只剩空文本节点——
  //     v2.26 起不再把这个 run 整段删掉：真实文档里 run 往往是书签 / 域代码 / 批注锚点的挂载点，
  //     删 run 会把这些内容一起带走；留下空 <w:t></w:t> 不影响阅读，Word 也不会报文档损坏。
  const g3 = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>绝密</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>正文保留</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);
  const g3Res = await D.DWRDoc.processOffice(await g3.arrayBuffer(), presetsEngine);
  const g3Doc = await (await D.DWRZip.load(await g3Res.blob.arrayBuffer())).getText('word/document.xml');
  check('空run-整段命中后段落结构保留',
    g3Doc.indexOf('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t></w:t></w:r></w:p>') >= 0
      && g3Doc.indexOf('正文保留') >= 0, g3Doc);

  // G4) drawingML（a:t）同样清理
  const g4 = await D.DWRZip.pack([
    {
      name: 'ppt/slides/slide1.xml',
      data: '<p:sld><p:spTree><a:p><a:r><a:rPr/></a:r><a:t>绝密幻灯片</a:t></a:r><a:r><a:t>标题</a:t></a:r></a:p></p:spTree></p:sld>',
    },
  ]);
  const g4Res = await D.DWRDoc.processOffice(await g4.arrayBuffer(), presetsEngine);
  const g4Doc = await (await D.DWRZip.load(await g4Res.blob.arrayBuffer())).getText('ppt/slides/slide1.xml');
  check('空run-drawingML 空运行已清理',
    g4Doc.indexOf('绝密') === -1 && g4Doc.indexOf('幻灯片标题') >= 0 && !/<a:t(?:\s[^>]*)?>\s*<\/a:t>/.test(g4Doc), g4Doc);

  // G5) 无命中的文档必须逐字节原样返回（不引入任何清理副作用）
  const g5 = await D.DWRZip.pack([
    {
      name: 'word/document.xml',
      data: '<w:document><w:body><w:p><w:r><w:t></w:t></w:r><w:r><w:t>普通正文</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);
  const g5Res = await D.DWRDoc.processOffice(await g5.arrayBuffer(), presetsEngine);
  check('空run-无命中时逐字节原样', g5Res.touched === false && g5Res.blob === null,
    'touched=' + g5Res.touched);
}

/* ================= H. 元数据不跟随首尾范围（v2.10） ================= */
{
  // 默认范围（首行+尾行）下，工作表名 / 表名 / 列名 / 文档属性属于元数据，必须整部件清理；
  // 否则「内部资料」这种工作表名会原样留在包里，unzip 即可读出。
  const metaZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      data: '<workbook xmlns:r="r"><sheets>' +
        '<sheet name="内部资料" sheetId="1" r:id="rId1"/>' +
        '<sheet name="Sheet2" sheetId="2" r:id="rId2"/>' +
        '<sheet name="Sheet3" sheetId="3" r:id="rId3"/></sheets>' +
        '<definedNames><definedName name="机密口径">Sheet1!A1</definedName></definedNames></workbook>',
    },
    {
      name: 'xl/tables/table1.xml',
      data: '<table xmlns:r="r" id="1" name="内部表" displayName="内部表" ref="A1:B2">' +
        '<tableColumns count="2"><tableColumn id="1" name="机密列"/><tableColumn id="2" name="普通列"/></tableColumns></table>',
    },
    {
      name: 'docProps/core.xml',
      data: '<cp:coreProperties xmlns:cp="c" xmlns:dc="dc"><dc:title>普通标题</dc:title>' +
        '<dc:creator>张三</dc:creator><dc:subject>内部用途说明</dc:subject>' +
        '<cp:lastModifiedBy>李四</cp:lastModifiedBy></cp:coreProperties>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData>' +
        '<row><c r="A1" t="inlineStr"><is><t>第一行机密</t></is></c></row>' +
        '<row><c r="A2" t="inlineStr"><is><t>中间内部</t></is></c></row>' +
        '<row><c r="A3" t="inlineStr"><is><t>末行绝密</t></is></c></row>' +
        '</sheetData></worksheet>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Type="t" Target="内部资料.docx"/></Relationships>',
    },
  ]);

  const firstlastEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  });

  const metaRes = await D.DWRDoc.processOffice(await metaZip.arrayBuffer(), firstlastEngine);
  const metaOut = await D.DWRZip.load(await metaRes.blob.arrayBuffer());
  const metaWb = await metaOut.getText('xl/workbook.xml');
  const metaTb = await metaOut.getText('xl/tables/table1.xml');
  const metaCp = await metaOut.getText('docProps/core.xml');
  const metaSh = await metaOut.getText('xl/worksheets/sheet1.xml');
  const metaRels = await metaOut.getText('word/_rels/document.xml.rels');

  check('元数据-工作表名已清理', metaWb.indexOf('内部资料') === -1 && metaWb.indexOf('机密口径') === -1, metaWb);
  check('元数据-工作表名结构保留', metaWb.indexOf('<sheet name=') >= 0 && metaWb.indexOf('r:id=') >= 0, metaWb);
  check('元数据-表名列名已清理', metaTb.indexOf('内部表') === -1 && metaTb.indexOf('机密列') === -1, metaTb);
  check('元数据-文档属性已清理', metaCp.indexOf('内部用途说明') === -1 && metaCp.indexOf('张三') >= 0, metaCp);

  // 正文仍然遵循用户选择的范围：首行 / 尾行清掉，中间行保留
  check('元数据-首行正文已清理', metaSh.indexOf('第一行机密') === -1, metaSh);
  check('元数据-尾行正文已清理', metaSh.indexOf('末行绝密') === -1, metaSh);
  check('元数据-中间行保留（范围仍生效）', metaSh.indexOf('中间内部') >= 0, metaSh);

  // .rels 的 Target 是结构引用，改写会让文档打不开，因此保持原样
  check('元数据-rels 目标不被改写', metaRels.indexOf('Target="内部资料.docx"') >= 0, metaRels);

  // 扫描路径同样看得到这些命中（否则报告会漏）
  const metaScan = await D.DWRDoc.scanOffice(await metaZip.arrayBuffer(), firstlastEngine);
  check('元数据-扫描统计到元数据命中', metaScan.hits >= 5, 'hits=' + metaScan.hits);
  check('元数据-扫描命中词含内部与机密',
    metaScan.matched.indexOf('内部') >= 0 && metaScan.matched.indexOf('机密') >= 0,
    JSON.stringify(metaScan.matched));
}

{
  // I 组：customXml（内容类型 / 文档管理属性）同样是元数据，按 docProps / workbook 的口径整部件处理。
  // 属性值与「中间节点」此前完全漏清（unzip 即可读出），默认范围下也不例外。
  const cxZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'customXml/item1.xml',
      data: '<ContentTypeSchema><ContentType>内部资料</ContentType>' +
        '<Department>科研处</Department>' +
        '<Remark>中间行机密描述</Remark>' +
        '<Secret level="机密">经济数据</Secret>' +
        '<Note>第一行绝密说明</Note></ContentTypeSchema>',
    },
  ]);

  for (const scope of ['firstlast', 'all']) {
    const cxEngine = D.DWRRules.createEngine({
      rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
      scope: scope, action: 'delete', custom: '',
    });
    const cxRes = await D.DWRDoc.processOffice(await cxZip.arrayBuffer(), cxEngine);
    const cxOut = await (await D.DWRZip.load(await cxRes.blob.arrayBuffer())).getText('customXml/item1.xml');
    check('customXml-' + scope + ' 全部清理（含属性值与中间节点）',
      cxOut.indexOf('内部') === -1 && cxOut.indexOf('机密') === -1 && cxOut.indexOf('绝密') === -1, cxOut);
    check('customXml-' + scope + ' 结构与无关内容保留',
      cxOut.indexOf('level="***"') >= 0 && cxOut.indexOf('科研处') >= 0 && cxOut.indexOf('经济数据') >= 0, cxOut);
  }

  const cxScan = await D.DWRDoc.scanOffice(await cxZip.arrayBuffer(), D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })),
    scope: 'firstlast', action: 'delete', custom: '',
  }));
  check('customXml-扫描不漏报（属性值与中间节点）', cxScan.hits === 4, 'hits=' + cxScan.hits);
  check('customXml-扫描命中词含机密与绝密',
    cxScan.matched.indexOf('机密') >= 0 && cxScan.matched.indexOf('绝密') >= 0,
    JSON.stringify(cxScan.matched));
}

/* ================= J. 图表文本缓存与内嵌文档扫描（v2.16） ================= */
{
  // 探针发现两处漏报：① ppt/xl 图表把分类 / 系列名抄一份在 <c:v> 缓存里，此前整部件漏清；
  // ② scanOffice 不递归内嵌 Office 文档，会出现「扫描 0 命中、清理时却又改动文件」。
  const chartXml = '<c:chartSpace xmlns:c="http://x"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>内部资料项目</c:v></c:pt></c:strCache></c:strRef></c:tx><c:tx><c:rich><a:p><a:r><a:t>图表内富文本机密</a:t></a:r></a:p></c:rich></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:pt idx="0"><c:v>机密类别</c:v></c:pt><c:pt idx="1"><c:v>普通类别</c:v></c:pt></c:strCache></c:strRef></c:cat></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>';
  const slideXml = '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>图表标题</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  const ssXml = '<sst><si><t>内部数据</t></si></sst>';
  const embeddedXlsx = await D.DWRZip.pack([
    { name: 'xl/sharedStrings.xml', data: ssXml },
  ]);
  const chartZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', data: slideXml },
    { name: 'ppt/charts/chart1.xml', data: chartXml },
    { name: 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', data: new Uint8Array(await embeddedXlsx.arrayBuffer()) },
    { name: 'word/vbaProject.bin', data: new Uint8Array([1, 2, 3]) },
  ]);

  const chartScan = await D.DWRDoc.scanOffice(await chartZip.arrayBuffer(), presetsEngine);
  check('图表-扫描命中缓存文本', chartScan.hits === 4, 'hits=' + chartScan.hits + ' matched=' + JSON.stringify(chartScan.matched));
  check('图表-扫描识别内嵌文档命中', chartScan.matched.indexOf('内部') >= 0, JSON.stringify(chartScan.matched));

  const chartRes = await D.DWRDoc.processOffice(await chartZip.arrayBuffer(), presetsEngine);
  check('图表-清理命中数与扫描一致', chartRes.hits === chartScan.hits, 'res=' + chartRes.hits + ' scan=' + chartScan.hits);
  check('图表-清理后重新扫描 0 命中', (await D.DWRDoc.scanOffice(await chartRes.blob.arrayBuffer(), presetsEngine)).hits === 0);
  const chartOut = await D.DWRZip.load(await chartRes.blob.arrayBuffer());
  const chartAfter = await chartOut.getText('ppt/charts/chart1.xml');
  check('图表-缓存文本已清理', chartAfter.indexOf('内部资料项目') === -1 && chartAfter.indexOf('机密类别') === -1, chartAfter.slice(0, 200));
  check('图表-富文本同样清理', chartAfter.indexOf('图表内富文本机密') === -1, chartAfter.slice(0, 200));
  check('图表-无关缓存保留', chartAfter.indexOf('普通类别') >= 0, chartAfter.slice(0, 200));
  check('图表-公式引用保留', chartAfter.indexOf('<c:f>Sheet1!$A$2:$A$3</c:f>') >= 0, chartAfter.slice(0, 200));

  const embBytes = await chartOut.getBytes('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx');
  const embZip = await D.DWRZip.load(embBytes.buffer.slice(embBytes.byteOffset, embBytes.byteOffset + embBytes.byteLength));
  check('图表-内嵌工作簿已清理', (await embZip.getText('xl/sharedStrings.xml')).indexOf('内部数据') === -1);
  check('图表-VBA 仍提示人工复核', chartRes.vba === true, JSON.stringify({ vba: chartRes.vba }));

  const ex = await D.DWRDoc.extractText(await chartZip.arrayBuffer());
  check('图表-预览抽取覆盖缓存文本', ex.indexOf('内部资料项目') >= 0 && ex.indexOf('机密类别') >= 0, ex.slice(0, 200));
}

/* ================= K. 数据验证下拉与条件格式公式（v2.17） ================= */
{
  // 密级下拉（「公开,内部,机密,绝密」）与条件格式公式是 unzip 即可读出的漏报面：
  // 它们属于配置而非正文，因此不跟随用户选择的首尾范围。
  const dvXml = "<worksheet xmlns=\"http://x\"><sheetPr/><dataValidations count=\"2\"><dataValidation type=\"list\" sqref=\"A1:A9\" promptTitle=\"内部提示\" prompt=\"请输入机密口径\" errorTitle=\"内部错误\" error=\"机密值不合法\"><formula1>\"公开,内部,机密,绝密\"</formula1></dataValidation><dataValidation type=\"whole\" operator=\"between\" sqref=\"B1:B9\"><formula1>1</formula1><formula2>100</formula2></dataValidation></dataValidations><conditionalFormatting sqref=\"C1:C9\"><cfRule type=\"cellIs\" operator=\"equal\" dxfId=\"0\" text=\"内部资料\"><formula>\"机密\"</formula></cfRule><cfRule type=\"cellIs\" operator=\"equal\" dxfId=\"1\" text=\"普通\"><formula>\"公开\"</formula></cfRule></conditionalFormatting><sheetData><row><c t=\"inlineStr\"><is><t>普通单元格</t></is></c></row></sheetData></worksheet>";
  const dvZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/worksheets/sheet1.xml", data: dvXml },
  ]);

  const dvScan = await D.DWRDoc.scanOffice(await dvZip.arrayBuffer(), presetsEngine);
  check("数据验证-扫描命中下拉与公式", dvScan.hits >= 5 && ["内部","机密","绝密"].every((w) => dvScan.matched.indexOf(w) >= 0), "hits=" + dvScan.hits + " " + JSON.stringify(dvScan.matched));

  // 默认范围是 firstlast：配置类文本仍须整块清理（否则中间的规则会被跳过）
  const flEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: "text", enabled: true })),
    scope: "firstlast", action: "delete", custom: "",
  });
  const dvRes = await D.DWRDoc.processOffice(await dvZip.arrayBuffer(), flEngine);
  const dvOut = await D.DWRZip.load(await dvRes.blob.arrayBuffer());
  const dvAfter = await dvOut.getText("xl/worksheets/sheet1.xml");
  check("数据验证-下拉列表已清理", dvAfter.indexOf("公开,内部,机密,绝密") === -1 && dvAfter.indexOf("机密,绝密") === -1, dvAfter.slice(0, 300));
  check("数据验证-提示语已清理", dvAfter.indexOf("内部提示") === -1 && dvAfter.indexOf("请输入机密口径") === -1, dvAfter.slice(0, 300));
  check("数据验证-错误提示已清理", dvAfter.indexOf("机密值不合法") === -1, dvAfter.slice(0, 300));
  check("数据验证-条件格式公式已清理", dvAfter.indexOf("<formula>\"\u673a\u5bc6\"</formula>") === -1, dvAfter.slice(0, 300));
  check("数据验证-无关公式保留", dvAfter.indexOf("<formula1>1</formula1>") >= 0 && dvAfter.indexOf("<formula2>100</formula2>") >= 0, dvAfter.slice(0, 300));
  check("数据验证-清理后重扫 0 命中", (await D.DWRDoc.scanOffice(await dvRes.blob.arrayBuffer(), flEngine)).hits === 0);
  check("数据验证-XML 结构仍可解析", /<dataValidations count="2">/.test(dvAfter) && dvAfter.indexOf("<sheetData>") >= 0, dvAfter.slice(0, 200));
}
/* ================= L. 公式缓存值 / 现代批注 / 富数据（v2.18） ================= */
{
  // 探针发现四处漏报（unzip 都能原样读出）：
  // ① <c t="str"><f>CONCATENATE("机密","数据")</f><v>机密数据</v></c> 里公式算出来的缓存值；
  // ② xl/threadedComments/*.xml 的 <text>（现代批注正文）—— 整个部件没进任何规格；
  // ③ xl/richData/rdrichvalue.xml 的 <v>；
  // ④ xl/comments1.xml 的 <author> 与批注正文。
  // 缓存值与批注正文属于内容，因此跟随用户选择的首尾范围；数字与共享字符串索引天然不命中。
  const sheetXml = "<worksheet xmlns=\"x\"><sheetData>"
    + "<row r=\"1\"><c r=\"A1\" t=\"str\"><f>CONCATENATE(\"\u673a\u5bc6\",\"\u6570\u636e\")</f><v>\u673a\u5bc6\u6570\u636e</v></c></row>"
    + "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>0</v></c></row>"
    + "<row r=\"3\"><c r=\"A3\"><v>12345</v></c></row>"
    + "</sheetData></worksheet>";
  // 首尾范围：首个 / 末个非空 <v> 清理，中间的数字缓存值保留（与 <is> / <si> 同语义）
  const sheetFlXml = "<worksheet xmlns=\"x\"><sheetData>"
    + "<row r=\"1\"><c r=\"A1\" t=\"str\"><f>CONCATENATE(\"\u673a\u5bc6\",\"\u6570\u636e\")</f><v>\u673a\u5bc6\u6570\u636e</v></c></row>"
    + "<row r=\"2\"><c r=\"A2\"><v>42</v></c></row>"
    + "<row r=\"3\"><c r=\"A3\" t=\"str\"><f>CONCATENATE(\"\u5185\u90e8\",\"\u6c47\u603b\")</f><v>\u5185\u90e8\u6c47\u603b</v></c></row>"
    + "</sheetData></worksheet>";
  const threadedXml = "<threadedComments><threadedComment ref=\"A1\" personId=\"0\"><text>\u5185\u90e8\u7ebf\u7a0b\u6279\u6ce8</text></threadedComment>"
    + "<threadedComment ref=\"B2\" personId=\"0\"><text>\u673a\u5bc6\u8865\u5145</text></threadedComment></threadedComments>";
  const legacyXml = "<comments><authors><author>\u5185\u90e8\u4f5c\u8005</author></authors>"
    + "<commentList><comment ref=\"A1\" authorId=\"0\"><text><r><t>\u6279\u6ce8\u673a\u5bc6</t></r></text></comment></commentList></comments>";
  const richXml = "<rdRichValues><rv><v>\u5185\u90e8\u5bcc\u503c</v></rv></rdRichValues>";

  const fullZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    { name: "xl/threadedComments/threadedComment1.xml", data: threadedXml },
    { name: "xl/comments1.xml", data: legacyXml },
    { name: "xl/persons/person1.xml", data: "<persons><person displayName=\"\u5185\u90e8\u7528\u6237\" id=\"0\"/></persons>" },
    { name: "xl/richData/rdrichvalue.xml", data: richXml },
  ]);

  const fullScan = await D.DWRDoc.scanOffice(await fullZip.arrayBuffer(), presetsEngine);
  check("\u7f13\u5b58\u503c-\u626b\u63cf\u547d\u4e2d\u516c\u5f0f\u7f13\u5b58\u4e0e\u73b0\u4ee3\u6279\u6ce8", fullScan.hits >= 6 && ["\u5185\u90e8", "\u673a\u5bc6"].every((w) => fullScan.matched.indexOf(w) >= 0), "hits=" + fullScan.hits + " " + JSON.stringify(fullScan.matched));

  const fullRes = await D.DWRDoc.processOffice(await fullZip.arrayBuffer(), presetsEngine);
  check("\u7f13\u5b58\u503c-\u6e05\u7406\u547d\u4e2d\u6570\u4e0e\u626b\u63cf\u4e00\u81f4", fullRes.hits === fullScan.hits, "res=" + fullRes.hits + " scan=" + fullScan.hits);
  check("\u7f13\u5b58\u503c-\u6e05\u7406\u540e\u91cd\u65b0\u626b\u63cf 0 \u547d\u4e2d", (await D.DWRDoc.scanOffice(await fullRes.blob.arrayBuffer(), presetsEngine)).hits === 0);

  const fullOut = await D.DWRZip.load(await fullRes.blob.arrayBuffer());
  const sheetAfter = await fullOut.getText("xl/worksheets/sheet1.xml");
  check("\u7f13\u5b58\u503c-\u516c\u5f0f\u4e0e\u7f13\u5b58\u503c\u5747\u5df2\u6e05\u7406", sheetAfter.indexOf("CONCATENATE(&quot;&quot;,&quot;\u6570\u636e&quot;)") >= 0 && sheetAfter.indexOf("<v>\u6570\u636e</v>") >= 0, sheetAfter.slice(0, 240));
  check("\u7f13\u5b58\u503c-\u65e0\u5173\u7f13\u5b58\u4fdd\u7559", sheetAfter.indexOf("<v>0</v>") >= 0 && sheetAfter.indexOf("<v>12345</v>") >= 0, sheetAfter.slice(0, 240));

  const tcAfter = await fullOut.getText("xl/threadedComments/threadedComment1.xml");
  check("\u73b0\u4ee3\u6279\u6ce8-\u6b63\u6587\u5df2\u6e05\u7406", tcAfter.indexOf("\u5185\u90e8\u7ebf\u7a0b\u6279\u6ce8") === -1 && tcAfter.indexOf("\u673a\u5bc6\u8865\u5145") === -1 && tcAfter.indexOf("<text>\u7ebf\u7a0b\u6279\u6ce8</text>") >= 0, tcAfter);
  check("\u4f20\u7edf\u6279\u6ce8-author \u4e0e\u6b63\u6587\u5df2\u6e05\u7406", (await fullOut.getText("xl/comments1.xml")).indexOf("\u5185\u90e8\u4f5c\u8005") === -1, '');
  check("\u73b0\u4ee3\u6279\u6ce8-\u8054\u7cfb\u4eba\u663e\u793a\u540d\u5df2\u6e05\u7406", (await fullOut.getText("xl/persons/person1.xml")).indexOf("\u5185\u90e8\u7528\u6237") === -1, '');
  check("\u5bcc\u6570\u636e-\u5bcc\u503c\u5df2\u6e05\u7406", (await fullOut.getText("xl/richData/rdrichvalue.xml")).indexOf("\u5185\u90e8\u5bcc\u503c") === -1, '');

  const ex = await D.DWRDoc.extractText(await fullZip.arrayBuffer());
  check("\u7f13\u5b58\u503c-\u9884\u89c8\u62bd\u53d6\u8986\u76d6\u7f13\u5b58\u503c\u4e0e\u6279\u6ce8", ex.indexOf("\u673a\u5bc6\u6570\u636e") >= 0 && ex.indexOf("\u5185\u90e8\u7ebf\u7a0b\u6279\u6ce8") >= 0, ex.slice(0, 120));

  const flZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/worksheets/sheet1.xml", data: sheetFlXml },
  ]);
  const flEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: "text", enabled: true })),
    scope: "firstlast", action: "delete", custom: "",
  });
  const flRes = await D.DWRDoc.processOffice(await flZip.arrayBuffer(), flEngine);
  const flAfter = await (await D.DWRZip.load(await flRes.blob.arrayBuffer())).getText("xl/worksheets/sheet1.xml");
  check("\u7f13\u5b58\u503c-\u9996\u5c3e\u8303\u56f4\u6e05\u7406\u9996\u5c3e\u7f13\u5b58\u503c", flAfter.indexOf("<v>\u6570\u636e</v>") >= 0 && flAfter.indexOf("<v>\u6c47\u603b</v>") >= 0, flAfter.slice(0, 260));
  check("\u7f13\u5b58\u503c-\u9996\u5c3e\u8303\u56f4\u4fdd\u7559\u4e2d\u95f4\u6570\u5b57\u7f13\u5b58", flAfter.indexOf("<v>42</v>") >= 0, flAfter.slice(0, 260));
  check("\u7f13\u5b58\u503c-\u9996\u5c3e\u8303\u56f4\u6e05\u7406\u540e\u91cd\u626b 0 \u547d\u4e2d", (await D.DWRDoc.scanOffice(await flRes.blob.arrayBuffer(), flEngine)).hits === 0);
}
/* ================= M. PowerPoint 批注部件（v2.19） ================= */
{
  // 既有测试钉住的是「<p:cm><p:txBody><a:p><a:t>」这种传统形态；探针又发现现代批注会把
  // <a:t> 直接挂在 <p:cm> 下（没有 <a:p> 包裹）——只扫 <a:p> 块时整段漏掉。
  const cm = (body) => '<p:cmLst xmlns:p="urn:p" xmlns:a="urn:a">' + body + '</p:cmLst>';
  const modernXml = cm("<p:cm authorId=\"0\" dt=\"2026-01-01T00:00:00\" idx=\"1\"><a:t>\u5185\u90e8\u73b0\u4ee3\u8bc4\u8bba</a:t></p:cm>"
    + "<p:cm authorId=\"0\" dt=\"2026-01-01T00:00:00\" idx=\"2\"><a:t>\u673a\u5bc6\u8865\u5145</a:t></p:cm>");
  // 传统形态 + 自闭合 <p:cm/> 混排：自闭合不能把后面的批注吞进同一个块
  const mixedXml = cm("<p:cm authorId=\"0\" dt=\"t\" idx=\"1\"><p:txBody><a:p><a:r><a:t>\u673a\u5bc6\u4f20\u7edf</a:t></a:r></a:p></p:txBody></p:cm>"
    + "<p:cm authorId=\"0\" dt=\"t\" idx=\"2\"><a:t>\u673a\u5bc6\u73b0\u4ee3</a:t></p:cm>"
    + "<p:cm authorId=\"0\" dt=\"t\" idx=\"3\"/>");

  const cmZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "ppt/comments/modernComment1.xml", data: modernXml },
    { name: "ppt/persons/person1.xml", data: "<p:personLst xmlns:p=\"urn:p\"><p:person authorId=\"0\" displayName=\"\u5185\u90e8\u8bc4\u8bba\u4eba\"/></p:personLst>" },
  ]);
  const cmScan = await D.DWRDoc.scanOffice(await cmZip.arrayBuffer(), presetsEngine);
  check("\u73b0\u4ee3\u6279\u6ce8-\u626b\u63cf\u547d\u4e2d\u88f8 <a:t>", cmScan.hits >= 2 && ["\u5185\u90e8", "\u673a\u5bc6"].every((w) => cmScan.matched.indexOf(w) >= 0), "hits=" + cmScan.hits + " " + JSON.stringify(cmScan.matched));
  const cmRes = await D.DWRDoc.processOffice(await cmZip.arrayBuffer(), presetsEngine);
  check("\u73b0\u4ee3\u6279\u6ce8-\u6e05\u7406\u547d\u4e2d\u6570\u4e0e\u626b\u63cf\u4e00\u81f4", cmRes.hits === cmScan.hits, "res=" + cmRes.hits + " scan=" + cmScan.hits);
  check("\u73b0\u4ee3\u6279\u6ce8-\u6e05\u7406\u540e\u91cd\u626b 0 \u547d\u4e2d", (await D.DWRDoc.scanOffice(await cmRes.blob.arrayBuffer(), presetsEngine)).hits === 0);

  const cmOut = await D.DWRZip.load(await cmRes.blob.arrayBuffer());
  const modernAfter = await cmOut.getText("ppt/comments/modernComment1.xml");
  check("\u73b0\u4ee3\u6279\u6ce8-\u6b63\u6587\u5df2\u6e05\u7406", modernAfter.indexOf("\u5185\u90e8\u73b0\u4ee3\u8bc4\u8bba") === -1 && modernAfter.indexOf("\u673a\u5bc6\u8865\u5145") === -1, modernAfter);
  check("\u73b0\u4ee3\u6279\u6ce8-\u5360\u4f4d\u7ed3\u6784\u4fdd\u7559", modernAfter.indexOf("<p:cm authorId=\"0\" dt=\"2026-01-01T00:00:00\" idx=\"1\"><a:t>") >= 0, modernAfter);
  check("\u73b0\u4ee3\u6279\u6ce8-\u8bc4\u8bba\u4eba\u5c5e\u6027\u503c\u5df2\u6e05\u7406", (await cmOut.getText("ppt/persons/person1.xml")).indexOf("\u5185\u90e8\u8bc4\u8bba\u4eba") === -1, "");
  const cmEx = await D.DWRDoc.extractText(await cmZip.arrayBuffer());
  check("\u73b0\u4ee3\u6279\u6ce8-\u9884\u89c8\u62bd\u53d6\u8986\u76d6", cmEx.indexOf("\u5185\u90e8\u73b0\u4ee3\u8bc4\u8bba") >= 0, cmEx.slice(0, 120));

  // 混合部件：传统形态照旧按段落清理，自闭合 <p:cm/> 不会吞掉后面的批注
  const mixZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "ppt/comments/modernComment1.xml", data: mixedXml },
  ]);
  const mixRes = await D.DWRDoc.processOffice(await mixZip.arrayBuffer(), presetsEngine);
  const mixAfter = await (await D.DWRZip.load(await mixRes.blob.arrayBuffer())).getText("ppt/comments/modernComment1.xml");
  check("\u73b0\u4ee3\u6279\u6ce8-\u4f20\u7edf\u5f62\u6001\u4ecd\u6b63\u5e38\u6e05\u7406", mixAfter.indexOf("\u673a\u5bc6\u4f20\u7edf") === -1 && mixAfter.indexOf("<p:txBody><a:p><a:r><a:t>\u4f20\u7edf</a:t></a:r></a:p></p:txBody>") >= 0, mixAfter);
  check("\u73b0\u4ee3\u6279\u6ce8-\u81ea\u95ed\u5408\u6807\u7b7e\u4e0d\u5438\u8d76\u540e\u9762\u6279\u6ce8", mixAfter.indexOf("<p:cm authorId=\"0\" dt=\"t\" idx=\"3\"/>") >= 0 && mixAfter.indexOf("\u673a\u5bc6\u73b0\u4ee3") === -1 && mixAfter.indexOf("<a:t>\u73b0\u4ee3</a:t>") >= 0, mixAfter);

  // 批注是自由文本，没有「首行 / 尾行」语义：firstlast 范围下仍整部件清理
  const flZip = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "ppt/comments/modernComment1.xml", data: cm("<p:cm authorId=\"0\" dt=\"t\" idx=\"1\"><a:t>\u5185\u90e8\u4e00</a:t></p:cm><p:cm authorId=\"0\" dt=\"t\" idx=\"2\"><a:t>\u5185\u90e8\u4e8c</a:t></p:cm><p:cm authorId=\"0\" dt=\"t\" idx=\"3\"><a:t>\u5185\u90e8\u4e09</a:t></p:cm>") },
  ]);
  const flCmtEngine = D.DWRRules.createEngine({
    rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: "text", enabled: true })),
    scope: "firstlast", action: "delete", custom: "",
  });
  const flCmtRes = await D.DWRDoc.processOffice(await flZip.arrayBuffer(), flCmtEngine);
  const flCmtAfter = await (await D.DWRZip.load(await flCmtRes.blob.arrayBuffer())).getText("ppt/comments/modernComment1.xml");
  check("\u73b0\u4ee3\u6279\u6ce8-firstlast \u8303\u56f4\u4e0b\u4ecd\u6574\u4ef6\u5904\u7406", ["\u5185\u90e8\u4e00", "\u5185\u90e8\u4e8c", "\u5185\u90e8\u4e09"].every((s) => flCmtAfter.indexOf(s) === -1) && (flCmtAfter.match(/<a:t>/g) || []).length === 3, flCmtAfter);
  check("\u73b0\u4ee3\u6279\u6ce8-firstlast \u6e05\u7406\u540e\u91cd\u626b 0 \u547d\u4e2d", (await D.DWRDoc.scanOffice(await flCmtRes.blob.arrayBuffer(), flCmtEngine)).hits === 0);
}

/* ================= N. 空格变体反规避（v2.20） ================= */
{
  // 零视觉宽度字符把敏感词拆开：旧规则只覆盖 Cf 的一小段与半角 / 全角空格，
  // NBSP / 数学空格 / bidi 隔离符 / 行段分隔符等全部漏检；现统一走 GAP 字符表
  const splitBy = (w, g) => w.split('').join(g);
  const gapDocx = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>'
      + splitBy('内部', '\u00a0') + '资料正文'
      + splitBy('机密', '\u2009') + '数据'
      + splitBy('绝密', '\u2066') + '附件'
      + '</w:t></w:p></w:body></w:document>' },
  ]);
  const gapScan = await D.DWRDoc.scanOffice(await gapDocx.arrayBuffer(), presetsEngine);
  check('空格变体-扫描命中 NBSP / 数学空格 / 隔离符拆词',
    gapScan.hits === 3 && ['内部', '机密', '绝密'].every((w) => gapScan.matched.indexOf(w) >= 0),
    'hits=' + gapScan.hits + ' ' + JSON.stringify(gapScan.matched));
  const gapRes = await D.DWRDoc.processOffice(await gapDocx.arrayBuffer(), presetsEngine);
  check('空格变体-清理命中数与扫描一致', gapRes.hits === gapScan.hits,
    'res=' + gapRes.hits + ' scan=' + gapScan.hits);
  const gapAfter = await (await D.DWRZip.load(await gapRes.blob.arrayBuffer())).getText('word/document.xml');
  check('空格变体-正文已清理且无关文字保留',
    gapAfter && ['内部', '机密', '绝密'].every((w) => gapAfter.indexOf(w) === -1)
      && gapAfter.indexOf('资料正文') >= 0 && gapAfter.indexOf('数据') >= 0 && gapAfter.indexOf('附件') >= 0, gapAfter);
  check('空格变体-命中区间内无 GAP 字符残留',
    !/[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(gapAfter), gapAfter);
  check('空格变体-清理后重扫 0 命中',
    (await D.DWRDoc.scanOffice(await gapRes.blob.arrayBuffer(), presetsEngine)).hits === 0);

  // 区间外的同类字符原样保留（不把全文的 NBSP 都吸走）
  const keepDocx = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内部\u00a0资料、机密\u2028附件</w:t></w:p></w:body></w:document>' },
  ]);
  const keepAfter = await (await D.DWRZip.load(await (await D.DWRDoc.processOffice(await keepDocx.arrayBuffer(), presetsEngine)).blob.arrayBuffer())).getText('word/document.xml');
  check('空格变体-区间外同类字符原样保留',
    keepAfter.indexOf('\u00a0资料') >= 0 && keepAfter.indexOf('\u2028附件') >= 0 && keepAfter.indexOf('内部') === -1, keepAfter);
}

/* ================= P. 预览定位行使用可读部位名（v2.75） ================= */
// 预览栏正对普通用户：抽取结果的定位行早期直接摊包内路径（[word/document.xml] / [xl/sharedStrings.xml]），
// 既看不懂又像报错；现在换成中文部位名，并保留方括号包裹（previewProcess 仍按同一口径跳过）。
// 附件部件若抽不出正文，不得留下只有标签、没有内容的空行。
{
  // 定位行后必须紧跟至少一行内容：空部件不得留下只有标签、没有正文的孤立行
  const orphanLabels = (text) => {
    const ls = text.split('\n');
    let n = 0;
    for (let i = 0; i < ls.length; i++) {
      if (!/^\[[^\]]+\]$/.test(ls[i])) continue;
      const next = ls[i + 1];
      if (next === undefined || next === '' || /^\[[^\]]+\]$/.test(next)) n++;
    }
    return n;
  };
  const docxZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>正文内部</w:t></w:p></w:body></w:document>' },
    { name: 'word/header1.xml', data: '<w:hdr><w:p><w:t>页眉绝密</w:t></w:p></w:hdr>' },
    { name: 'word/footer1.xml', data: '<w:ftr><w:p><w:t>页脚秘密</w:t></w:p></w:ftr>' },
    { name: 'word/comments.xml', data: '<w:comments><w:comment><w:p><w:t>批注机密</w:t></w:p></w:comment></w:comments>' },
    { name: 'docProps/core.xml', data: '<cp:coreProperties><dc:title>内部标题</dc:title></cp:coreProperties>' },
  ]);
  const de = await D.DWRDoc.extractText(await docxZip.arrayBuffer());
  check('预览标签-docx 不暴露部件路径',
    ['word/', 'docProps/', '.xml]'].every((s) => de.indexOf(s) < 0), de.slice(0, 200));
  check('预览标签-docx 部位名可读',
    ['[正文]', '[页眉]', '[页脚]', '[批注]', '[文档属性]'].every((s) => de.indexOf(s) >= 0), de.slice(0, 200));
  check('预览标签-docx 正文照常抽取',
    ['正文内部', '页眉绝密', '页脚秘密', '批注机密', '内部标题'].every((s) => de.indexOf(s) >= 0), de.slice(0, 200));
  // 空部件（文本全在属性里）不得留下空定位行
  check('预览标签-docx 无空标签行', orphanLabels(de) === 0, JSON.stringify(de));

  const xlsxZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns="x"><sheets><sheet name="内部工作表" sheetId="1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>机密数据</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row><c t="inlineStr"><is><t>普通单元格</t></is></c></row></sheetData></worksheet>' },
  ]);
  const xe = await D.DWRDoc.extractText(await xlsxZip.arrayBuffer());
  check('预览标签-xlsx 不暴露部件路径', xe.indexOf('xl/') < 0 && xe.indexOf('sharedStrings') < 0, xe.slice(0, 200));
  check('预览标签-xlsx 部位名可读', xe.indexOf('[共享文本]') >= 0 && xe.indexOf('[工作表]') >= 0, xe.slice(0, 200));
  check('预览标签-xlsx 空部件不占行', xe.split('\n').filter((l) => l === '[工作簿]').length === 0, xe.slice(0, 200));

  const pptxZip = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:t>幻灯片内部</a:t></a:p></p:sld>' },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:t>备注绝密</a:t></a:p></p:notes>' },
  ]);
  const pe = await D.DWRDoc.extractText(await pptxZip.arrayBuffer());
  check('预览标签-pptx 不暴露部件路径', pe.indexOf('ppt/') < 0 && pe.indexOf('notesSlides') < 0, pe.slice(0, 200));
  check('预览标签-pptx 部位名可读', pe.indexOf('[幻灯片]') >= 0 && pe.indexOf('[备注]') >= 0, pe.slice(0, 200));
  check('预览标签-pptx 内容照常抽取', pe.indexOf('幻灯片内部') >= 0 && pe.indexOf('备注绝密') >= 0, pe.slice(0, 200));
}

/* ================= Q. 预览与真实处理同口径（v2.78） =================
   预览的「处理后」原先按全文首 / 尾行判首尾，真实处理 processXml 按「逐部件、逐块组」判。
   页眉 / 文档属性等附属部件整部件算首尾，正文尾段也各自算尾——预览少清、漏清，用户核对不上。
   extractPreview 输出逐行 marks 后，两种 scope 下预览命中数、命中词都必须与真实处理一致。 */
{
  const qz = await D.DWRZip.pack([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: '<w:document><w:body>' +
      '<w:p><w:t>内部</w:t></w:p><w:p><w:t>正文</w:t></w:p><w:p><w:t>机密</w:t></w:p>' +
      '</w:body></w:document>' },
    { name: 'word/header1.xml', data: '<w:hdr><w:p><w:t>内部</w:t></w:p></w:hdr>' },
  ]);
  const qab = await qz.arrayBuffer();
  for (const scope of ['all', 'firstlast', 'first']) {
    const eg = D.DWRRules.createEngine({ scope,
      rules: D.DWRRules.DEFAULT_PRESETS.map((p) => ({ type: 'text', text: p.word, enabled: true })) });
    const ex = await D.DWRDoc.extractPreview(qab);
    const pv = D.DWRDoc.previewProcess(ex.text, eg, ex.marks);
    const real = await D.DWRDoc.processOffice(qab, eg);
    check('预览口径-' + scope + ' 命中数与真实处理一致', pv.hits === real.hits,
      'preview=' + pv.hits + ' real=' + real.hits);
    check('预览口径-' + scope + ' 命中词与真实处理一致',
      JSON.stringify(pv.matched) === JSON.stringify(real.matched),
      'preview=' + JSON.stringify(pv.matched) + ' real=' + JSON.stringify(real.matched));
  }
}

/* ================= R. 分支语义门禁·文件系统实测（v4.16） =================
   v4.15 发现 --name-mode 的 and/or 写反了测试也全绿——只验了函数在场，没验判定。
   这轮把同类审计做完整：扫出所有带分支的开关，逐个核对覆盖。这三个当时零覆盖，
   且都碰磁盘（vm 抽函数测不了），必须起真进程加真临时目录。 */
{
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-v416-'));
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, 'scan.mjs'), ...args], { cwd: __dirname, encoding: 'utf8' });
  const num = (o, label) => { const m = new RegExp(label + ' : (\\d+)').exec(o); return m ? +m[1] : -1; };

  // 1) --docs-only：默认主流格式已排除代码配置，必须在 --all-ext 下才看得出差别
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.txt'), '机密内容', 'utf8');
    fs.writeFileSync(path.join(root, 'b.js'), '机密代码', 'utf8');
    fs.writeFileSync(path.join(root, 'c.json'), '机密配置', 'utf8');
    const base = num(run(['--dir', root, '--all-ext', '--json', '--scope', 'all']).stdout, '命中文档数');
    const docs = num(run(['--dir', root, '--all-ext', '--docs-only', '--json', '--scope', 'all']).stdout, '命中文档数');
    check('v416---docs-only 过滤掉代码与配置', docs < base && docs === 1,
      'base=' + base + ' docs=' + docs);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 2) --no-skip-system：node_modules 里的文件应参与扫描
  {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'lib.js'), '机密', 'utf8');
    fs.writeFileSync(path.join(root, 'a.txt'), '机密内容', 'utf8');
    const skip = num(run(['--dir', root, '--all-ext', '--json', '--scope', 'all']).stdout, '命中文档数');
    const noskip = num(run(['--dir', root, '--all-ext', '--no-skip-system', '--json', '--scope', 'all']).stdout, '命中文档数');
    check('v416---no-skip-system 让 node_modules 参与扫描', noskip > skip,
      'skip=' + skip + ' noskip=' + noskip);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 3) --move-dry-run 零副作用；真实剪切建目录并移走文件
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.txt'), '机密内容', 'utf8');
    const dest = path.join(root, '_moved');
    run(['--dir', root, '--move-to', dest, '--move-dry-run', '--json', '--scope', 'all']);
    check('v416---move-dry-run 不建目标目录', !fs.existsSync(dest), '目录被建了');
    check('v416---move-dry-run 不动源文件', fs.existsSync(path.join(root, 'a.txt')), '源文件被移动');
    fs.rmSync(root, { recursive: true, force: true });
  }
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.txt'), '机密内容', 'utf8');
    const dest = path.join(root, '_moved');
    run(['--dir', root, '--move-to', dest, '--json', '--scope', 'all']);
    check('v416-真实剪切建目录并移走文件',
      fs.existsSync(dest) && !fs.existsSync(path.join(root, 'a.txt')),
      'dest=' + fs.existsSync(dest) + ' src=' + fs.existsSync(path.join(root, 'a.txt')));
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* v4.29 --limit / --max-file-mb / --exclude / --html 四个参数此前零行为覆盖。
     它们只出现在 v418 的「README 覆盖全部 CLI 参数」清单里，
     没有任何断言验行为——改坏了没人知道。 */

  // 4) --limit N：只扫前 N 个文件（README 说是快速测试用）
  {
    const root = tmp();
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(root, 'f' + i + '.txt'), '机密内容' + i, 'utf8');
    const full = num(run(['--dir', root, '--json', '--scope', 'all']).stdout, '扫描文件数');
    const lim = num(run(['--dir', root, '--limit', '3', '--json', '--scope', 'all']).stdout, '扫描文件数');
    check('v429---limit 限制扫描文件数', lim === 3 && full === 6,
      'full=' + full + ' lim=' + lim);
    check('v429---limit 在概要紧跟文件上限说明',
      /文件上限: 3/.test(run(['--dir', root, '--limit', '3', '--json', '--scope', 'all']).stdout),
      'stdout 里没有「文件上限: 3」');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 5) --exclude <目录名>：按目录名排除（大小写不敏感）
  {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'SkipMe'), { recursive: true });
    fs.writeFileSync(path.join(root, 'SkipMe', 'a.txt'), '机密内容', 'utf8');
    fs.writeFileSync(path.join(root, 'keep.txt'), '机密内容', 'utf8');
    const base = num(run(['--dir', root, '--json', '--scope', 'all']).stdout, '扫描文件数');
    const exc = num(run(['--dir', root, '--exclude', 'skipme', '--json', '--scope', 'all']).stdout, '扫描文件数');
    check('v429---exclude 按目录名排除（大小写不敏感）', exc === base - 1 && exc === 1,
      'base=' + base + ' exc=' + exc);
    // 不匹配的目录名不应排除任何东西
    const none = num(run(['--dir', root, '--exclude', 'nosuchdir', '--json', '--scope', 'all']).stdout, '扫描文件数');
    check('v429---exclude 不误伤不匹配的目录', none === base, 'base=' + base + ' none=' + none);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 6) --max-file-mb N：超过阈值的文件跳过并计数（默认 32MB）
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'small.txt'), '机密内容', 'utf8');
    // 造一个 2MB 的文件，用 --max-file-mb 1 让它被跳过
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    fs.writeFileSync(path.join(root, 'big.txt'), big);
    const skipped = num(run(['--dir', root, '--max-file-mb', '1', '--json', '--scope', 'all']).stdout, '超大已跳过 ');
    check('v429---max-file-mb 超过阈值的文件被跳过并计数', skipped === 1, 'skipped=' + skipped);
    const def = run(['--dir', root, '--json', '--scope', 'all']).stdout;
    check('v429-默认 32MB 阈值下 2MB 文件不被跳过',
      !/超大已跳过/.test(def) && num(def, '扫描文件数') === 2,
      '默认阈值下出现了跳过行，或扫描文件数不是 2');
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 7) --html [文件]：额外生成可点击 HTML 索引
  {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'a.txt'), '机密内容', 'utf8');
    const htmlOut = path.join(root, 'rep.html');
    run(['--dir', root, '--html', htmlOut, '--json', '--scope', 'all']);
    check('v429---html 指定路径生成 HTML 报告',
      fs.existsSync(htmlOut) && fs.readFileSync(htmlOut, 'utf8').indexOf('a.txt') >= 0,
      'exists=' + fs.existsSync(htmlOut));
    // 不给路径时用默认名 scan-report.html
    const root2 = tmp();
    fs.writeFileSync(path.join(root2, 'b.txt'), '机密内容', 'utf8');
    const r2 = run(['--dir', root2, '--html', '--json', '--scope', 'all']);
    check('v429---html 不给路径时用默认文件名',
      fs.existsSync(path.join(__dirname, 'scan-report.html')) || /scan-report\.html/.test(r2.stdout),
      '默认 scan-report.html 未生成');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }

  /* v4.44 CLI 层「命中占比」透传的行为验证.
     v4.5 引入 ratio 时的 7 条断言全是源码字符串检查（v45-ooxml.js 查 processText 里那行、
     v45-scan.mjs 查 return 对象里有 ratio 字段、v47-Office 扫描分支查 scan.mjs 的透传代码），
     没有一条真的跑过 CLI——改坏了 ratio 在命令行里照样显示 0% 或虚高，没人知道。
     v4.43 已在 vm 层用真实 docx 验过 scanOffice() 本身的分母口径（test-app 的 v43-Office *），
     这里补最后一环：真起 scan.mjs 进程 + 真 docx，确认 CLI 输出与 JSON 报告都带正确的占比。
     口径：5 段正文（8+8+8+8+8=40）+ word/document.xml 根元素属性 4 字符 = 44，命中 2 字符 → 4.5%。 */
  {
    const root = tmp();
    // 造真实 docx：只有第 3 段含「机密」
    const paras = ['AAAAAAAA', 'BBBBBBBB', '机密CCCCCC', 'DDDDDDDD', 'EEEEEEEE'];
    const body = paras.map((p) => '<w:p><w:r><w:t>' + p + '</w:t></w:r></w:p>').join('');
    const doc = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' + body + '</w:body></w:document>';
    const zip = await D.DWRZip.pack([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: doc }
    ]);
    fs.writeFileSync(path.join(root, 'a.docx'), Buffer.from(await zip.arrayBuffer()));
    const out = run(['--dir', root, '--json', '--scope', 'all', '--words', '机密']).stdout;
    // 1) 命中行带占比与「命中字数 / 总字数」两个数，且分母是全文（含未命中段与属性值）
    check('v444-CLI 命中行输出占比（分母为全文有效字数）',
      /命中占比: 4\.5%（2 \/ 44 字）/.test(out),
      'stdout 未含 4.5%（2 / 44 字）：' + (out.match(/命中占比[^\n]*/) || ['<无占比行>'])[0]);
    // 2) JSON 报告的 files[] 条目带 ratio / hitChars / totalChars 三个字段
    const jf = path.join(__dirname, 'scan-report.json');
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const row = (Array.isArray(j) ? j : (j.files || [])).find((x) => /\.docx$/.test(x.file || x.path || ''));
    check('v444-CLI JSON 报告带 ratio 三兄弟',
      !!row && row.hits === 1 && row.hitChars === 2 && row.totalChars === 44
        && Math.abs(row.ratio - 2 / 44) < 1e-9,
      row ? JSON.stringify({ hits: row.hits, hitChars: row.hitChars, totalChars: row.totalChars, ratio: row.ratio }) : '无 docx 条目');
    // 3) 反向口径：命中只在属性值上时分母仍含属性值（v4.43 修的漏项，CLI 侧同样要通）
    const root2 = tmp();
    const wb = '<?xml version="1.0"?><workbook xmlns="x"><sheets><sheet name="机密报表"/><sheet name="普通表"/></sheets></workbook>';
    const zip2 = await D.DWRZip.pack([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: wb }
    ]);
    fs.writeFileSync(path.join(root2, 'b.xlsx'), Buffer.from(await zip2.arrayBuffer()));
    const out2 = run(['--dir', root2, '--json', '--scope', 'all', '--words', '机密']).stdout;
    const j2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'scan-report.json'), 'utf8'));
    const row2 = (Array.isArray(j2) ? j2 : (j2.files || [])).find((x) => /\.xlsx$/.test(x.file || x.path || ''));
    check('v444-CLI 属性值命中也计入分母（修 v4.43 漏项）',
      !!row2 && row2.hits === 1 && row2.totalChars >= 8 && row2.ratio > 0 && row2.ratio < 0.5,
      row2 ? JSON.stringify({ hits: row2.hits, hitChars: row2.hitChars, totalChars: row2.totalChars, ratio: row2.ratio }) : '无 xlsx 条目');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }


  /* v4.37 --name-words 前置过滤的行为验证.
     v4.7 起 README 就承诺「不读文件就能判掉，省大量时间」，但测试只验了
     源码里有那行 if（v47 静态断言）。这里真验：放两个大文件，一个文件名匹配、
     一个不匹配——前置过滤生效时后者根本不读，耗时应接近只读一个文件的时间。
     用相对关系而非绝对耗时，避免 CI 机器快慢影响判定。 */
  {
    const root = tmp();
    // 12MB 填充：读取耗时足够显著，且不含任何命中词
    const big = Buffer.alloc(12 * 1024 * 1024, 0x61);
    fs.writeFileSync(path.join(root, 'match_big.txt'), big);
    fs.writeFileSync(path.join(root, 'skip_big.txt'), big);
    // 基线：两个都读
    const t0 = Date.now();
    const base = run(['--dir', root, '--json', '--scope', 'all']);
    const baseMs = Date.now() - t0;
    // 只匹配 match_：skip_big 应被前置跳过（不读）
    const t1 = Date.now();
    const filt = run(['--dir', root, '--name-words', 'match', '--json', '--scope', 'all']);
    const filtMs = Date.now() - t1;
    check('v438-概要紧跟「文件名未匹配」且注明未读取',
      /文件名未匹配: 1 个（未读取，直接跳过）/.test(filt.stdout),
      filt.stdout.split('\n').slice(-8).join(' | '));
    // 过滤后仍扫到 2 个文件（scanned 在过滤前累计），但只读 1 个：耗时应明显低于基线
    check('v438-前置过滤让未匹配的大文件不被读取（耗时显著下降）',
      filtMs < baseMs * 0.75,
      'baseMs=' + baseMs + ' filtMs=' + filtMs);
    // 反向对照：不过滤时不该出现这行
    check('v438-不设 name-words 时不出跳过行',
      !/文件名未匹配/.test(base.stdout),
      '');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
  /* ================= S. getBytes 契约：异算法 ZIP 一律 reject（v4.64） =================
   *   v4.63 只锁了 Zip.load 的同步 throw，getBytes 仍是同一类契约不一致：
   *   _compDataOf 对 method 非 0/8 的条目是同步 throw，而 ooxml.js 有十处
   *   zip.getBytes(x).then(...) 且没有 .catch()——其中两处还在 entries.forEach
   *   回调里同步调用，异常会直接穿透 processOffice / scanOffice。
   *   真实 Office 文件只用 deflate/store，但 zip.load 能解析任意 ZIP，
   *   用户拖入「改名成 .docx 的其它压缩算法 zip」就会撞上。 */
  {
    // ① 对不存在的条目：读接口一律 resolve(null)，写接口一律返回 false
    const z0 = await D.DWRZip.pack([{ name: 'a.txt', data: '内部资料' }]);
    const za = await D.DWRZip.load(await z0.arrayBuffer());
    const nulls = {
      getBytes: await za.getBytes('nope.txt').then((v) => v === null, (e) => 'REJECTED:' + e.message),
      getText: await za.getText('nope.txt').then((v) => v === null, (e) => 'REJECTED:' + e.message),
      setText: za.setText('nope.txt', 'x'),
      setBytes: za.setBytes('nope.txt', new Uint8Array([1])),
      has: za.has('nope.txt'),
      rename: za.rename('nope.txt', 'b.txt'),
      remove: za.remove('nope.txt'),
    };
    check('v464-不存在的条目读接口返回 null、写接口返回 false',
      nulls.getBytes === true && nulls.getText === true &&
      nulls.setText === false && nulls.setBytes === false &&
      nulls.has === false && nulls.rename === false && nulls.remove === false,
      JSON.stringify(nulls));
    check('v464-正常条目读写不受影响',
      (await za.getText('a.txt')) === '内部资料' && za.setText('a.txt', '新内容') === true &&
      (await za.getText('a.txt')) === '新内容',
      'got=' + (await za.getText('a.txt')));
    // ② 契约：method 非 0/8 的条目返回 rejected Promise，不是同步 throw
    {
      const enc = new TextEncoder();
      const nm = enc.encode('word/document.xml');
      const dat = enc.encode('<w:document><w:body><w:p><w:t>机密正文</w:t></w:p></w:body></w:document>');
      const local = new Uint8Array(30 + nm.length + dat.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(8, 99, true);   // method = 99（不支持）
      lv.setUint32(18, dat.length, true);
      lv.setUint32(22, dat.length, true);
      lv.setUint16(26, nm.length, true);
      local.set(nm, 30);
      local.set(dat, 30 + nm.length);
      const cd = new Uint8Array(46 + nm.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(10, 99, true);
      cv.setUint32(20, dat.length, true);
      cv.setUint32(24, dat.length, true);
      cv.setUint16(28, nm.length, true);
      cd.set(nm, 46);
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, 1, true);
      ev.setUint16(10, 1, true);
      ev.setUint32(12, cd.length, true);
      ev.setUint32(16, local.length, true);
      const all = new Uint8Array(local.length + cd.length + eocd.length);
      all.set(local, 0); all.set(cd, local.length); all.set(eocd, local.length + cd.length);
      const mz = await D.DWRZip.load(all.buffer.slice(0));
      let gSync = null, gP = null;
      try { gP = mz.getBytes('word/document.xml'); } catch (e) { gSync = e.message; }
      check('v464-getBytes(method=99) 返回 Promise 而非同步抛',
        gSync === null && !!gP && typeof gP.then === 'function',
        'gSync=' + gSync);
      let gRej = null;
      await mz.getBytes('word/document.xml').then(() => {}, (e) => { gRej = e.message; });
      check('v464-getBytes(method=99) 带原因 reject',
        gRej === '不支持的压缩算法（method=99）：word/document.xml', 'gRej=' + gRej);
      let tRej = null;
      await mz.getText('word/document.xml').then(() => {}, (e) => { tRej = e.message; });
      check('v464-getText(method=99) 同样 reject 而非同步抛',
        tRej === '不支持的压缩算法（method=99）：word/document.xml', 'tRej=' + tRej);
      // ③ 端到端：scanOffice 对「改名成 .docx 的异算法 ZIP」是 reject 而不是穿透
      let scSync = null, scP = null, scRej = null;
      try { scP = D.DWRDoc.scanOffice(all.buffer.slice(0), presetsEngine); } catch (e) { scSync = e.message; }
      if (scP) { try { await scP; } catch (e) { scRej = e.message; } }
      check('v464-scanOffice(method=99) reject 且带原因（不同步抛）',
        scSync === null && scRej === '不支持的压缩算法（method=99）：word/document.xml',
        'scSync=' + scSync + ' scRej=' + scRej);
    }
  }
console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
