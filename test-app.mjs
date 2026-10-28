#!/usr/bin/env node
/**
 * test-app.mjs —— 网页端主控（js/app.js）无头回归测试
 *
 * 背景：此前 app.js 完全没有自动化覆盖，导致「扫描预览」里引用了未声明的 CONC，
 * 点击即抛 ReferenceError、功能整体不可用却无人发现（引擎级测试全绿）。
 *
 * 做法：在 vm 沙箱里加载真实引擎（zip/rules/ooxml/util）+ 真实 app.js，
 * 配一套最小 DOM 桩，然后驱动真实的用户操作链路：
 *   载入默认词库 -> 添加文件 -> 扫描预览 -> 开始处理 -> 校验导出 ZIP 内容
 * 任何未声明变量、拼写错误、异步链路断点都会在这里暴露。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + ']' + (extra ? '  ' + extra : '')); }
}

/* ---------------- 最小 DOM 桩 ---------------- */

/** 本轮扫描里构造过的 <tr> 数量：整表重建的真实代价（行数 × 重建次数），用于 O(H^2) 门禁 */
let trCreated = 0;

class FakeEl {
  constructor(tag) {
    this.id = '';
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this._text = '';
    this._html = '';
    this._handlers = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.files = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.title = '';
    this.className = '';
    this.href = '';
    this.download = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v == null ? '' : String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._htmlWrites = (this._htmlWrites || 0) + 1;
    this._html = v == null ? '' : String(v);
    if (this._html === '') this.children = [];
  }
  get classList() {
    const owner = this;
    const read = () => owner.className.split(/\s+/).filter(Boolean);
    const write = (list) => { owner.className = list.join(' '); };
    return {
      add(name) { const list = read(); if (list.indexOf(name) < 0) list.push(name); write(list); },
      remove(name) { write(read().filter((x) => x !== name)); },
      contains(name) { return read().indexOf(name) >= 0; },
      toggle(name, force) {
        const has = read().indexOf(name) >= 0;
        const want = force === undefined ? !has : !!force;
        const list = read().filter((x) => x !== name);
        if (want) list.push(name);
        write(list);
        return want;
      },
    };
  }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  insertBefore(node, ref) {
    if (!ref) { this.children.push(node); return node; }
    const i = this.children.indexOf(ref);
    if (i < 0) { this.children.push(node); } else { this.children.splice(i, 0, node); }
    return node;
  }
  remove() {}
  focus() {}
  blur() {}
  setAttribute(k, v) { this[k] = v; }
  // 与 setAttribute 对称：读回属性。缺它时断言里 getAttribute 会抛 TypeError，
  // 且该异常不在 fire() 的 try/catch 内，会让整个测试进程静默退出（v4.33 踩到）。
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; }
  removeAttribute(k) { delete this[k]; }
  insertAdjacentHTML(pos, html) { this._html += html; }
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); }
  removeEventListener(type, fn) {
    if (this._handlers[type]) this._handlers[type] = this._handlers[type].filter((f) => f !== fn);
  }
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev || { target: this })); }
  click() { this.dispatch('click', { target: this }); }
  /** 元素自身 + 全部后代的文本（用于断言日志/表格内容） */
  deepText() {
    return this._text + '\n' + this.children.map((c) => (c.deepText ? c.deepText() : c.textContent || '')).join('\n');
  }
}

const els = new Map();
function el(id) {
  if (!els.has(id)) {
    const e = new FakeEl('div');
    // 真实 DOM 里元素必有父节点：driveQuickPanel 会走 row.parentNode.insertBefore
    e.parentNode = documentStub.body;
    els.set(id, e);
  }
  return els.get(id);
}

/** index.html 里声明过的 id：document.getElementById 只认这些（外加真正插入文档树的节点） */
const htmlIds = new Set();
{
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) htmlIds.add(m[1]);
}

/** index.html 里没有、但 app.js 里有 \|\| 回退（或本仓确无此节点）的 id：
 *  driveQuickPanel 由 JS 动态建；progress / reportFile / importReportBtn 是历史遗留引用 */
const LEGACY_IDS = ['progress', 'reportFile', 'importReportBtn'];

/** 在文档树里按 id 找节点（app 用 createElement + appendChild 动态建的面板必须能找到，
 *  否则每次点击都会重建，折叠 / 展开这类状态就测不出来） */
function treeById(id) {
  const stack = [documentStub.body];
  while (stack.length) {
    const n = stack.pop();
    if (n.id === id) return n;
    for (const c of n.children || []) stack.push(c);
  }
  return null;
}

/** $ 与 el 等价：早期用例写作 $("id")，保留别名避免改动大量用例 */
const $ = (id) => el(id);

// 单选组状态（模拟 checked 语义，checkedVal 才能取到值）
  const radios = { scope: 'firstlast', action: 'delete', outmode: 'zip' };
  /** 单选桩的可写 checked：setRadio 赋 el.checked=true 时同步进 radios，
   *  否则 applyPreset 之类的"先设 UI 再读回"在桩里永远读不到新值（真浏览器会生效）。 */
  function radioEl(name, value) {
    return {
      get checked() { return radios[name] === value; },
      set checked(v) { if (v) radios[name] = value; },
      name: name, value: value
    };
  }

const _htmlAttrs = {};
// <html> 桩：主题写在 documentElement 的 data-theme 上，app.js 靠 setAttribute/getAttribute 读写
const _htmlStub = {
  getAttribute: (k) => (Object.prototype.hasOwnProperty.call(_htmlAttrs, k) ? _htmlAttrs[k] : null),
  setAttribute: (k, v) => { _htmlAttrs[k] = String(v); },
};
const documentStub = {
  documentElement: _htmlStub,
  readyState: 'complete',
  body: new FakeEl('body'),
  _handlers: {},
  dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev || { target: this })); },
  // 先看真文档树（app 动态建的面板在这里），再回落到 HTML 里声明过的 id；
  // 两者都没有就返回 null —— 与真实 DOM 一致
  getElementById: (id) => treeById(id)
    || (htmlIds.has(id) || LEGACY_IDS.indexOf(id) >= 0 ? el(id) : null),
  createElement: (tag) => {
    if (String(tag).toLowerCase() === 'tr') trCreated++;
    return new FakeEl(tag);
  },
  addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
  querySelector(sel) {
    let m = /^input\[name="([^"]+)"\]:checked$/.exec(sel);
    if (m) return { value: radios[m[1]], checked: true };
    m = /^input\[name="([^"]+)"\]\[value="([^"]+)"\]$/.exec(sel);
    if (m) return radioEl(m[1], m[2]);
    return null;
  },
  querySelectorAll: () => [],
};


/** 重新执行引擎 + app.js（等价于刷新页面）：清空 DOM 桩状态与事件，隔离各测试节的模块级状态。
 *  可选 initialStorage 用于模拟刷新前已有的 localStorage。 */
function reloadApp(initialStorage) {
  for (const [id, e] of els) {
    e.children.length = 0;
    e.parentNode = null;
    e._handlers = {};
    e._text = '';
    e._html = '';
    e.value = '';
    e.checked = false;
    e.disabled = false;
    e.hidden = false;
    e.files = null;
    e.className = '';
    e.style = {};
    e.title = '';
  }
  documentStub.body.children.length = 0;
  documentStub.body._handlers = {};
  ctx.__winHandlers = {};
  ctx.__lastBlob = null;
  storage.clear();
  if (initialStorage) {
    for (const [k, v] of Object.entries(initialStorage)) storage.set(k, String(v));
  }
  radios.scope = 'firstlast';
  radios.action = 'delete';
  radios.outmode = 'zip';
  errors.length = 0;
  try { vm.runInContext(code, ctx); } catch (e) { errors.push(String(e)); }
}
const storage = new Map();
const localStorageStub = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

/* ---------------- 加载真实引擎 + 真实 app.js ---------------- */

// js/format.js / js/ui.js / js/dircache.js 必须在 app.js 之前：app.js 只保留各自的同名引用
const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js', 'js/report.js', 'js/format.js', 'js/ui.js', 'js/dircache.js', 'js/undo.js', 'js/reporthtml.js', 'js/app.js'];
const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

const errors = [];
const ctx = {
  TextEncoder, TextDecoder,
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
  Blob: globalThis.Blob, Response: globalThis.Response,
  Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise,
  setTimeout, clearTimeout, Date, isNaN, parseInt, parseFloat,
  document: documentStub,
  localStorage: localStorageStub,
  URL: {
    createObjectURL(blob) { ctx.__lastBlob = blob; return 'blob:stub'; },
    revokeObjectURL() {},
  },
  // window 级事件（拖放拦截等）：只需能注册，不实际触发
  addEventListener(type, fn) { (ctx.__winHandlers[type] = ctx.__winHandlers[type] || []).push(fn); },
  removeEventListener() {},
  __winHandlers: {},
  // 刻意不提供 Worker / showDirectoryPicker / navigator：走主线程与「仅 ZIP 导出」分支
};
ctx.window = ctx;
ctx.console = {
  log() {}, warn(...a) { errors.push('warn: ' + a.join(' ')); }, error(...a) { errors.push('error: ' + a.join(' ')); },
};
vm.createContext(ctx);

check('app-加载入口不抛错', (() => {
  try { vm.runInContext(code, ctx); return true; } catch (e) { errors.push(String(e)); return false; }
})(), errors.join(' | '));

const D = ctx.window;

/* C17) v4.55 反规避归一的字符覆盖面：GAP_CHARS_SRC 与 FULLWIDTH。
   README 承诺「匹配前自动剔除零宽字符 / 软连字符、折叠全角→半角与空格，
   『内<零宽>部』『内　部』等混淆写法同样命中」。
   GAP_CHARS_SRC 是这条承诺的全部依据，覆盖零宽 / 双向控制与隔离符 / 软连字符 / BOM /
   阿拉伯方向控制 / 韩文填充 / 各类空格 / 行段分隔符八大类。
   此前只有零宽空格（U+200B）与 NBSP 被直接断言过——有人精简掉任何一类，
   测试都还是绿的，而那一类正是攻击者可用的绕过字符。 */
{
  const RS = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
  const tail = '  global.DWRRules = {';
  const patched = RS.replace(tail,
    '  global.__nw = normalizeWithMap;\n  global.__gap = GAP_RE;\n  global.__fw = FULLWIDTH;\n' + tail);
  const c2 = {
    TextEncoder, TextDecoder,
    String: String, RegExp: RegExp, Array: Array, Object: Object, Math: Math,
    JSON: JSON, console: { log() {}, warn() {}, error() {} },
  };
  c2.window = c2;
  vm.createContext(c2);
  vm.runInContext(patched, c2);
  const nw = c2.__nw;
  const GAP = c2.__gap;
  const FW = c2.__fw;
  check('v455-归一化内部件可取到',
    typeof nw === 'function' && GAP instanceof RegExp && !!FW,
    'nw=' + typeof nw + ' gap=' + (GAP instanceof RegExp));

  // ① 八大类 GAP 字符逐类验证：插在「内」「部」之间，归一化后仍是「内部」且 gap[1] 为 true
  const cats = [
    ['零宽空格', '\u200b'], ['零宽不连字', '\u200c'], ['零宽连字', '\u200d'],
    ['LRM', '\u200e'], ['RLM', '\u200f'],
    ['LRE', '\u202a'], ['RLO', '\u202e'], ['LRI', '\u2066'], ['PDI', '\u2069'],
    ['词连接符', '\u2060'], ['软连字符', '\u00ad'], ['BOM', '\ufeff'],
    ['NBSP', '\u00a0'], ['全角空格', '\u3000'], ['en 空格', '\u2002'], ['em 空格', '\u2003'],
    ['窄空格', '\u2009'], ['行分隔符', '\u2028'], ['段分隔符', '\u2029'],
    ['制表符', '\u0009'], ['换行', '\u000a'], ['回车', '\u000d'],
    ['阿拉伯数字符', '\u0600'], ['ALM', '\u061c'], ['蒙古元音分隔', '\u180e'],
    ['韩文填充', '\u3164'], ['半角空格', ' '],
  ];
  const bad = cats.filter((x) => {
    const r = nw('内' + x[1] + '部');
    return r.norm !== '内部' || r.gap[1] !== true;
  });
  check('v455-八大类 GAP 字符全部剔除并标 gap（' + cats.length + ' 类）',
    bad.length === 0,
    bad.map((x) => x[0] + '->' + JSON.stringify(nw('内' + x[1] + '部').norm)).join(' ; '));

  // ② GAP_RE 与逐类验证口径一致（防两份实现分叉）
  const reBad = cats.filter((x) => !GAP.test(x[1]));
  check('v455-GAP_RE 与逐类验证口径一致', reBad.length === 0,
    reBad.map((x) => x[0]).join(','));

  // ③ 全角可打印 ASCII 全覆盖折叠（0x21-0x7e 共 94 个）
  const fwBad = [];
  for (let code = 0x21; code <= 0x7e; code++) {
    const fw = String.fromCharCode(code + 0xfee0);
    if (FW[fw] !== String.fromCharCode(code)) fwBad.push('U+' + fw.charCodeAt(0).toString(16));
  }

  /* v4.57 SURFACES 改为从 css/style.css 真实读取。
     旧列表是 ["#ffffff", "#f4f6fb", "#fafbfe", "#f1f5f9"]——后三个是虚构色，
     项目实际用的背景是 --bg/--surface/--surface-2/--line-soft。
     在虚构底色上验 AA，等于门禁测了一批不存在的场景：改坏了真实底色上的对比度，
     测试一片绿。这里按变量名抓真实值，抓不到就 FAIL（不许静默退回虚构色）。 */
  const SURFACES = (() => {
    const CSS = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
    const grab = (n) => {
      const m = new RegExp('--' + n + ':\\s*(#[0-9a-fA-F]{6})').exec(CSS);
      return m ? m[1].toLowerCase() : null;
    };
    const got = ['bg', 'surface', 'surface-2', 'line-soft'].map(grab);
    return got.every(Boolean) ? got : ['#ffffff'];
  })();
  check('ct-SURFACES 取自真实 CSS 背景变量（非虚构色）',
    SURFACES.length === 4 && SURFACES.every((s) => /^#[0-9a-f]{6}$/.test(s))
      && SURFACES.indexOf('#f4f6fb') < 0,
    JSON.stringify(SURFACES));

/* ---- 6.24e 对比度回归：灰阶正文、按钮与徽章不得低于 WCAG AA ----
   背景：真机像素审计（Playwright 元素截图 + 按计算色分类像素）发现浅色主题 5 处不达标——
   --faint（#9ca3af，白底 2.5:1）用于页脚/空态副标题/预览截断提示、--muted（#6b7280）在
   页面径向渐变底上 4.47:1、chip 编辑/删除按钮同色、主按钮渐变末端白字 3.8:1、
   header 徽章半透明白底 3.3:1；深色主题 --faint 与步骤圆数字同样偏低。
   小字号可读性是真实易用性缺陷，故补静态回归看护。*/
{
  const CSS = fs.readFileSync(path.join(__dirname, "css", "style.css"), "utf8");
  const BS = String.fromCharCode(92);

  function lumOf(hex) {
    const n = hex.replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
    const f = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }
  function ratio(a, b) {
    const la = lumOf(a), lb = lumOf(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // 按行首匹配选择器：indexOf(sel) 会先命中子串（.badge { 命中 .chip .badge {）
  function blockOf(sel) {
    const ls = CSS.split(String.fromCharCode(10));
    const at = ls.findIndex((l) => {
      const t = l.trim();
      return t === sel || t === sel + "," || t.indexOf(sel + ":") === 0;
    });
    if (at < 0) return null;
    const out = [];
    for (let n = at; n < ls.length; n++) {
      out.push(ls[n]);
      if (ls[n].trim() === "}") break;
    }
    return out.join(String.fromCharCode(10));
  }
  function propIn(sel, prop, varPat) {
    const blk = blockOf(sel);
    if (!blk) return null;
    const inner = varPat
      ? "var" + BS + "s*" + BS + "(" + BS + "s*(--[" + BS + "w-]+)" + BS + "s*" + BS + ")"
      : "(#[0-9a-fA-F]{6})";
    const re = new RegExp("(?:^|;|" + BS + "s)" + prop + BS + "s*:" + BS + "s*" + inner);
    const m = re.exec(blk);
    return m ? m[1].toLowerCase() : null;
  }

  const AA = 4.5;

  const faint = propIn(":root {", "--faint");
  check("ct-浅色 --faint 定义存在", !!faint, "faint=" + faint);
  const faintWorst = faint ? Math.min.apply(null, SURFACES.map((s) => ratio(faint, s))) : 0;
  check("ct-浅色 --faint 在白/浅底上过 AA", faintWorst >= AA,
    "faint=" + faint + " worst=" + faintWorst.toFixed(2));

  const footColor = propIn(".app-foot {", "color", true);
  check("ct-页脚用专用前景色变量", !!footColor && footColor.indexOf("--faint-foot") >= 0,
    "color=" + footColor);
  const footVar = propIn(":root {", "--faint-foot");
  check("ct-页脚前景在渐变底上过 AA", !!footVar && ratio(footVar, "#eaecef") >= AA,
    "footVar=" + footVar + " ratio=" + (footVar ? ratio(footVar, "#eaecef").toFixed(2) : "n/a"));

  const xColor = propIn(".chip .x {", "color", true);
  const editColor = propIn(".chip .edit {", "color", true);
  check("ct-chip 编辑/删除按钮前景加深",
    !!xColor && !!editColor && xColor.indexOf("--text-2") >= 0 && editColor.indexOf("--text-2") >= 0,
    "x=" + xColor + " edit=" + editColor);

  const primBtn = blockOf("button.primary {");
  check("ct-主按钮用独立渐变末端变量",
    !!primBtn && primBtn.indexOf("--brand-btn-2") >= 0 && primBtn.indexOf("var(--brand-btn-2)") >= 0,
    primBtn ? primBtn.slice(0, 120) : "no block");
  const btnVar = propIn(":root {", "--brand-btn-2");
  check("ct-主按钮渐变末端白字过 AA", !!btnVar && ratio("#ffffff", btnVar) >= AA,
    "btnVar=" + btnVar + " ratio=" + (btnVar ? ratio("#ffffff", btnVar).toFixed(2) : "n/a"));

  const badge = blockOf(".badge {");
  const rgbaDark = new RegExp("rgba" + BS + "(0," + BS + "s*0," + BS + "s*0");
  check("ct-header 徽章用深色半透明底", !!badge && rgbaDark.test(badge),
    badge ? badge.slice(0, 170) : "no block");

  const DQ = String.fromCharCode(34);
  const DARK = "html[data-theme=" + DQ + "dark" + DQ + "] {";
  const darkFaint = propIn(DARK, "--faint");
  const darkFoot = propIn(DARK, "--faint-foot");

  /* v4.58 深色对比度基准改为从 CSS 真实读取。
     旧基准写死 #0e1320，而深色主题真实底色是 --bg #0f0f12 / --surface #1c1c1e /
     --surface-2 #2c2c2e。--surface 比 --bg 亮，对比度更低（--faint 在 #0e1320 上 6.46、
     在 #1c1c1e 上只有 5.93）——旧门禁既偏松，又完全没测最严格的那个底色。 */
  const darkVars = (() => {
    const dAt = CSS.indexOf('html[data-theme="dark"] {');
    if (dAt < 0) return null;
    const seg = CSS.slice(dAt, dAt + 900);
    const g = (n) => { const x = new RegExp('--' + n + ':\\s*(#[0-9a-fA-F]{6})').exec(seg); return x ? x[1].toLowerCase() : null; };
    const got = { bg: g('bg'), surface: g('surface'), surface2: g('surface-2') };
    return got.bg && got.surface && got.surface2 ? got : null;
  })();
  check('ct-深色底色变量可取到', !!darkVars,
    darkVars ? JSON.stringify(darkVars) : '未找到深色 --bg/--surface/--surface-2');
  if (darkVars) {
    const darkWorst = (fg) => Math.min.apply(null,
      [darkVars.bg, darkVars.surface, darkVars.surface2].map((b) => ratio(fg, b)));
    const oldRef = (fg) => ratio(fg, '#0e1320');
    check('ct-深色 --faint 在三个真实底色上都过 AA',
      !!darkFaint && darkWorst(darkFaint) >= AA,
      'darkFaint=' + darkFaint + ' worst=' + (darkFaint ? darkWorst(darkFaint).toFixed(2) : 'n/a')
        + ' 旧基准给 ' + (darkFaint ? oldRef(darkFaint).toFixed(2) : 'n/a'));
    check('ct-深色 --faint-foot 在三个真实底色上都过 AA',
      !!darkFoot && darkWorst(darkFoot) >= AA,
      'darkFoot=' + darkFoot + ' worst=' + (darkFoot ? darkWorst(darkFoot).toFixed(2) : 'n/a')
        + ' 旧基准给 ' + (darkFoot ? oldRef(darkFoot).toFixed(2) : 'n/a'));
  }
}

  // v4.59 覆盖率计数：README 承诺「index.html 的 137 处 + app.js 动态 11 处」。
  //   既有断言只查「控件无遗漏」，不锁总数——新增控件忘了加说明、
  //   或批量删错时测试仍是绿的，而 README 的数字会静默过期（v4.59 修正前它写的是 100 处）。
  //   计数用字面量，不读现算的值（否则改坏时期待值跟着变，断言自证——v4.56 的教训）。
  //   注意：本区块在文件前部执行，此时 tip 区块的 HTML / APP 常量还没定义，必须自己读文件。
  {
    const HTML2 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const APP2 = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    const CSS2 = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
    const README2 = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
    const htmlTips = (HTML2.match(/data-tip=/g) || []).length;
    const appTips = (APP2.match(/data-tip=/g) || []).length;
  check('v477-index.html 悬停说明数锁死为 147（README 同数）',
      htmlTips === 147, 'htmlTips=' + htmlTips + ' README 写 147');
  const htmlIds = Array.from(HTML2.matchAll(/\sid="([^"]+)"/g), (m) => m[1]);
  const duplicateIds = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
  check('v477-index.html 的 id 全局唯一',
    duplicateIds.length === 0, '重复 id: ' + Array.from(new Set(duplicateIds)).join(', '));
    check('v459-app.js 动态悬停说明数锁死为 11',
      appTips === 11, 'appTips=' + appTips + ' README 写 11');
    // README 里的数字必须与代码一致：改一边不改另一边就会误导用户
    check('v459-README 的说明数与代码一致',
      README2.indexOf('index.html` 的 147 处解释') >= 0
        && README2.indexOf('动态生成的 11 处') >= 0,
      'README 与代码不同步');
    check('v476-单栏窄屏优先显示文件区',
      /@media \(max-width: 1080px\) \{[\s\S]*?\.layout > section\.panel-column \{\s*order: 1;/.test(CSS2)
        && /\.layout > \.panel-column \{\s*order: 2;/.test(CSS2),
      '文件区未优先于配置区');
  // v4.60 文档数字门禁：README 承诺的「CHANGELOG 166 条版本记录」「词库 39 词」
  //   都是写死的数字，产品和文档各自演进就会静默过期（v4.59 修正前悬停说明数写 100、
  //   实际 132；本轮修正前 CHANGELOG 写 80 条、实际 166）。
  //   这里把两边绑在一起：README 的数字必须与真实计数一致。
  {
    const RD = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
    const CL = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    const RJ = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
    // ① CHANGELOG 版本条目数
    const clCount = (CL.match(/^## v/gm) || []).length;
    const rdCl = /CHANGELOG\.md（(\d+) 条版本记录/.exec(RD);
    check('v460-README 的 CHANGELOG 条数与真实一致',
      !!rdCl && +rdCl[1] === clCount,
      'README=' + (rdCl ? rdCl[1] : 'MISSING') + ' 实际=' + clCount);
    // ② 默认词库词条数
    const ps = RJ.indexOf('DEFAULT_PRESETS');
    const bs = RJ.indexOf('[', ps);
    let dd = 0, be = -1;
    for (let i = bs; i < RJ.length; i++) {
      if (RJ[i] === '[') dd++;
      else if (RJ[i] === ']') { dd--; if (dd === 0) { be = i; break; } }
    }
    const wc = be > bs ? (RJ.slice(bs, be).match(/word:/g) || []).length : -1;
    const rdWc = /词库扩到 (\d+) 词/.exec(RD);
    check('v460-README 的词库词数与真实一致',
      !!rdWc && +rdWc[1] === wc,
      'README=' + (rdWc ? rdWc[1] : 'MISSING') + ' 实际=' + wc);
    // ③ 测试套数：README 数字必须与目录一致（e2e 需单独起服务器，不计入）
    const listed = fs.readdirSync(__dirname).filter((f) => /^test-.*\.mjs$/.test(f) && f !== 'test-e2e.mjs');
    check('v460-README 的测试套数与目录一致',
      listed.length > 0 && RD.indexOf('一次跑完全部 ' + listed.length + ' 套') >= 0,
      '实际 ' + listed.length + ' 套: ' + listed.join(','));
  }
  }

  // v4.61 undo.js 的 localStorage 写失败降级：隐私模式 / 配额超限时 setItem 抛错，
  //   write() 的 try/catch 会静默返回 false。此时撤销按钮必须隐藏（而不是假死），
  //   用户看到「没有撤销入口」而非「点了没反应」。这条链路零覆盖——
  //   v4.33 只验了正常路径（record/latest/dropLatest/5 批上限/FIFO）。
  {
    // 用会抛 QuotaExceededError 的 localStorage 造一个独立 vm（不动全局 localStorage）
    const c2 = {
      localStorage: {
        getItem: () => null,
        setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
        removeItem: () => {},
      },
      Date: Date, isNaN: isNaN, JSON: JSON, console: { log() {}, warn() {}, error() {} },
    };
    c2.window = c2;
    vm.createContext(c2);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'undo.js'), 'utf8'), c2);
    const FU = c2.DWRUndo;
    // ① 写失败不抛错（隐私模式下崩掉比丢撤销更糟）
    let threw = null;
    try { FU.record([{ path: 'a.txt', size: 10 }]); } catch (e) { threw = e.message; }
    check('v461-undo localStorage 写失败时不抛错', threw === null, 'threw=' + threw);
    // ② 写失败后栈是空的：latest() 为 null，调用方据此隐藏按钮
    check('v461-undo 写失败后 latest 为 null（按钮可据此隐藏）',
      FU.latest() === null && FU.count() === 0,
      'latest=' + JSON.stringify(FU.latest()) + ' count=' + FU.count());
    // ③ dropLatest 也不抛错，返回 null
    let dThrew = null, dVal = 'unset';
    try { dVal = FU.dropLatest(); } catch (e) { dThrew = e.message; }
    check('v461-undo 写失败时 dropLatest 安全返回 null',
      dThrew === null && dVal === null, 'threw=' + dThrew + ' val=' + JSON.stringify(dVal));
    // ④ fmtTime 不依赖 localStorage，仍然可用
    check('v461-undo 写失败时 fmtTime 仍可用',
      FU.fmtTime(new Date(2026, 0, 5, 9, 7).getTime()) === '2026-01-05 09:07'
        && FU.fmtTime(NaN) === '',
      JSON.stringify(FU.fmtTime(NaN)));
    // ⑤ read() 对损坏的 JSON 也要安全返回 []（localStorage 可能被外部改写）
    const c3 = {
      localStorage: { getItem: () => '{oops', setItem: () => {}, removeItem: () => {} },
      Date: Date, isNaN: isNaN, JSON: JSON, console: { log() {}, warn() {}, error() {} },
    };
    c3.window = c3;
    vm.createContext(c3);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'undo.js'), 'utf8'), c3);
    check('v461-undo 损坏的 JSON 安全返回空栈',
      c3.DWRUndo.latest() === null && c3.DWRUndo.count() === 0,
      'latest=' + JSON.stringify(c3.DWRUndo.latest()));
    // ⑥ 非数组 JSON 也要安全（早期版本可能存过对象）
    const c4 = {
      localStorage: { getItem: () => '{"a":1}', setItem: () => {}, removeItem: () => {} },
      Date: Date, isNaN: isNaN, JSON: JSON, console: { log() {}, warn() {}, error() {} },
    };
    c4.window = c4;
    vm.createContext(c4);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js', 'undo.js'), 'utf8'), c4);
    check('v461-undo 非数组 JSON 安全返回空栈',
      c4.DWRUndo.latest() === null && c4.DWRUndo.count() === 0,
      'latest=' + JSON.stringify(c4.DWRUndo.latest()));
  }
  // v4.62 dircache.js 的 IndexedDB 降级路径：目录记忆「坏了」时不能拖垮扫描。
  //   用户流程（首弹 / 复用 / 清除 / 重新授权）6.38 已覆盖，但模块自身的异常路径零覆盖——
  //   IndexedDB 不存在 / open 抛错 / onerror / onblocked / 事务抛错 / get 请求 onerror。
  //   任一场景没降级都会让「扫描文件夹」按钮点死（Promise 永不 settle）。
  {
    const DCSRC = fs.readFileSync(path.join(__dirname, 'js', 'dircache.js'), 'utf8');
    const mk = (idb) => {
      const c2 = { indexedDB: idb, console: { log() {}, warn() {}, error() {} },
        setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise };
      c2.window = c2;
      vm.createContext(c2);
      vm.runInContext(DCSRC, c2);
      return c2.DWRDirCache;
    };
    // 统一的「开库成功」桩：事务里只实现读路径（写路径由调用方按场景覆盖）
    const openOk = (result) => ({
      open() {
        const r = { result: result, onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
        return r;
      },
    });
    // 触发某个 open 事件的桩
    const openEvt = (evt) => ({
      open() {
        const r = { onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => { if (r[evt]) r[evt](); }, 0);
        return r;
      },
    });
    // ① 完全没有 indexedDB：四个 API 全部降级，不抛错
    {
      const M = mk(undefined);
      let threw = null;
      const out = {};
      try {
        out.get = await M.get('k');
        out.put = await M.put('k', { x: 1 });
        out.del = await M.del('k');
        out.clear = await M.clear();
      } catch (e) { threw = e.message; }
      check('v462-dircache 无 indexedDB 时四 API 全部降级不抛错',
        threw === null && out.get === null && out.put === false && out.del === false && out.clear === false,
        'threw=' + threw + ' ' + JSON.stringify(out));
      check('v462-dircache put(null) 直接返回 false',
        (await mk(undefined).put('k', null)) === false, 'not false');
    }
    // ② open 同步抛错
    {
      const M = mk({ open() { throw new Error('boom'); } });
      let threw = null;
      let g = 'unset', p = 'unset';
      try { g = await M.get('k'); p = await M.put('k', { x: 1 }); } catch (e) { threw = e.message; }
      check('v462-dircache open 抛错时降级不崩',
        threw === null && g === null && p === false,
        'threw=' + threw + ' get=' + JSON.stringify(g) + ' put=' + JSON.stringify(p));
    }
    // ③ onerror / onblocked 两种开库失败事件
    for (const evt of ['onerror', 'onblocked']) {
      const M = mk(openEvt(evt));
      let threw = null;
      let g = 'unset', p = 'unset';
      try { g = await M.get('k'); p = await M.put('k', { x: 1 }); } catch (e) { threw = e.message; }
      check('v462-dircache ' + evt + ' 时降级不崩',
        threw === null && g === null && p === false,
        'threw=' + threw + ' get=' + JSON.stringify(g) + ' put=' + JSON.stringify(p));
    }
    // ④ onsuccess 回调里事务抛错（fn 的 try/catch 要兜住）
    {
      const M = mk(openOk({
        createObjectStore() {},
        transaction() { throw new Error('tx boom'); },
      }));
      let threw = null;
      let g = 'unset', p = 'unset';
      try { g = await M.get('k'); p = await M.put('k', { x: 1 }); } catch (e) { threw = e.message; }
      check('v462-dircache 事务抛错时降级不崩',
        threw === null && g === null && p === false,
        'threw=' + threw + ' get=' + JSON.stringify(g) + ' put=' + JSON.stringify(p));
    }
    // ⑤ get 请求自身 onerror
    {
      const M = mk(openOk({
        createObjectStore() {},
        transaction() {
          return {
            oncomplete: null, onerror: null, onabort: null,
            objectStore() {
              return {
                put() { return {}; }, delete() { return {}; }, clear() { return {}; },
                get() {
                  const q = { onsuccess: null, onerror: null };
                  setTimeout(() => { if (q.onerror) q.onerror(); }, 0);
                  return q;
                },
              };
            },
          };
        },
      }));
      let threw = null, g = 'unset';
      try { g = await M.get('k'); } catch (e) { threw = e.message; }
      check('v462-dircache get 请求 onerror 时返回 null',
        threw === null && g === null, 'threw=' + threw + ' get=' + JSON.stringify(g));
    }
    // ⑤b get 的 onerror 必须**立即** resolve，不能等 4 秒兜底——
    //     兜底虽然也能返回 null，但每次目录记忆失效都要让用户等 4 秒。
    //     这条断言用耗时区分两种实现（有 onerror 兜底 vs 只有超时兜底）。
    {
      const M = mk(openOk({
        createObjectStore() {},
        transaction() {
          return {
            oncomplete: null, onerror: null, onabort: null,
            objectStore() {
              return {
                put() { return {}; }, delete() { return {}; }, clear() { return {}; },
                get() {
                  const q = { onsuccess: null, onerror: null };
                  setTimeout(() => { if (q.onerror) q.onerror(); }, 0);
                  return q;
                },
              };
            },
          };
        },
      }));
      const t0 = Date.now();
      const g = await M.get('k');
      const ms = Date.now() - t0;
      check('v462-dircache get onerror 立即返回（不等 4 秒兜底）',
        g === null && ms < 1000,
        'get=' + JSON.stringify(g) + ' ms=' + ms);
    }
    // ⑥ 正常路径仍然可用（降级不能把好用的情况也降了）
    {
      const store = new Map();
      const M = mk(openOk({
        createObjectStore() {},
        transaction() {
          const tx = {
            oncomplete: null, onerror: null, onabort: null,
            objectStore() {
              return {
                get(k) { const q = { onsuccess: null, onerror: null }; setTimeout(() => { if (q.onsuccess) q.onsuccess(); }, 0); q.result = store.has(k) ? store.get(k) : undefined; return q; },
                put(v, k) { store.set(k, v); return {}; },
                delete(k) { store.delete(k); return {}; },
                clear() { store.clear(); return {}; },
              };
            },
          };
          setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
          return tx;
        },
      }));
      const putOk = await M.put('k', { name: 'mem-root' });
      const got = await M.get('k');
      const delOk = await M.del('k');
      const afterDel = await M.get('k');
      const clearOk = await M.clear();
      check('v462-dircache 正常路径 put/get/del/clear 仍可用',
        putOk === true && !!got && got.name === 'mem-root' && delOk === true
          && afterDel === null && clearOk === true,
        JSON.stringify({ putOk: putOk, got: got, delOk: delOk, afterDel: afterDel, clearOk: clearOk }));
    }
  }
  check('v455-全角折叠表覆盖 0x21-0x7e 全部 94 个字符', fwBad.length === 0,
    fwBad.slice(0, 8).join(','));

  // ④ 全角折叠不计入 gap（折叠是等价变换，不是「插入了东西」）
  {
    const r = nw('内Ａ部');
    check('v455-全角折叠不计入 gap',
      r.norm === '内A部' && r.gap[1] === false && r.gap[2] === false,
      JSON.stringify({ norm: r.norm, gap: r.gap }));
  }

    // ⑤ 混合规避：连续多个 GAP 字符只在其后第一个真实字符前标一次 gap（pending 累加）
  {
    const r = nw('内\u200b\u00a0Ａ部');
    check('v455-混合规避字符（零宽 + 空格 + 全角）',
      r.norm === '内A部' && r.gap[1] === true && r.gap[2] === false && r.gap[3] === false,
      JSON.stringify({ norm: r.norm, gap: r.gap }));
  }

  // ⑥ map 长度与单调性：回删坐标必须可靠
  {
    const r = nw('内\u200b部Ａ');
    const mono = r.map.every((v, i) => i === 0 || v >= r.map[i - 1]);
    check('v455-map 长度为 norm+1 且单调不减',
      r.map.length === r.norm.length + 1 && r.gap.length === r.norm.length + 1 && mono,
      JSON.stringify({ norm: r.norm, map: r.map, gap: r.gap }));
  }

  // ⑦ 非 GAP 字符不得被误剔（中文 / 普通标点 / 数字）
  {
    const r = nw('内部·机密2024');
    check('v455-非 GAP 字符不被误剔',
      r.norm === '内部·机密2024' && r.gap.every((g) => g === false),
      JSON.stringify({ norm: r.norm, gap: r.gap }));
  }

  // ⑧ 端到端：每一类字符插入后都能真正清掉敏感词
  {
    const eng = D.DWRRules.createEngine({
      rules: [{ text: '内部', type: 'text', enabled: true }],
      scope: 'all', action: 'delete', custom: ''
    });
    const e2eBad = cats.filter((x) => {
      const out = eng.apply('这是内' + x[1] + '部资料', true, true);
      return out.hits !== 1 || out.text.indexOf('内部') >= 0;
    });
    check('v455-端到端：逐类字符插入后敏感词都被清除', e2eBad.length === 0,
      e2eBad.map((x) => x[0]).join(','));
  }
}

const logText = () => el('log').children.map((c) => c.textContent).join('\n');
// 事件处理器里抛出的异常记为错误（fire 的 try/catch 抓到的是 app.js 的 handler 异常，
// 那属于「被测代码在异步路径里坏了」，继续跑完其余章节再统一复查更有价值）。
const handlerErrors = [];
/**
 * 顶层未捕获异常：记录之后必须让本套件以非零码停下。
 * 只 push 不中断的做法有个隐藏代价——同步抛出的异常会解开模块顶层的调用栈，
 * 其后所有断言连同末尾的 process.exit 都到不了，进程按 0 退出、绿灯、没有任何提示。
 * v4.69 实测：scanSummary 的 vm 抽取从 v4.65 起就一直抛 fmtRatio is not defined，
 * 于是第 3410 行往后约 1000 行门禁（含「全程无运行时错误」这条本身）从来没执行过，
 * npm test 里 test-app 这一段因此不可能变红。
 */
function abortOn(err, kind) {
  const msg = kind + ': ' + (err && err.message ? err.message : err);
  handlerErrors.push(msg);
  console.log('FAIL [全局-未捕获异常中止，后续断言未执行] ' + msg);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
process.on('unhandledRejection', (e) => abortOn(e, 'unhandledRejection'));
process.on('uncaughtException', (e) => abortOn(e, 'uncaughtException'));
function fire(target, type, ev) {
  try {
    target.dispatch(type, ev || { target });
  } catch (e) {
    handlerErrors.push(type + ' handler threw: ' + (e && e.message ? e.message : e));
  }
}
const click = (id) => fire(el(id), 'click');
const change = (id, ev) => fire(el(id), 'change', ev || { target: el(id) });

// 自检：章节里抛出同步异常时，本套件必须非零退出并说明后续断言没跑。
// 子进程按同样的顶层流程跑到这里就抛，父进程核对退出码与提示行——
// 这条门禁自身就在被截断的那 1000 行之后过不行，所以必须放在尽可能靠前的位置。
if (process.env.DWR_HARNESS_PROBE === 'top-level-throw') {
  throw new Error('harness probe: 模拟章节里的同步异常');
}
{
  const r = spawnSync(process.execPath, [process.argv[1]], {
    cwd: __dirname, encoding: 'utf8',
    env: Object.assign({}, process.env, { DWR_HARNESS_PROBE: 'top-level-throw' }),
  });
  check('v469-顶层异常会让 test-app 非零退出（防静默截断）',
    r.status === 1 && /FAIL \[全局-未捕获异常中止/.test(r.stdout || ''),
    'status=' + r.status + ' stdout尾=' + String(r.stdout || '').split('\n').slice(-2, -1).join(''));
}

async function waitFor(fn, timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > timeout) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* ---------------- 1) 初始化：默认词库已载入 ---------------- */
check('app-初始化日志正常', /应用已就绪/.test(logText()), logText().slice(0, 200));
check('app-默认词库已载入', /已载入默认敏感词库/.test(logText()), logText().slice(0, 200));

/* ---------------- 2) 添加文件（文本 + Word） ---------------- */
/* v4.75 旧设置迁移：统一密级分组，并去掉默认密级词的「商业」排除 */
{
  const key = 'dwr.settings.v2';
  const legacy = {
    rules: [
      { text: '涉密', type: 'text', enabled: true, group: '涉密字样' },
      { text: '内部', type: 'text', enabled: true, group: '涉密字样' },
      { text: '秘密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] },
      { text: '机密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] },
      { text: '绝密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] },
      { text: '秘密', type: 'text', enabled: true, group: '自定义', notBefore: ['商业'] },
      { text: '自定义词', type: 'text', enabled: true, group: '自定义' }
    ],
    options: {}
  };
  reloadApp({ [key]: JSON.stringify(legacy) });
  const migrated = JSON.parse(storage.get(key));
  const words = migrated.rules.map((r) => r.text);
  check('v474-旧设置迁移后不再含默认「涉密」', words.indexOf('涉密') < 0, JSON.stringify(words));
  check('v474-旧设置迁移后四个密级词同组',
    ['内部', '秘密', '机密', '绝密'].every((w) =>
      migrated.rules.some((r) => r.text === w && r.group === '密级标识')),
    JSON.stringify(migrated.rules));
  check('v474-旧设置迁移保留自定义规则',
    migrated.rules.some((r) => r.text === '自定义词' && r.group === '自定义'),
    JSON.stringify(migrated.rules));
  check('v475-默认密级词不再排除商业',
    migrated.rules.filter((r) => ['秘密', '机密', '绝密'].includes(r.text) && r.group === '密级标识')
      .every((r) => !r.notBefore || r.notBefore.indexOf('商业') < 0),
    JSON.stringify(migrated.rules));
  check('v475-自定义词条的商业排除保持不变',
    migrated.rules.some((r) => r.text === '秘密' && r.group === '自定义'
      && r.notBefore && r.notBefore.indexOf('商业') >= 0),
    JSON.stringify(migrated.rules));
  check('v475-迁移后写入设置版本', migrated.settingsVersion === 3, JSON.stringify(migrated));

  migrated.rules.push({ text: '涉密', type: 'text', enabled: true, group: '自定义' });
  reloadApp({ [key]: JSON.stringify(migrated) });
  const afterUserReadd = JSON.parse(storage.get(key)).rules;
  check('v474-迁移完成后用户重新添加「涉密」会保留',
    afterUserReadd.some((r) => r.text === '涉密' && r.group === '自定义'),
    JSON.stringify(afterUserReadd));
  reloadApp();
}

check('v476-空列表禁用开始处理', el('runBtn').disabled === true,
  'disabled=' + el('runBtn').disabled);
check('v476-空列表三步条停在添加',
  el('flowAdd').className.indexOf('is-current') >= 0
    && el('flowScan').className.indexOf('is-current') < 0
    && el('flowRun').className.indexOf('is-current') < 0,
  [el('flowAdd').className, el('flowScan').className, el('flowRun').className].join(' | '));
check('v477-空列表进入 empty 阶段并显示操作摘要',
  el('fileWorkspace').getAttribute('data-task-stage') === 'empty'
    && /词/.test(el('summaryRules').textContent)
    && /首行/.test(el('summaryProcess').textContent)
    && /ZIP/.test(el('summaryOutput').textContent),
  [el('fileWorkspace').getAttribute('data-task-stage'), el('summaryRules').textContent,
    el('summaryProcess').textContent, el('summaryOutput').textContent].join(' | '));

/* v4.78 左栏低频设置默认收起，摘要仍说明当前方案。 */
{
  const HTML_SETTINGS = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const CSS_SETTINGS = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
  const APP_SETTINGS = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  check('v478-词库与处理方式默认收起',
    /<details[^>]*id="rulesCard"[^>]*>/.test(HTML_SETTINGS)
      && /<details[^>]*id="processCard"[^>]*>/.test(HTML_SETTINGS)
      && !/<details[^>]*id="(?:rulesCard|processCard)"[^>]*\bopen\b/.test(HTML_SETTINGS),
    '设置卡未使用默认收起的 details');
  check('v478-收起后仍显示当前词数与处理摘要',
    /38 个词/.test(el('rulesSummaryBadge').textContent)
      && /删除/.test(el('processSummaryBadge').textContent),
    [el('rulesSummaryBadge').textContent, el('processSummaryBadge').textContent].join(' | '));

  check('v478-摘要随场景设置实时更新',
    /function updateSettingsSummaries\(\)/.test(APP_SETTINGS)
      && /setText\('processSummaryBadge', scopeText \+ ' · ' \+ actionText\)/.test(APP_SETTINGS)
      && /function syncTaskUi\(\) \{\s*var stage[\s\S]*?updateSettingsSummaries\(\);/.test(APP_SETTINGS),
    '处理方式摘要没有接到同步入口');

  check('v478-调整按钮会展开设置卡',
    /\[.rulesCard., .processCard.\].forEach[\s\S]*?settings\.open = true/.test(APP_SETTINGS),
    'editTaskBtn 未展开设置卡');
  check('v478-可折叠设置卡有焦点与悬停样式',
    /\.settings-card > summary:hover/.test(CSS_SETTINGS)
      && /\.settings-card > summary:focus-visible/.test(CSS_SETTINGS),
    '设置摘要缺少悬停或键盘焦点态');
}

function fakeFile(relPath, bytes) {
  return {
    name: relPath.split('/').pop(),
    size: bytes.length,
    _relPath: relPath,
    webkitRelativePath: '',
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
  };
}

// 用真实引擎构造 docx 样本
const docxBlob = await D.DWRZip.pack([
  { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内部资料正文</w:t></w:p></w:body></w:document>' },
]);
const docxBytes = new Uint8Array(await docxBlob.arrayBuffer());
const txtBytes = new TextEncoder().encode('内部资料首行\n正文内容\n机密尾行\n');
const cleanBytes = new TextEncoder().encode('普通文档内容\n不含任何目标字样\n');

/** 用独立引擎实例解析导出的 ZIP（避免复用被测上下文的状态） */
async function loadZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const vcode = ['js/zip.js', 'js/rules.js', 'js/ooxml.js']
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const v = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console,
  };
  v.window = v;
  vm.createContext(v);
  vm.runInContext(vcode, v);
  return v.window.DWRZip.load(buf.buffer.slice(0));
}

el('concurrency').value = '4';
// 对齐 index.html 的初始控件状态（无 localStorage 时 loadSettings 不会覆盖它们）
el('onlyChanged').checked = true;
el('backup').checked = true;
el('tidySpace').checked = false;
el('scanSkipSys').checked = true;
change('fileInput', {
  target: {
    files: [
      fakeFile('docs/sample.txt', txtBytes),
      fakeFile('docs/sample.docx', docxBytes),
      fakeFile('docs/clean.txt', cleanBytes), // 不含敏感词：用于验证 onlyChanged 开关
    ],
    value: '',
  },
});

check('app-文件已加入列表', /共 <b>3<\/b> 个文件/.test(el('fileSummary').innerHTML), el('fileSummary').innerHTML);
check('app-渲染出 3 行', el('fileBody').children.length === 3, 'rows=' + el('fileBody').children.length);
check('v476-加入后启用开始处理并推进到扫描',
  el('runBtn').disabled === false
    && el('flowAdd').className.indexOf('is-done') >= 0
    && el('flowScan').className.indexOf('is-current') >= 0,
  'disabled=' + el('runBtn').disabled + ' steps=' +
    [el('flowAdd').className, el('flowScan').className, el('flowRun').className].join(' | '));
check('v477-加入文件后进入 loaded 阶段',
  el('fileWorkspace').getAttribute('data-task-stage') === 'loaded'
    && /将处理 3 个文件/.test(el('summaryTitle').textContent),
  el('fileWorkspace').getAttribute('data-task-stage') + ' / ' + el('summaryTitle').textContent);

/* ---------------- 3) 扫描预览（历史崩溃点） ---------------- */
click('scanBtn');
const scanDone = await waitFor(() => /扫描完成/.test(logText()));
check('app-扫描预览可完成（无 CONC 未定义崩溃）', scanDone, logText().slice(-400));
check('v476-扫描后推进到处理步骤',
  el('flowScan').className.indexOf('is-done') >= 0
    && el('flowRun').className.indexOf('is-current') >= 0,
  [el('flowAdd').className, el('flowScan').className, el('flowRun').className].join(' | '));
check('v477-检查后进入 scanned 阶段并汇总命中文件',
  el('fileWorkspace').getAttribute('data-task-stage') === 'scanned'
    && /发现 2 个文件有敏感词/.test(el('summaryTitle').textContent),
  el('fileWorkspace').getAttribute('data-task-stage') + ' / ' + el('summaryTitle').textContent);
check('app-扫描未产生运行时错误', errors.length + handlerErrors.length === 0, errors.concat(handlerErrors).join(' | '));

const rowHtml = () => el('fileBody').children.map((t) => t.innerHTML || '');
check('app-命中的 2 个文件被标记', rowHtml().filter((h) => /命中 \d+/.test(h)).length === 2,
  rowHtml().join(' || ').slice(0, 400));
check('app-未命中的文件标记为无敏感词', rowHtml().some((h) => /无敏感词/.test(h)),
  rowHtml().join(' || ').slice(0, 400));
check('app-日志出现扫描耗时统计', /耗时 \d+(\.\d+)? 秒/.test(logText()), logText().slice(-300));

/* ---------------- 4) 默认设置（仅输出被修改的文件） ---------------- */
ctx.__lastBlob = null;
click('runBtn');
const runDone = await waitFor(() => /处理完成/.test(logText()), 60000);
check('app-处理流程可完成', runDone, logText().slice(-400));
check('app-处理未产生运行时错误', errors.length + handlerErrors.length === 0, errors.concat(handlerErrors).join(' | '));
check('app-已触发 ZIP 下载', !!ctx.__lastBlob, 'blob=' + String(ctx.__lastBlob));
check('v477-处理完成后进入 done 阶段并显示处理结果',
  el('fileWorkspace').getAttribute('data-task-stage') === 'done'
    && /本次处理已完成/.test(el('summaryTitle').textContent)
    && /修改 2 个文件/.test(el('summaryMeta').textContent),
  el('fileWorkspace').getAttribute('data-task-stage') + ' / ' + el('summaryTitle').textContent
    + ' / ' + el('summaryMeta').textContent);

if (ctx.__lastBlob) {
  const zip = await loadZip(ctx.__lastBlob);
  const names = zip.names();
  check('app-默认只导出被修改的 2 个文件', names.length === 2 && names.indexOf('docs/clean.txt') === -1,
    JSON.stringify(names));
  const outTxt = await zip.getText('docs/sample.txt');
  check('app-导出文本已脱敏',
    !!outTxt && outTxt.indexOf('内部') === -1 && outTxt.indexOf('机密') === -1 && outTxt.indexOf('正文内容') >= 0,
    JSON.stringify(outTxt));
  const inner = await loadZip(new Blob([await zip.getBytes('docs/sample.docx')]));
  const innerXml = inner ? await inner.getText('word/document.xml') : null;
  check('app-导出 docx 已脱敏', !!innerXml && innerXml.indexOf('内部') === -1, 'xml=' + innerXml);
}

/* ---------------- 5) 取消「仅输出被修改的文件」：未命中文件也应原样输出 ---------------- */
el('onlyChanged').checked = false;
ctx.__lastBlob = null;
const runsBefore = (logText().match(/处理完成/g) || []).length;
click('runBtn');
const runDone2 = await waitFor(() => (logText().match(/处理完成/g) || []).length > runsBefore, 60000);
check('app-二次处理可完成', runDone2, logText().slice(-400));

if (ctx.__lastBlob) {
  const zip2 = await loadZip(ctx.__lastBlob);
  const names2 = zip2.names();
  check('app-取消勾选后导出全部 3 个文件', names2.length === 3, JSON.stringify(names2));
  const cleanOut = await zip2.getText('docs/clean.txt');
  check('app-未命中文件按原样输出', cleanOut === '普通文档内容\n不含任何目标字样\n', JSON.stringify(cleanOut));
} else {
  check('app-取消勾选后导出全部 3 个文件', false, '未捕获到 ZIP');
}

/* ---------------- 6) UI 便捷能力回归：批量加词 / 规则编辑 / 过滤 / 仅处理命中 ---------------- */
{
  const savedRules = () => JSON.parse(storage.get('dwr.settings.v2')).rules;

  // 6.1 批量粘贴：逗号 / 换行 / 分号混合输入，自动去重
  el('ruleInput').value = '泄密, 测试词\n新增词; 泄密';
  click('addRuleBtn');
  const texts = savedRules().map((r) => r.text);
  check('ui-批量粘贴加词', texts.indexOf('泄密') >= 0 && texts.indexOf('测试词') >= 0 && texts.indexOf('新增词') >= 0, JSON.stringify(texts));
  check('ui-批量粘贴自动去重', texts.filter((t) => t === '泄密').length === 1, JSON.stringify(texts));
  check('ui-批量加词日志汇总', /已添加 3 条敏感词（跳过重复 1 条）/.test(logText()), logText().slice(-300));

  // 6.2 规则编辑：点 chip 上的 ✎ 回填 → 修改 → 保存（原地更新，不新增条目）
  const chip = el('ruleChips').children.find((c) => c.deepText().indexOf('测试词') >= 0);
  check('ui-规则 chip 渲染', !!chip, el('ruleChips').deepText().slice(0, 200));
  if (chip) {
    const acts = chip.children[chip.children.length - 1];
    const editBtn = acts.children[0];
    chip.dispatch('click', { target: editBtn });
  }
  check('ui-进入规则编辑态', el('addRuleBtn').textContent === '保存修改', el('addRuleBtn').textContent);
  el('ruleInput').value = '演练词';
  el('ruleWhole').checked = true;
  click('addRuleBtn');
  const after = savedRules();
  check('ui-编辑规则原地更新', after.some((r) => r.text === '演练词' && r.whole === true) && !after.some((r) => r.text === '测试词'), JSON.stringify(after.map((r) => r.text)));
  check('ui-编辑后回到添加态', el('addRuleBtn').textContent === '添加', el('addRuleBtn').textContent);

  // 6.3 行内移除单个文件
  const rows0 = el('fileBody').children;
  const rowsBefore = rows0.length;
  const del = rows0[0].children[rows0[0].children.length - 1].children[0];
  del.dispatch('click', { target: del, stopPropagation() {} });
  check('ui-行内移除文件', el('fileBody').children.length === rowsBefore - 1, 'before=' + rowsBefore + ' after=' + el('fileBody').children.length);

  // 6.4 路径过滤与状态过滤
  el('fileFilterQ').value = 'sample';
  fire(el('fileFilterQ'), 'input');
  check('ui-路径过滤生效', el('fileBody').children.length === 1, 'rows=' + el('fileBody').children.length);
  el('fileFilterQ').value = '';
  fire(el('fileFilterQ'), 'input');
  el('fileFilterStatus').value = 'clean';
  change('fileFilterStatus');
  check('ui-状态过滤生效', el('fileBody').children.length === 1, 'rows=' + el('fileBody').children.length);
  el('fileFilterStatus').value = 'all';
  change('fileFilterStatus');

  // 6.5 点击行 → 预览处理后文本 + 命中词徽章
  const firstRow = el('fileBody').children[0];
  firstRow.dispatch('click', { target: firstRow });
  const previewOk = await waitFor(() => el('previewNew').textContent.indexOf('正文') >= 0, 10000);
  check('ui-预览加载处理后文本', previewOk, el('previewNew').textContent.slice(0, 80));
  check('ui-预览展示命中词徽章', el('previewHits').children.length >= 1, 'kw=' + el('previewHits').children.length);
  check('ui-预览后复制按钮可用', el('copyResultBtn').disabled === false, 'disabled=' + el('copyResultBtn').disabled);

  // 6.6 「仅处理命中」：只处理扫描命中的文件，并输出处理概要
  el('onlyHit').checked = true;
  ctx.__lastBlob = null;
  const runsBefore2 = (logText().match(/处理完成/g) || []).length;
  click('runBtn');
  const runDone3 = await waitFor(() => (logText().match(/处理完成/g) || []).length > runsBefore2, 60000);
  check('ui-仅处理命中可运行', runDone3, logText().slice(-300));
  check('ui-处理概要日志', /处理概要：\d+ 个文件/.test(logText()), logText().slice(-300));
  el('onlyHit').checked = false;

  // 6.7 清空日志
  click('clearLogBtn');
  check('ui-清空日志', el('log').children.length === 1 && /日志已清空/.test(logText()), logText().slice(0, 100));
  // 6.8 多选 + 批量删除
  const rowCheck = (n) => el('fileBody').children[n].children[0].children[0];
  check('ui-多选框已渲染', el('fileBody').children.length === 2 && !!rowCheck(0) && rowCheck(0).type === 'checkbox', 'rows=' + el('fileBody').children.length);

  rowCheck(0).checked = true; rowCheck(0).dispatch('click', { target: rowCheck(0), stopPropagation() {} });
  rowCheck(1).checked = true; rowCheck(1).dispatch('click', { target: rowCheck(1), stopPropagation() {} });
  check('ui-勾选后选择条显示', el('selBar').style.display === 'flex', 'display=' + el('selBar').style.display);
  check('ui-已选计数正确', el('selCount').textContent === '已选 2 个文件', el('selCount').textContent);
  check('ui-删除按钮可用', el('delSelBtn').disabled === false, 'disabled=' + el('delSelBtn').disabled);

  click('selInvertBtn');
  check('ui-反选生效', el('selCount').textContent === '已选 0 个文件', el('selCount').textContent);

  el('fileSelAll').checked = true; click('fileSelAll');
  check('ui-表头全选生效', el('selCount').textContent === '已选 2 个文件', el('selCount').textContent);

  click('delSelBtn');
  check('ui-批量删除生效', el('fileBody').children.length === 0, 'rows=' + el('fileBody').children.length);
  check('ui-删除后选择条隐藏', el('selBar').style.display === 'none', 'display=' + el('selBar').style.display);
  check('ui-批量删除有日志', /已移除 2 个选中文件/.test(logText()), logText().slice(-200));
  check('ui-空列表表头禁用', el('fileSelAll').disabled === true, 'disabled=' + el('fileSelAll').disabled);

  // 6.9 Shift 范围选择 + 键盘快捷键
  change('fileInput', {
    target: {
      files: [
        fakeFile('docs/r1.txt', new TextEncoder().encode('范围一 首行\n正文\n')),
        fakeFile('docs/r2.txt', new TextEncoder().encode('范围二 首行\n正文\n')),
        fakeFile('docs/r3.txt', new TextEncoder().encode('范围三 首行\n正文\n')),
      ],
      value: '',
    },
  });
  const back = await waitFor(() => el('fileBody').children.length === 3, 10000);
  check('ui-重新加回 3 个文件', back, 'rows=' + el('fileBody').children.length);

  const rc = (n) => el('fileBody').children[n].children[0].children[0];
  const stop = { stopPropagation() {} };

  // 先点第一行作为锚点
  rc(0).checked = true; rc(0).dispatch('click', { target: rc(0), stop });
  check('ui-Shift 前先单选锚点', el('selCount').textContent === '已选 1 个文件', el('selCount').textContent);
  // Shift 点第三行 -> 选中 1..3 整段
  rc(2).checked = true; rc(2).dispatch('click', { target: rc(2), shiftKey: true, stop });
  check('ui-Shift 范围选择生效', el('selCount').textContent === '已选 3 个文件', el('selCount').textContent);
  // 再次 Shift 点第一行（取消态）-> 取消 1..3 整段
  rc(0).checked = false; rc(0).dispatch('click', { target: rc(0), shiftKey: true, stop });
  check('ui-Shift 反向取消生效', el('selCount').textContent === '已选 0 个文件', el('selCount').textContent);

  // 键盘快捷键
  const kd = (o) => documentStub.dispatch('keydown', Object.assign({ preventDefault() {}, stopPropagation() {} }, o));
  kd({ key: 'a', ctrlKey: true, target: { tagName: 'BODY' } });
  check('ui-Ctrl+A 全选生效', el('selCount').textContent === '已选 3 个文件', el('selCount').textContent);
  kd({ key: 'Delete', target: { tagName: 'BODY' } });
  check('ui-Delete 删除选中', el('fileBody').children.length === 0 && /已移除 3 个选中文件/.test(logText()), 'rows=' + el('fileBody').children.length);
  // 输入框内不劫持 Ctrl+A / Delete
  el('fileFilterQ').value = 'x';
  change('fileInput', {
    target: {
      files: [fakeFile('docs/keep.txt', new TextEncoder().encode('保留 首行\n正文\n'))],
      value: '',
    },
  });
  await waitFor(() => el('fileBody').children.length === 1, 10000);
  kd({ key: 'a', ctrlKey: true, target: { tagName: 'INPUT' } });
  check('ui-输入框内不劫持 Ctrl+A', el('fileBody').children.length === 1, 'rows=' + el('fileBody').children.length);
}

const selCount = () => {
  const m = /（(\d+)）/.exec(el('addScanToFiles').textContent || '');
  return m ? parseInt(m[1], 10) : -1;
};
const scanRowCheck = (n) => el('scanBody').children[n].children[0].children[0];

  // 6.10 扫描结果表多选：Shift 连选 + 表头全选 + 删除选中
  ctx.showDirectoryPicker = async () => {
    const list = [
      fakeFile('scan/a.txt', new TextEncoder().encode('内部资料 首行\n正文\n机密 尾行\n')),
      fakeFile('scan/b.txt', new TextEncoder().encode('秘密 首行\n正文\n普通 尾行\n')),
      fakeFile('scan/c.txt', new TextEncoder().encode('普通内容 首行\n正文\n结束 尾行\n')),
    ].map((f) => [f.name, { kind: 'file', getFile: async () => f }]);
    let i = 0;
    return {
      kind: 'directory', name: 'scan',
      entries: () => ({ next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true, value: undefined }) }),
    };
  };
  click('scanFolderBtn');
  const scanOk = await waitFor(() => /文件夹扫描完成/.test(logText()), 30000);
  check('scan-文件夹扫描可完成', scanOk, logText().slice(-300));
  check('scan-仅命中的 2 个文件入表', el('scanBody').children.length === 2, 'rows=' + el('scanBody').children.length);
  check('scan-默认全部选中', selCount() === 2, 'count=' + selCount());
  check('scan-表头全选框为勾选态', el('scanSelAllBox').checked === true, 'checked=' + el('scanSelAllBox').checked);

  // 取消第一行 -> 表头进入半选
  scanRowCheck(0).checked = false; scanRowCheck(0).dispatch('click', { target: scanRowCheck(0), stopPropagation() {} });
  check('scan-单选取消生效', selCount() === 1, 'count=' + selCount());
  check('scan-表头半选态', el('scanSelAllBox').indeterminate === true, 'indeterminate=' + el('scanSelAllBox').indeterminate);

  // Shift 点第二行 -> 0..1 整段选中
  scanRowCheck(1).checked = true; scanRowCheck(1).dispatch('click', { target: scanRowCheck(1), shiftKey: true, stopPropagation() {} });
  check('scan-Shift 范围选生效', selCount() === 2, 'count=' + selCount());
  // 再次 Shift 点第一行（取消态）-> 整段取消
  scanRowCheck(0).checked = false; scanRowCheck(0).dispatch('click', { target: scanRowCheck(0), shiftKey: true, stopPropagation() {} });
  check('scan-Shift 反向取消生效', selCount() === 0, 'count=' + selCount());
  check('scan-取消后加入按钮禁用', el('addScanToFiles').disabled === true, 'disabled=' + el('addScanToFiles').disabled);

  // 表头全选框：勾选 / 取消
  el('scanSelAllBox').checked = true; click('scanSelAllBox');
  check('scan-表头全选生效', selCount() === 2, 'count=' + selCount());
  el('scanSelAllBox').checked = false; click('scanSelAllBox');
  check('scan-表头取消全选生效', selCount() === 0, 'count=' + selCount());

  // 反选 -> 全选中；再删除选中 -> 扫描结果清空
  click('scanSelInvert');
  check('scan-反选生效', selCount() === 2, 'count=' + selCount());
  click('scanDelSelBtn');
  check("scan-删除选中后回到空态", /td-empty/.test(el("scanBody").innerHTML)
    && /tn-title/.test(el("scanBody").innerHTML), el("scanBody").innerHTML.slice(0, 80));
  check('scan-删除选中日志', /已从扫描结果中移除 2 项/.test(logText()), logText().slice(-200));
  check('scan-空态下表头禁用', el('scanSelAllBox').disabled === true, 'disabled=' + el('scanSelAllBox').disabled);
  check('scan-空态下删除按钮禁用', el('scanDelSelBtn').disabled === true, 'disabled=' + el('scanDelSelBtn').disabled);


/* ---------------- 6.11a 扫描结果行直达预览 ---------------- */
{
  // 重新扫描拿到两行命中
  const done0 = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  const rescanOk = await waitFor(
    () => (logText().match(/文件夹扫描完成/g) || []).length > done0 && el("scanBody").children.length === 2,
    30000);
  check("scan-重新扫描回填结果", rescanOk, "rows=" + el("scanBody").children.length);

  const row = () => el("scanBody").children[0];
  row().dispatch("click", { target: row() });
  const previewOk = await waitFor(
    () => el("previewNew").textContent.length > 0 && el("previewName").textContent.length > 0,
    15000);
  check("scan-点行直达预览", previewOk,
    "new=" + el("previewNew").textContent.slice(0, 50));
  check("scan-预览行高亮", row().className.indexOf("selected") >= 0, "cls=" + row().className);
  check("scan-预览命中徽章", el("previewHits").children.length > 0,
    "badges=" + el("previewHits").children.length);
  check("scan-预览处理后移除命中词",
    el("previewNew").textContent.indexOf("内部") < 0 && el("previewNew").textContent.length > 0,
    JSON.stringify(el("previewNew").textContent.slice(0, 40)));

  // 再点文件列表行：预览来源切回，扫描表高亮复位
  const bodyRows = el("fileBody").children;
  const lastRow = bodyRows[bodyRows.length - 1];
  lastRow.dispatch("click", { target: lastRow });
  const backOk = await waitFor(
    () => el("previewName").textContent.length > 0
      && el("previewName").textContent === (el("fileBody").children[el("fileBody").children.length - 1].title || el("previewName").textContent),
    15000);
  check("scan-切回文件列表预览", backOk,
    "name=" + el("previewName").textContent);
  const stillSel = el("scanBody").children.some((r) => r.className.indexOf("selected") >= 0);
  check("scan-切回后扫描行不高亮", !stillSel, "仍有行高亮");
}

/* ---------------- 6.11b 扫描报告导出 ---------------- */
{
  const done1 = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(
    () => (logText().match(/文件夹扫描完成/g) || []).length > done1 && el("scanBody").children.length === 2,
    30000);
  check("scan-重新扫描完成", el("scanBody").children.length === 2,
    "rows=" + el("scanBody").children.length);
  check("scan-扫描后报告按钮启用",
    el("scanReportBtn").disabled === false && el("scanReportJsonBtn").disabled === false,
    "csv=" + el("scanReportBtn").disabled + " json=" + el("scanReportJsonBtn").disabled);

  ctx.__lastBlob = null;
  click("scanReportBtn");
  const b = ctx.__lastBlob;
  const bytes = b ? new Uint8Array(await b.arrayBuffer()) : null;
  const csv = bytes ? new TextDecoder().decode(bytes) : "";
  check("scan-扫描报告 CSV 带 BOM",
    !!bytes && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    bytes ? "first3=" + bytes.slice(0, 3).join(",") : "null");
  const cl = csv.split("\r\n");
  check("scan-扫描报告表头", cl.some((l) => l.indexOf("path,") === 0),
    JSON.stringify(cl.slice(0, 3)));
  check("scan-扫描报告含汇总元信息", cl.some((l) => l.indexOf("#") === 0),
    JSON.stringify(cl.slice(0, 4)));
  check("scan-扫描报告含命中明细", cl.length > 4, "lines=" + cl.length);

  ctx.__lastBlob = null;
  click("scanReportJsonBtn");
  const jb = ctx.__lastBlob;
  const jt = jb ? JSON.parse(await jb.text()) : null;
  check("scan-扫描报告 JSON 结构", !!jt && Array.isArray(jt.files),
    JSON.stringify(jt && Object.keys(jt)));
  check("scan-扫描报告 JSON 明细含命中词",
    !!jt && jt.files.some((f) => typeof f.matched === "string" && f.matched.length > 0),
    JSON.stringify(jt && jt.files && jt.files[0]));

  // 删除后报告同步：全选后删除，扫描记录清空
  const done2b = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(
    () => (logText().match(/文件夹扫描完成/g) || []).length > done2b && el("scanBody").children.length === 2,
    30000);
  // 先取消全选，确保下一句的「全选」是真的全选（反选的方向取决于当前状态）
  click("scanSelAllBox");
  click("scanSelAllBox");
  check("scan-删除前已全选", el("addScanToFiles").disabled === false,
    "nothing selected");
  click("scanDelSelBtn");
  await waitFor(() => el("scanBody").innerHTML.indexOf("td-empty") >= 0, 10000);
  check("scan-删除后报告同步", true, "");
  check("scan-清空后报告按钮禁用",
    el("scanReportBtn").disabled === true && el("scanReportJsonBtn").disabled === true,
    "csv=" + el("scanReportBtn").disabled);

}






  /* ---------------- 6.11d v4.66 扫描行右键复制文件路径 ----------------
     结果表右键菜单的「复制文件路径」：路径列虽有 data-tip
     显示完整路径，但要拿到手里只能手动选中复制。合规用户要把路径贴进
     工单 / 邮件时是高频痛点。本块锁右键菜单 + Ctrl+C 两个出口。 */
  {
    const doneC = (logText().match(/文件夹扫描完成/g) || []).length;
    click("scanFolderBtn");
    await waitFor(
      () => (logText().match(/文件夹扫描完成/g) || []).length > doneC && el("scanBody").children.length === 2,
      30000);
    const rowC = el("scanBody").children[0];
    let pathCopied = null;
    // 桩掉 clipboard.writeText：右键后应把行对应的完整路径写进剪贴板
    // vm 沙箱里 app.js 读到的 navigator 是 ctx 的属性，不是 Node 的 global——桩必须挂 ctx
    ctx.navigator = ctx.navigator || {};
    ctx.navigator.clipboard = ctx.navigator.clipboard || {};
    ctx.navigator.clipboard.writeText = (t) => { pathCopied = t; return Promise.resolve(); };
    rowC.dispatch("contextmenu", { target: rowC, preventDefault() {}, stopPropagation() {} });
    await waitFor(() => pathCopied !== null, 5000);
    check("v466-右键复制的内容就是该行的文件路径",
      typeof pathCopied === "string" && pathCopied.length > 0
        && /\.(txt|md|csv|docx|xlsx|pptx)$/i.test(pathCopied),
      "copied=" + JSON.stringify(pathCopied));
    check("v466-复制后日志确认",
      /已复制文件路径/.test(logText()),
      logText().slice(-120));
    // 还原桩
    delete ctx.navigator.clipboard.writeText;
    // 行点击预览不被右键弄坏（contextmenu 与 click 是两个事件，互不干扰）
    rowC.dispatch("click", { target: rowC });
    const previewOk2 = await waitFor(
      () => el("previewNew").textContent.length > 0 && el("previewName").textContent.length > 0,
      15000);
    check("v466-右键后行点击预览仍正常", previewOk2,
      "name=" + el("previewName").textContent.slice(0, 40));
  }


  /* ---------------- 6.11e v4.68 扫描实时状态条 + 彩色合计行 ----------------
     扫描中的实时状态条与底部计数条：扫描中一条横幅
     显示进度与停止按钮，结束后彩色合计行可点筛选。本块锁静态接线与点击行为。 */
  {
    const HV468 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const APP468 = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
    const CSS468 = fs.readFileSync(path.join(__dirname, "css", "style.css"), "utf8");
    check("v468-状态条与合计行都在 index.html 且带悬停说明",
      /<div class="scan-live" id="scanLiveBar" hidden>/.test(HV468)
        && /id="scanLiveText"[^>]*data-tip=/.test(HV468)
        && /id="scanTally"[^>]*data-tip=/.test(HV468),
      "live/tally 节点缺失");
    check("v468-三个新函数与点击筛选都在 app.js",
      APP468.indexOf("function updateScanLive") >= 0
        && APP468.indexOf("function endScanLive") >= 0
        && APP468.indexOf("function renderScanTally") >= 0
        && APP468.indexOf("closest('b[data-st]')") >= 0,
      "函数或点击接线缺失");
    check("v468-CSS 有状态条 / 合计行样式与减弱动效",
      CSS468.indexOf(".scan-live {") >= 0
        && CSS468.indexOf(".scan-tally {") >= 0
        && /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.scan-live \.live-dot \{ animation: none; \}/.test(CSS468),
      "样式或 reduced-motion 缺失");
    // 行为：扫描完成后合计行出现，点击「命中」数字只留命中行，再点回全部
    const doneT = (logText().match(/文件夹扫描完成/g) || []).length;
    click("scanFolderBtn");
    await waitFor(
      () => (logText().match(/文件夹扫描完成/g) || []).length > doneT && el("scanBody").children.length === 2,
      30000);
    check("v468-扫描完成后台计行有内容",
      /本次结果/.test(el("scanTally")._html || "") && /data-st="hit"/.test(el("scanTally")._html || ""),
      "tally=" + (el("scanTally")._html || "").slice(0, 80));
    const before = el("scanBody").children.length;
    el("scanTally").dispatch("click", { target: { getAttribute: () => "hit" } });
    await waitFor(() => el("scanFilterStatus").value === "hit", 5000);
    check("v468-点合计数字后状态下拉同步",
      el("scanFilterStatus").value === "hit",
      "select=" + el("scanFilterStatus").value);
    el("scanTally").dispatch("click", { target: { getAttribute: () => "hit" } });
    await waitFor(() => el("scanFilterStatus").value === "all", 5000);
    check("v468-再点一次回到全部",
      el("scanFilterStatus").value === "all" && el("scanBody").children.length === before,
      "select=" + el("scanFilterStatus").value + " rows=" + el("scanBody").children.length);
  }

  /* ---------------- 6.11c v4.65 网页端命中占比（ratio）端到端 ----------------
     v4.5 只在命令行落了 ratio，网页端 scanOneFile 把它算出来后直接丢掉，
     扫描结果表、CSV / JSON / HTML 三种导出全都没有这一列——
     而 README 的功能表写着「扫描结果与报告自动带」。本块锁整条链。 */
  {
    const doneR = (logText().match(/文件夹扫描完成/g) || []).length;
    click("scanFolderBtn");
    await waitFor(
      () => (logText().match(/文件夹扫描完成/g) || []).length > doneR && el("scanBody").children.length === 2,
      30000);
    const rows = el("scanBody").children;
    check("v465-扫描行带占比数据（非空且为数字）",
      rows.length === 2 && rows.every((tr) => {
        const o = (tr._html || tr.innerHTML || "");
        const m = /\d+(\.\d+)?%/.exec(o);
        return !!m && m[0].length > 1;
      }),
      "rows=" + rows.length + " html=" + (rows[0] ? (rows[0]._html || rows[0].innerHTML || "").slice(0, 120) : "none"));
    // CSV 导出：表头带 ratio 列、明细行有百分比
    ctx.__lastBlob = null;
    click("scanReportBtn");
    const csvB = ctx.__lastBlob;
    const csvTxt = csvB ? new TextDecoder().decode(new Uint8Array(await csvB.arrayBuffer())) : "";
    const csvLines = csvTxt.split("\r\n");
    check("v465-CSV 表头含 ratio 列",
      csvLines.some((ln) => ln.indexOf("path,kind,size,hits,matched,ratio") === 0),
      JSON.stringify(csvLines.filter((x) => x && x[0] !== "#").slice(0, 2)));
    check("v465-CSV 明细行带百分比",
      csvLines.some((ln) => ln[0] !== "#" && /\d+(\.\d+)?%/.test(ln)),
      JSON.stringify(csvLines.slice(0, 16)));
    check("v465-CSV 概要含平均命中占比",
      csvLines.some((ln) => ln.indexOf("#平均命中占比,") === 0),
      JSON.stringify(csvLines.slice(0, 18)));
    // JSON 导出：files 条目带 ratio 字段
    ctx.__lastBlob = null;
    click("scanReportJsonBtn");
    const jsonB = ctx.__lastBlob;
    let jt = null;
    try { jt = JSON.parse(await jsonB.text()); } catch (e) { jt = null; }
    check("v465-JSON 明细含 ratio 与平均占比",
      !!jt && Array.isArray(jt.files) && jt.files.length > 0
        && jt.files.every((f) => /\d+(\.\d+)?%/.test(String(f.ratio)))
        && !!jt.meta["平均命中占比"],
      JSON.stringify(jt && { first: jt.files && jt.files[0], meta: Object.keys(jt.meta) }));
    // HTML 导出：明细表带占比列
    ctx.__lastBlob = null;
    click("scanReportHtmlBtn");
    await waitFor(() => !!ctx.__lastBlob, 10000);
    const htmlB = ctx.__lastBlob;
    const htmlTxt = htmlB ? await new Response(htmlB).text() : "";
    check("v465-HTML 报告带命中占比列与概要行",
      htmlTxt.indexOf("命中占比") >= 0 && /平均命中占比/.test(htmlTxt)
        && /\d+(\.\d+)?%/.test(htmlTxt),
      "len=" + htmlTxt.length + " hasCol=" + (htmlTxt.indexOf("命中占比") >= 0));
    // 空态 colspan 对齐：表头 7 列，空态占满 7
    const HTML465 = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const APP465 = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
    // 只数扫描结果表自己的表头（#scanBody 之前的那一段），文件列表的表头不算进来
    const scanTablePart = HTML465.slice(0, HTML465.indexOf('scanBody'));
    const nHead = (scanTablePart.match(/<th /g) || []).length;
    const colspanM = /colspan \|\| (\d+)/.exec(APP465);
    check("v465-空态 colspan 与表头列数一致",
      colspanM && +colspanM[1] >= nHead,
      "colspan=" + (colspanM ? colspanM[1] : "?") + " heads=" + nHead);
    // 表头带悬停说明（与其它表头同规格）
    check("v465-占比表头带悬停说明",
      /<th[^>]*data-tip="[^"]*命中字数占全文有效字数[^"]*"/.test(HTML465),
      "占比表头缺 data-tip");
  }

  // v3.8.1 回归：真点「导出 HTML」走完整数据路径。
  // v3.6 起的真 bug——scanReportRows() 已把 matched join 成字符串（给 CSV 用），
  // HTML 版再对它 .join 抛 "(v || []).join is not a function"。
  // 静态断言与自造 rows 都测不到，只有真点按钮才会炸。
  {
    const doneN = (logText().match(/文件夹扫描完成/g) || []).length;
    click('scanFolderBtn');
    await waitFor(
      () => (logText().match(/文件夹扫描完成/g) || []).length > doneN && el('scanBody').children.length >= 1,
      30000);
    check('v38-回归-扫描后有命中行', el('scanBody').children.length >= 1,
      'rows=' + el('scanBody').children.length);
    check('v38-回归-HTML 报告按钮可用', el('scanReportHtmlBtn').disabled === false,
      'disabled=' + el('scanReportHtmlBtn').disabled);
    ctx.__lastBlob = null;
    click('scanReportHtmlBtn');
    await waitFor(() => !!ctx.__lastBlob, 10000);
    check('v38-回归-导出 HTML 扫描报告不崩',
      !!ctx.__lastBlob,
      'blob=' + !!ctx.__lastBlob);
    if (ctx.__lastBlob) {
      const html = await new Response(ctx.__lastBlob).text();
      check('v38-回归-命中词以数组渲染（未被 join 成字符串）',
        html.indexOf('、') >= 0,
        'len=' + html.length);
      check('v38-回归-含结论块、徽章与局限',
        html.indexOf('class="concl"') >= 0 && html.indexOf('lv-obs') >= 0
          && html.indexOf('ul class="limits"') >= 0,
        '结论/徽章/局限缺失');
    }
  }

/* ---------------- 6.11f v4.70 扫描表节流重建 ----------------
   每个命中文件都整表重建一次时，H 个命中就是 1+2+…+H 次行构造；大目录几万命中
   会把主线程拖死（表格越长大、重绘越慢，扫描越跑越慢）。本块用 24 个命中文件把
   「重建次数 / 行构造次数与命中数解耦」钉住，同时要求 24 行最终都在表里。 */
{
  const bytes470 = new TextEncoder().encode('机密 首行\n正文\n');
  const files470 = [];
  for (let i = 0; i < 24; i++) files470.push(fakeFile('big/f' + i + '.txt', bytes470));
  ctx.showDirectoryPicker = async () => {
    const list = files470.map((f) => [f.name, { kind: 'file', getFile: async () => f }]);
    let i = 0;
    return {
      kind: 'directory', name: 'big',
      entries: () => ({ next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true, value: undefined }) }),
    };
  };
  el('scanBody')._htmlWrites = 0;
  trCreated = 0;
  const done470 = (logText().match(/文件夹扫描完成/g) || []).length;
  const t470 = Date.now();
  click('scanFolderBtn');
  const ok470 = await waitFor(() =>
    (logText().match(/文件夹扫描完成/g) || []).length > done470
    && el('scanBody').children.length === 24, 30000);
  check('v470-24 个命中文件全部入表', ok470, 'rows=' + el('scanBody').children.length);
  const rebuilds = el('scanBody')._htmlWrites;
  check('v470-扫描中不逐命中整表重建', rebuilds <= 8,
    'rebuilds=' + rebuilds + ' hits=24');
  check('v470-行构造次数不随命中数平方增长', trCreated < 24 * 8,
    'trCreated=' + trCreated + ' 平方级上界=' + (24 * 25 / 2)
    + ' 扫描耗时ms=' + (Date.now() - t470));
}

/* ---------------- 6.11g v4.70 文件表同样节流（同一根因的另一个入口） ----------------
   「扫描预览」和「开始处理」也是逐文件重绘整张文件表：N 个文件就是 1+2+…+N 行构造。
   节流后批处理末尾必须把最终状态落表（flush），所以这里同时锁「重建次数被压住」
   和「24 行都带上命中状态」。 */
{
  reloadApp();
  await waitFor(() => el('ruleChips').children.length >= 3, 15000);
  const bytes471 = new TextEncoder().encode('机密 首行\n正文\n');
  const files471 = [];
  for (let i = 0; i < 24; i++) files471.push(fakeFile('prev/g' + i + '.txt', bytes471));
  change('fileInput', { target: { files: files471, value: '' } });
  const added471 = await waitFor(() => el('fileBody').children.length === 24, 20000);
  check('v470-预览门禁-24 个文件已加入', added471, 'rows=' + el('fileBody').children.length);
  el('fileBody')._htmlWrites = 0;
  trCreated = 0;
  const done471 = (logText().match(/扫描完成/g) || []).length;
  click('scanBtn');
  const ok471 = await waitFor(() => (logText().match(/扫描完成/g) || []).length > done471, 30000);
  const hitRows471 = el('fileBody').children.filter((t) => /命中 \d+/.test(t.innerHTML || '')).length;
  check('v470-预览扫描后 24 行都带命中状态', ok471 && hitRows471 === 24,
    'done=' + ok471 + ' hitRows=' + hitRows471 + ' log=' + logText().slice(-160));
  const rebuilds471 = el('fileBody')._htmlWrites;
  check('v470-预览扫描不逐文件整表重建', rebuilds471 <= 8,
    'rebuilds=' + rebuilds471 + ' files=24');
  check('v470-预览行构造次数不随文件数平方增长', trCreated < 24 * 8,
    'trCreated=' + trCreated + ' 平方级上界=' + (24 * 25 / 2));
}

/* ---------------- 6.12 一键处理选中：写回原位置 + .bak 备份 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const mkDir = (name, entries) => {
    const map = new Map(entries.map((e) => [e.n, e]));
    return {
      kind: "directory", name,
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async getFileHandle(nm, opts) {
        if (!map.has(nm)) {
          if (opts && opts.create) { map.set(nm, { n: nm, bytes: new Uint8Array(0) }); }
          else return null;
        }
        const e = map.get(nm);
        return {
          kind: "file",
          async getFile() { return fakeFile(nm, e.bytes); },
          async createWritable() {
            return {
              async write(b) { e.bytes = b instanceof ArrayBuffer ? new Uint8Array(b)
                : (b && b.buffer ? new Uint8Array(b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + (b.byteLength || b.buffer.length)))
                : (b && b.arrayBuffer ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b || 0))); },
              async close() {},
            };
          },
        };
      },
      async removeEntry(nm) { map.delete(nm); },
      async *entries() {
        for (const [nm, e] of map) yield [nm, { kind: "file", async getFile() { return fakeFile(nm, e.bytes); } }];
      },
    };
  };
  const A = new TextEncoder().encode("\u6d89\u5bc6 \u9996\u884c\n\u6b63\u6587\n\u673a\u5bc6 \u5c3e\u884c\n");
  const B = new TextEncoder().encode("\u7edd\u5bc6 \u9996\u884c\n\u6b63\u6587\n\u7edd\u5bc6 \u5c3e\u884c\n");
  const C = new TextEncoder().encode("\u5e72\u51c0\u5185\u5bb9\n\u65e0\u76ee\u6807\u6837\u5b57\n");
  const dir = mkDir("batch-root", [
    { n: "a.txt", bytes: A },
    { n: "b.txt", bytes: B },
    { n: "c.txt", bytes: C },
  ]);
  ctx.showDirectoryPicker = async () => dir;
  const readDir = async (nm) => {
    const ent = dir._map.get(nm);
    if (!ent) return null;
    return new TextDecoder().decode(ent.bytes);
  };
  const dS = (logText().match(/\u6587\u4ef6\u5939\u626b\u63cf\u5b8c\u6210/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/\u6587\u4ef6\u5939\u626b\u63cf\u5b8c\u6210/g) || []).length > dS, 30000);
  check("batch-扫描命中 2 个", el("scanBody").children.length === 2,
    "rows=" + el("scanBody").children.length);
  const dC = (logText().match(/\u4e00\u952e\u5904\u7406\u5b8c\u6210/g) || []).length;
  click("scanCleanBtn");
  const cleanOk = await waitFor(
    () => (logText().match(/\u4e00\u952e\u5904\u7406\u5b8c\u6210/g) || []).length > dC, 60000);
  check("batch-处理完成日志", cleanOk, logText().slice(-300));
  // 这一节只验「处理能跑完 + 一键删除」的表格行为；写回与 .bak 的字节语义见下一节 6.12b
  // （桩按 File System Access 契约实现 getFileHandle 的 NotFoundError 后才能验）。
  const dD = (logText().match(/\u4e00\u952e\u5220\u9664\u5b8c\u6210/g) || []).length;
  click("scanDelDiskBtn");
  await waitFor(() => (logText().match(/\u4e00\u952e\u5220\u9664\u5b8c\u6210/g) || []).length > dD, 60000);
  check("batch-删除完成日志", true, "");
  check("batch-a.txt 已从磁盘删除", !(await dir.getFileHandle("a.txt")),
    "a.txt 仍在");
  check("batch-b.txt 已从磁盘删除", !(await dir.getFileHandle("b.txt")),
    "b.txt 仍在");
  check("batch-未命中文件保留", !!(await dir.getFileHandle("c.txt")),
    "c.txt 被误删");
  check("batch-删除后扫描表清空", el("scanBody").innerHTML.indexOf("td-empty") >= 0,
    el("scanBody").innerHTML.slice(0, 60));
}

/* ---------------- 6.12a 脱敏后删备份（对外交付口径） ----------------
   .bak 里是清理前的原文，保密检查照样能查到。勾上开关后，
   脱敏成功必须把备份删掉；备份没落地时不能反过来删除原文件。 */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const map = new Map();
  const bytes = new TextEncoder().encode("内部 首行\n正文\n内部 尾行\n");
  map.set("p.txt", { n: "p.txt", bytes });
  const dir = {
    kind: "directory", name: "purge-root",
    async queryPermission() { return "granted"; },
    async requestPermission() { return "granted"; },
    mkFileHandle(nm) {
      const e = map.get(nm);
      return {
        kind: "file",
        name: nm,
        async getFile() { return fakeFile(nm, e.bytes); },
        async createWritable() {
          return {
            async write(b) {
              e.bytes = b instanceof ArrayBuffer ? new Uint8Array(b)
                : (b && b.buffer && b.byteLength != null && !(b instanceof Uint8Array) ? new Uint8Array(b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + b.byteLength))
                  : b && b.arrayBuffer ? new Uint8Array(await b.arrayBuffer()) : new Uint8Array(b));
            },
            async close() {},
          };
        },
      };
    },
    async getFileHandle(nm, opts) {
      if (!map.has(nm)) {
        if (opts && opts.create) { map.set(nm, { n: nm, bytes: new Uint8Array(0) }); }
        else {
          const err = new Error("not found: " + nm);
          err.name = "NotFoundError";
          throw err;
        }
      }
      return dir.mkFileHandle(nm);
    },
    async removeEntry(nm) { map.delete(nm); },
  async *entries() {
    for (const [nm, e] of map) {
      yield [nm, dir.mkFileHandle(nm)];
    }
  },
  };
  ctx.showDirectoryPicker = async () => dir;
  el("backup").checked = true;
  el("deleteBak").checked = true;
  const s0 = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/文件夹扫描完成/g) || []).length > s0, 30000);
  const c0 = (logText().match(/一键处理完成/g) || []).length;
  click("scanCleanBtn");
  const ok = await waitFor(() => (logText().match(/一键处理完成/g) || []).length > c0, 60000);
  const body = map.has("p.txt") ? new TextDecoder().decode(map.get("p.txt").bytes) : "";
  check("purgebak-处理完成", ok, logText().slice(-200));
  check("purgebak-正文已脱敏", body.indexOf("内部") < 0, body);
  check("purgebak-.bak 备份已删除", !map.has("p.txt.bak"),
    "备份仍在: " + [...map.keys()].join(","));
  check("purgebak-日志说明了删除份数", (logText().match(/已删除 1 份 \.bak 备份/) || []).length > 0,
    logText().slice(-200));
}

/* ---------------- 6.12b 备份失败必须停手 / .bak 陈旧（v4.69 P0-2、P0-3） ---------------- */
{
  /* File System Access 的 getFileHandle 在文件不存在且没传 create 时抛 NotFoundError，
     不是返回 null。桩必须照此实现：backupOriginal 的「已存在就跳过」正是靠这个异常判断，
     桩返回 null 会把「根本没备份成功」伪装成正常路径（下面 6.12 的注释因此不成立）。 */
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (dir, nm) => {
    const e = dir._map.get(nm);
    return e ? new TextDecoder().decode(e.bytes) : null;
  };
  const mkFs = (rootName, entries, opts) => {
    opts = opts || {};
    const map = new Map(entries.map((e) => [e.n, e]));
    const subs = new Map((opts.subs || [])
      .map((s) => [s.n, mkFs(s.n, s.entries, { failWrite: opts.failWrite })]));
    const fail = opts.failWrite || (() => false);
    const fhOf = (nm) => ({
      kind: "file",
      async getFile() { return fakeFile(nm, map.get(nm).bytes); },
      async createWritable() {
        if (fail(nm)) throw new Error("磁盘已满（模拟）");
        return {
          async write(b) {
            map.get(nm).bytes = (b && typeof b.arrayBuffer === "function")
              ? new Uint8Array(await b.arrayBuffer())
              : (b instanceof Uint8Array ? new Uint8Array(b) : new Uint8Array(b || 0));
          },
          async close() {},
        };
      },
    });
    const boom = (nm) => { const e = new Error(nm + " not found"); e.name = "NotFoundError"; return e; };
    return {
      kind: "directory", name: rootName,
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async getFileHandle(nm, fopts) {
        if (!map.has(nm)) {
          if (!(fopts && fopts.create)) throw boom(nm);
          map.set(nm, { n: nm, bytes: new Uint8Array(0) });
        }
        return fhOf(nm);
      },
      async getDirectoryHandle(nm, dopts) {
        if (!subs.has(nm)) {
          if (!(dopts && dopts.create)) throw boom(nm);
          subs.set(nm, mkFs(nm, [], { failWrite: opts.failWrite }));
        }
        return subs.get(nm);
      },
      async removeEntry(nm) { map.delete(nm); subs.delete(nm); },
      async *entries() {
        for (const nm of map.keys()) yield [nm, fhOf(nm)];
        for (const [nm, d] of subs) yield [nm, d];
      },
      _map: map, _subs: subs,
    };
  };
  const HIT = "内部 首行\n正文\n机密 尾行\n";

  /* A) 备份写不下去（磁盘满 / 只读 / 权限过期）时，绝不能继续覆盖原文件 */
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  el("backup").checked = true;
  const dirA = mkFs("p02-root", [{ n: "a.txt", bytes: enc(HIT) }],
    { failWrite: (nm) => /(^|\.)bak/.test(nm) });
  ctx.showDirectoryPicker = async () => dirA;
  let sA = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/文件夹扫描完成/g) || []).length > sA, 30000);
  check("v469-A-扫描命中 1 个", el("scanBody").children.length === 1,
    "rows=" + el("scanBody").children.length);
  let cA = (logText().match(/一键处理完成/g) || []).length;
  click("scanCleanBtn");
  await waitFor(() => (logText().match(/一键处理完成/g) || []).length > cA, 60000);
  check("v469-备份写盘失败要报出文件与原因",
    /备份失败，已保留原文件：a\.txt/.test(logText()), logText().slice(-300));
  check("v469-备份写盘失败不得覆盖原文件", dec(dirA, "a.txt") === HIT,
    "备份没落地却把唯一一份文档覆盖了——静默丢数据");
  check("v469-写失败的半成品 .bak 要清掉", !dirA._map.has("a.txt.bak"),
    [...dirA._map.keys()].join(","));
  check("v469-备份失败计入失败数且清理数为 0",
    /一键处理完成：清理 0 个、未变化 0 个、失败 1 个/.test(logText()), logText().slice(-200));

  /* B) 同目录已有 .bak：旧备份不能被覆盖，本批要有自己的备份，撤销要还原本批处理前 */
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  el("backup").checked = true;
  const STALE = "上一批的备份（内容已过时）\n";
  const dirB = mkFs("p03-root", [
    { n: "a.txt", bytes: enc(HIT) },
    { n: "a.txt.bak", bytes: enc(STALE) },
  ]);
  ctx.showDirectoryPicker = async () => dirB;
  sA = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/文件夹扫描完成/g) || []).length > sA, 30000);
  cA = (logText().match(/一键处理完成/g) || []).length;
  click("scanCleanBtn");
  await waitFor(() => (logText().match(/一键处理完成/g) || []).length > cA, 60000);
  check("v469-更早的 .bak 不被覆盖", dec(dirB, "a.txt.bak") === STALE, dec(dirB, "a.txt.bak"));
  check("v469-本批备份另起一份且是处理前原文", dec(dirB, "a.txt.bak.2") === HIT,
    [...dirB._map.keys()].join(","));
  check("v469-原文件确已清理", !/内部|机密/.test(dec(dirB, "a.txt") || ""), dec(dirB, "a.txt"));
  const ledB = JSON.parse(storage.get("dwr.undo.v1") || "[]");
  const lastB = ledB[ledB.length - 1];
  check("v469-撤销账记下本批实际用的备份名",
    !!lastB && lastB.items[0].bak === "a.txt.bak.2", JSON.stringify(lastB));
  click("undoBtn");
  sA = (logText().match(/撤销完成/g) || []).length;
  await waitFor(() => (logText().match(/撤销完成/g) || []).length > sA, 60000);
  check("v469-撤销还原的是本批处理前的内容", dec(dirB, "a.txt") === HIT,
    logText().slice(-200) + " | " + dec(dirB, "a.txt"));
  check("v469-撤销不动更早的 .bak", dec(dirB, "a.txt.bak") === STALE, dec(dirB, "a.txt.bak"));

  /* C) 子目录里的文件：备份与还原都必须落在它所在的目录 */
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  el("backup").checked = true;
  const dirC = mkFs("p03c-root", [],
    { subs: [{ n: "sub", entries: [{ n: "a.txt", bytes: enc(HIT) }] }] });
  ctx.showDirectoryPicker = async () => dirC;
  sA = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/文件夹扫描完成/g) || []).length > sA, 30000);
  cA = (logText().match(/一键处理完成/g) || []).length;
  click("scanCleanBtn");
  await waitFor(() => (logText().match(/一键处理完成/g) || []).length > cA, 60000);
  const subC = dirC._subs.get("sub");
  check("v469-嵌套文件的备份落在所在子目录", dec(subC, "a.txt.bak") === HIT,
    "sub/ 下备份：" + [...subC._map.keys()].join(","));
  check("v469-嵌套文件写回的是自身路径", !/内部|机密/.test(dec(subC, "a.txt") || ""),
    dec(subC, "a.txt"));
  click("undoBtn");
  sA = (logText().match(/撤销完成/g) || []).length;
  await waitFor(() => (logText().match(/撤销完成/g) || []).length > sA, 60000);
  check("v469-撤销写回所在子目录", dec(subC, "a.txt") === HIT,
    logText().slice(-200) + " | " + dec(subC, "a.txt"));
  check("v469-撤销不在根目录留下错名文件", !dirC._map.has("a.txt"),
    [...dirC._map.keys()].join(","));

  /* D) 「原地覆盖」处理：备份写不下去时同样不许动原文件，且不能计入「修改」 */
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  el("backup").checked = true;
  const dirD = mkFs("p02d-root", [{ n: "a.txt", bytes: enc(HIT) }],
    { failWrite: (nm) => /(^|\.)bak/.test(nm) });
  ctx.showDirectoryPicker = async () => dirD;
  radios.outmode = "inplace";
  change("fileInput", { target: { files: [fakeFile("a.txt", enc(HIT))], value: "" } });
  const cD = (logText().match(/处理完成：/g) || []).length;
  click("runBtn");
  await waitFor(() => (logText().match(/处理完成：/g) || []).length > cD, 60000);
  check("v469-原地覆盖备份失败时报出原因",
    /备份失败，原文件未改动/.test(logText()), logText().slice(-300));
  check("v469-原地覆盖备份失败不得改动原文件", dec(dirD, "a.txt") === HIT, dec(dirD, "a.txt"));
  check("v469-原地覆盖备份失败不计入修改数",
    /处理完成：修改 0 个文件，共清除 0 处敏感词/.test(logText()), logText().slice(-200));
}
/* ---------------- 6.13 清除后自检（复检扫描结果） ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  radios.scope = "all";
  const mkFH = (e) => ({
    kind: "file",
    async getFile() { return fakeFile(e.n, e.bytes); },
    async requestPermission() { return "granted"; },
    async queryPermission() { return "granted"; },
    async createWritable() {
      return {
        async write(b) {
          e.bytes = b instanceof ArrayBuffer ? new Uint8Array(b)
            : (b && b.buffer ? new Uint8Array(b.buffer) : new Uint8Array(b || 0));
        },
        async close() {},
      };
    },
  });
  const mkDir = (name, entries) => {
    const map = new Map(entries.map((e) => [e.n, e]));
    return {
      kind: "directory", name,
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      async getFileHandle(nm, o) {
        if (!map.has(nm) && o && o.create) map.set(nm, { n: nm, bytes: new Uint8Array(0) });
        return map.has(nm) ? mkFH(map.get(nm)) : null;
      },
      async removeEntry(nm) { map.delete(nm); },
      async *entries() { for (const e of map.values()) yield [e.n, mkFH(e)]; },
      _map: map,
    };
  };
  // 首段有命中 + 中段跨 run 命中：首尾范围下后者清不掉，复检应当报出
  const S = String.fromCodePoint;
  const SHEMI = S(20869) + S(37096) + S(36164) + S(26009);
  const JIMI = S(26426, 23494);
  const ZHENGWEN = S(27491, 25991);
  const PUTONG = S(26222, 36890, 32467);
  const T = "<w:t>";
  const TC = "</w:t></w:r></w:p>";
  const P = "<w:p><w:r><w:t>";
  const xml = P + SHEMI + TC + P + S(20844) + "</w:t><w:r><w:t>" + JIMI
    + "</w:t><w:r><w:t>" + ZHENGWEN + TC + P + PUTONG + TC + "</w:body></w:document>";
  const z = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: xml },
  ]);
  const bytes0 = new Uint8Array(await z.arrayBuffer());
  const dir = mkDir("verify-root", [{ n: "mid.docx", bytes: bytes0 }]);
  ctx.showDirectoryPicker = async () => dir;
  click("scanFolderBtn");
  await waitFor(() => logText().indexOf(S(25991, 20214, 25195, 26597, 23436, 25104)) >= 0, 30000);
  check("verify-扫描命中 1 个", el("scanBody").children.length === 1,
    "rows=" + el("scanBody").children.length);
  click("scanVerifyBtn");
  const verOk = await waitFor(() => logText().indexOf(S(22797, 26816, 23436, 25104)) >= 0, 60000);
  check("verify-复检可完成", verOk, logText().slice(-300));
  check("verify-报出中段残留与部件位置",
    new RegExp(S(27531, 30041) + " " + "\\d+ " + S(22788)).test(logText())
      && logText().indexOf("word/document.xml") >= 0,
    logText().slice(-400));
  check("verify-复检汇总统计", logText().indexOf(S(22797, 26816, 23436, 25104)) >= 0,
    logText().slice(-300));
  check("verify-扫描行显示残留标记",
    // DOM 桩不做 innerHTML 反射：行内容由 tr.insertAdjacentHTML 写入子节点，
    // 需按仓库既有约定（见 fileBody 行断言）从 children 上取
    el("scanBody").children.some((tr) => (tr.innerHTML || "").indexOf(S(27531, 30041)) >= 0),
    el("scanBody").children.map((tr) => tr.innerHTML).join(" | ").slice(0, 160));
  check("verify-未命中文件未被复检改动", dir._map.get("mid.docx").bytes.length === bytes0.length,
    "size changed");
}
/* ---------------- 6.9b 日志区高度与滚动跟随 ---------------- */
{
  const APP = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
  const CSS = fs.readFileSync(path.join(__dirname, "css", "style.css"), "utf8");
  check("ux-日志限高改为视口自适应",
    APP.indexOf("var atBottom") >= 0 && /min\(30vh,\s*260px\)/.test(CSS),
    "日志高度或 atBottom 缺失");
  const atBottomUse = APP.indexOf("el.scrollHeight - el.clientHeight - el.scrollTop < 24") >= 0
    && APP.indexOf("if (atBottom) el.scrollTop = el.scrollHeight;") >= 0;
  check("ux-日志只在停底时跟随滚动", atBottomUse, "log() 未按 atBottom 条件滚动");
}

/* ---------------- 6.9c 控件可访问名称与表头 scope（v4.13 改为全量检查） ---------------- */
{
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  /* v4.13：原来这里是 8 个 id 的硬编码白名单，不在名单里的新增控件对测试完全隐形——
     5 个 <select> 因此漏了六个版本（v2.62 的 inputNoLabel 审计也没覆盖 select）。
     改成遍历全部控件：input / select / textarea 逐个要求可访问名称。
     判定「有名称」的三种合法形态：自带 aria-label、被 <label> 包裹、
     或页面里有 <label for=该id> 关联。type=hidden 与 file input 除外
     （后者由可见按钮代劳，按钮自身有名称）。 */
  function ctrlTags(tagName) {
    const re = new RegExp('<' + tagName + '\\b[^>]*>', 'g');
    const out = [];
    let m;
    while ((m = re.exec(HTML)) !== null) out.push(m[0]);
    return out;
  }
  // 收集所有 <label ...>...</label> 文本块：checkbox / radio 常用「<label><input> 文字</label>」
  // 包裹式写法，这类 input 的可访问名称来自包裹它的 label 文本，不算无名。
  const labelBlocks = [];
  {
    const re = /<label\b[^>]*>[\s\S]*?<\/label>/g;
    let m;
    while ((m = re.exec(HTML)) !== null) labelBlocks.push(m[0]);
  }
  const forIds = new Set();
  labelBlocks.forEach((b) => {
    const fm = /\bfor="([^"]+)"/.exec(b);
    if (fm) forIds.add(fm[1]);
  });
  // 被某个 label 块包裹（input 出现在块内）
  function wrappedByLabel(tag) {
    return labelBlocks.some((b) => b.indexOf(tag) >= 0);
  }
  const all = [].concat(ctrlTags('input'), ctrlTags('select'), ctrlTags('textarea'));
  const unnamed = all.filter((tag) => {
    if (/type="hidden"/.test(tag)) return false;
    if (/type="file"/.test(tag)) return false;   // 由可见按钮触发，按钮有名称
    if (/aria-label=/.test(tag)) return false;
    if (wrappedByLabel(tag)) return false;        // <label><input> 文字</label>
    const idm = /\bid="([^"]+)"/.exec(tag);
    if (idm && forIds.has(idm[1])) return false;  // <label for=id>
    return true;
  });
  const unnamedIds = unnamed.map((t) => (/\bid="([^"]+)"/.exec(t) || [, '(no id)'])[1]);
  check('a11y-全部控件均有可访问名称（input / select / textarea 全量）',
    unnamed.length === 0, 'unnamed=' + unnamedIds.join(','));
  // select 单独一条：v2.62 的审计只查了 input，这是 5 个 select 漏掉的直接原因
  const selects = ctrlTags('select');
  const selNoLabel = selects.filter((t) => !/aria-label=/.test(t));
  check('a11y-每个 select 都带 aria-label', selNoLabel.length === 0,
    'count=' + selects.length + ' missing=' + selNoLabel.map((t) => (/\bid="([^"]+)"/.exec(t) || [, '?'])[1]).join(','));
  /* v4.14：ACCESSIBILITY.md 里「快捷键」与「焦点可见」两条声明此前没有任何回归覆盖。
     v4.13 已把控件可访问名称改成全量门禁，这里补齐剩下两条能静态判定的。
     动态行为（Tab 走查 60 站零隐藏、Esc 归还焦点、Ctrl+Enter 给提示）
     已由 Playwright 实测确认，记录在 CHANGELOG，此处只锁静态可判的部分。 */
  // 1) 没有正数 tabindex：正数会打乱 DOM 顺序，是键盘可达性的常见破坏源
  const posTab = (HTML.match(/tabindex="[1-9]\d*"/g) || []).length;
  check('a11y-无正数 tabindex（不破坏 Tab 顺序）', posTab === 0, 'found=' + posTab);
  // 2) 快捷键处理器在源码里真实存在（防重构时被误删）
  const APPJS = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const shortcuts = {
    'Ctrl+Enter': APPJS.indexOf('ctrlKey') >= 0 && APPJS.indexOf('key === \'Enter\'') >= 0,
    'Escape 关闭浮层': APPJS.indexOf('key === \'Escape\'') >= 0 || APPJS.indexOf("key === 'Escape'") >= 0,
    'Shift 连选': APPJS.indexOf('shiftKey') >= 0,
    'Ctrl+A 全选': APPJS.indexOf('ctrlKey') >= 0 && APPJS.indexOf("key === 'a'") >= 0,
    'Delete 删除选中': APPJS.indexOf("key === 'Delete'") >= 0,
  };
  const missShort = Object.keys(shortcuts).filter((k) => !shortcuts[k]);
  check('a11y-文档声明的快捷键在源码中均在', missShort.length === 0, 'missing=' + missShort.join(','));
  // 3) 焦点环样式存在（:focus-visible 规则不能在被删）
  const CSSF = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
  check('a11y-焦点环样式在场（:focus-visible）', CSSF.indexOf(':focus-visible') >= 0, '缺 :focus-visible 规则');

  // v4.17 文档同步门禁：v4.5-v4.16 上了 12 个新功能，README.md 一条都没写——
  // 功能特性列表停在 v2.83。用户读 README 会以为这些能力不存在。
  // 这里把「新功能必须进 README」变成断言，堵住这类脱节。
  {
    const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    // 每个对外 CLI 参数 -> README 里必须出现的字样
    const CLI_FLAGS = [
      ['--name-words', 'name-words'],
      ['--name-mode', 'name-mode'],
      ['--case-sensitive', 'case-sensitive'],
      ['--docs-only', 'docs-only'],
      ['--shard', 'shard'],
      ['--ext', '--ext'],
      ['--all-ext', '--all-ext'],
      ['--move-dry-run', 'move-dry-run'],
      ['--from-report', 'from-report'],
    ];
    const missDoc = CLI_FLAGS.filter((f) => SCAN.indexOf("'" + f[0] + "'") >= 0 && README.indexOf(f[1]) < 0)
      .map((f) => f[0]);
    check('v417-README 覆盖全部对外 CLI 参数', missDoc.length === 0, '漏写: ' + missDoc.join(','));
    // 网页端新控件也必须在 README 有交代
    const UI_IDS = [
      ['scanNameWords', '文件名关键字'],
      ['caseSensitive', '区分大小写'],
      ['reviewListPanel', '复核清单'],
    ];
    const missUi = UI_IDS.filter((u) => HTML.indexOf('id="' + u[0] + '"') >= 0 && README.indexOf(u[1]) < 0)
      .map((u) => u[0]);
    check('v417-README 覆盖网页端新控件', missUi.length === 0, '漏写: ' + missUi.join(','));
    check('v417-README 有 v4.5 之后的新增能力速览', README.indexOf('新增能力速览') >= 0, '速览段缺失');

  // v4.18 文档门禁：遍历 scan.mjs 里的对外参数，要求公开 README 有交代。
  // v4.78.1 起内部交接文档不再进入公开仓库，安全参数也必须写进 README。
  {
    const HO = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
    const SCAN2 = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    // 只查面向用户的参数
    const USER_FLAGS = [
      '--name-words', '--name-mode', '--case-sensitive', '--docs-only', '--shard',
      '--ext', '--all-ext', '--move-dry-run', '--from-report', '--verify',
      '--whole', '--exclude-ctx', '--max-file-mb', '--no-skip-system', '--exclude',
      '--move-to', '--clean', '--out', '--json', '--report', '--html', '--limit',
      '--depth', '--concurrency', '--scope', '--action', '--custom', '--words',
      '--drive', '--dir', '--root', '--delete', '--delete-dry-run',
      '--authorized-root', '--confirm-delete', '--allow-network-paths', '--confirm-network-paths',
    ];
    const missHo = USER_FLAGS.filter((f) => SCAN2.indexOf("'" + f + "'") >= 0 && HO.indexOf(f) < 0);
    check('v418-README.md 覆盖全部对外 CLI 参数', missHo.length === 0, '漏写: ' + missHo.join(','));
    // 版本号一致性：CHANGELOG 顶部必须与 package.json 同版本。
    // 正则允许两段版本（v4.17）与三段（v3.8.1）——写成只匹配三段会跳过 v4.17 这种、误报脱节。
    const CL2 = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    const PJ = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const topM = /^## v(\d+\.\d+(?:\.\d+)?)\s*-/m.exec(CL2);
    // CHANGELOG 用两段版本（v4.17），package.json 用三段（4.17.0），先归一化再比
    const raw = topM ? topM[1] : 'none';
    const got = /^\d+\.\d+$/.test(raw) ? raw + '.0' : raw;
    check('v418-CHANGELOG 顶部版本与 package.json 一致', got === PJ.version,
      'changelog=' + got + ' package=' + PJ.version);
  }
  }
  // v4.15 nameHit 语义门禁：v4.7 引入文件名关键字时只验了「能跑」，
  // 没验 and/or 两种模式的判定语义。这里用 vm 跑 scan.mjs 里的真实函数锁住行为。
  // 注：空数组 words 是不可达输入——parseNameWords 对空输入返回 null 而非 []，
  // 所以不纳入用例（测不可达分支只会得到假失败）。
  {
    const SCANSRC = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    const k = SCANSRC.indexOf('function nameHit(fullPath, words, mode)');
    check('v415-scan.mjs 有 nameHit', k >= 0, 'nameHit 缺失');
    if (k >= 0) {
      let depth = 0, end = -1;
      for (let i = SCANSRC.indexOf('{', k); i < SCANSRC.length; i++) {
        if (SCANSRC.charAt(i) === '{') depth++;
        else if (SCANSRC.charAt(i) === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
      }
      const fn = SCANSRC.slice(k, end);
      const vctx = vm.createContext({ String, console });
      vm.runInContext(fn, vctx);
      const nh = vm.runInContext('nameHit', vctx);
      const CASES = [
        // [文件名, 词, 模式, 期望]
        ['台账-2024-报表.xlsx', ['台账', '报表'], 'and', true],
        ['台账-2024.xlsx', ['台账', '报表'], 'and', false],
        ['报表.xlsx', ['台账', '报表'], 'and', false],
        ['台账.xlsx', ['台账', '报表'], 'or', true],
        ['无关.xlsx', ['台账', '报表'], 'or', false],
        // 大小写不敏感只对 ASCII 有效；中文词不可能匹配罗马化文件名
        ['TAIZHANG.xlsx', ['taizhang'], 'or', true],
        ['TAIZHANG.xlsx', ['Taizhang'], 'or', true],
        // 目录名含目标词不算命中：只判文件名
        ['内部资料/普通文件.xlsx', ['内部资料'], 'or', false],
        // null 表示不筛选，一律放行
        ['任意.xlsx', null, 'or', true],
        ['任意.xlsx', null, 'and', true],
      ];
      const bad = CASES.filter((c) => nh(c[0], c[1], c[2]) !== c[3]);
      check('v415-nameHit and/or 语义与大小写、目录不掺和均正确', bad.length === 0,
        'bad=' + bad.map((c) => c[0] + '/' + c[2] + '/want' + c[3]).join(' ; '));
    }
  }
  const thTotal = (HTML.match(/<th\b/g) || []).length;
  const thScope = (HTML.match(/<th\b[^>]*scope="col"/g) || []).length;
  check('ux-表头均有 scope', thTotal > 0 && thTotal === thScope, 'th=' + thTotal + ' scoped=' + thScope);
}

/* ---------------- 6.9d 扫描日志报告跳过的文件 ---------------- */
{
  const APP = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
  // .pdf 属不支持格式：用于验证「混着它时日志要说出跳过了几个」
  const pdfBytes = new TextEncoder().encode('%PDF-1.4 fake');
  check("ux-扫描日志提示跳过的文件（源码接线）",
    APP.indexOf("var skipped = state.files.length - pending.length;") >= 0
      && APP.indexOf("个格式不支持未检查") >= 0,
    "skipped 报告缺失");
  // v4.41 行为断言：只验文案在源码里不够——真要「混着 .pdf 时日志说出来」。
  // 不报的话用户看到「命中 0」会以为全部干净，实际有文件根本没被检查。
  reloadApp();
  change("fileInput", {
    target: {
      files: [fakeFile('docs/a.txt', txtBytes), fakeFile('docs/b.pdf', pdfBytes)],
      value: '',
    },
  });
  click('scanBtn');
  const skipLogged = await waitFor(() => /另有 1 个格式不支持未检查/.test(logText()));
  check('ux-扫描日志真的报出跳过的文件数', skipLogged, logText().slice(-300));
  // 没有不支持文件时不应出现这句（避免误导）
  reloadApp();
  change('fileInput', { target: { files: [fakeFile('docs/a.txt', txtBytes)], value: '' } });
  click('scanBtn');
  const allSupported = await waitFor(() => /扫描完成/.test(logText()));
  check('ux-无非不支持文件时不报跳过',
    allSupported && !/格式不支持未检查/.test(logText()), logText().slice(-200));
}

/* ---------------- 6.9e 失败 / 不支持行带原因 + 预览截断提示 ---------------- */
{
  const APP = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
  const CSS = fs.readFileSync(path.join(__dirname, "css", "style.css"), "utf8");
  check("ux-错误行悬停带失败原因",
    APP.indexOf("rowHint = it.error ? ('处理失败：' + it.error) : '处理失败';") >= 0
    && APP.indexOf("if (rowHint) tr.setAttribute('data-tip', rowHint);") >= 0,
    "rowHint 未落地");
  check("ux-不支持行说明格式原因",
    APP.indexOf("本工具不处理此格式") >= 0,
    "unsupported hint 缺失");
  check("ux-预览截断在两栏都提示",
    APP.indexOf("已省略") >= 0 && APP.indexOf("pv-omit") >= 0 && APP.indexOf("previewBody") >= 0,
    "preview 省略提示缺失");
  check("ux-预览行数上限提为常量", /var PREVIEW_MAX = 300;/.test(APP), "PREVIEW_MAX 未定义");
  check("ux-省略提示有样式", CSS.indexOf(".pv-omit") >= 0, "missing .pv-omit");
}

/* ---------------- 6.9f chip 悬停提示 + 自定义留空拦截 + 未扫描筛选提示 ---------------- */
{
  const APP = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
  check("ux-启用态 chip 提示含状态与操作",
    APP.indexOf("生效中（点一下停用）") >= 0, "chip title 缺少启用态");
  check("ux-禁用态 chip 提示说明已停用",
    APP.indexOf("已停用（点一下重新启用）") >= 0, "chip title 缺少停用态");
  check("ux-chip 提示带类型前缀",
    APP.indexOf("(r.type === 'regex' ? '正则' : '普通词')") >= 0,
    "chip title 缺少类型前缀");
  check("ux-自定义留空被拦下并说明后果",
    APP.indexOf("选了「自定义」但没填替换文本") >= 0, "custom 空值拦截缺失");
  check("ux-未扫描时筛命中给出下一步",
    APP.indexOf("还有") >= 0 && APP.indexOf("未扫描") >= 0,
    "未扫描筛选提示缺失");
}
/* ---------------- 6.9h 自定义悬停浮窗（data-tip → 气泡，替代原生 title） ---------------- */
{
  const APP = fs.readFileSync(path.join(__dirname, "js", "app.js"), "utf8");
  const UI = fs.readFileSync(path.join(__dirname, "js", "ui.js"), "utf8");
  const HTML = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const CSS = fs.readFileSync(path.join(__dirname, "css", "style.css"), "utf8");
  check("tip-index.html 已无原生 title 属性",
    HTML.indexOf('title="') < 0 && HTML.indexOf('data-tip=') >= 0,
    "title=\" 残留 " + (HTML.match(/title="/g) || []).length + " 处");
  check("tip-表格全选框改用 aria-label",
    /id="scanSelAllBox"[^>]*aria-label=/.test(HTML) && /id="fileSelAll"[^>]*aria-label=/.test(HTML),
    "全选框缺少 aria-label");
  check("tip-ui.js 有浮窗驱动与 data-tip 取值",
    UI.indexOf("function bindTips") >= 0 && UI.indexOf("id = 'dwrTip'") >= 0
    && UI.indexOf("pointerover") >= 0 && UI.indexOf("focusin") >= 0
    && UI.indexOf("getAttribute('data-tip')") >= 0
    && APP.indexOf("bindTips = DWRUi.bindTips") >= 0
    && HTML.indexOf('src="js/ui.js"') >= 0,
    "bindTips 不完整");
  check("tip-init 里已挂载 bindTips",
    /bind\(\);\s*\r?\n\s*bindTips\(\)/.test(APP), "init 未调用 bindTips");
  check("tip-动态提示统一走 data-tip",
    APP.indexOf("tr.setAttribute('data-tip', rowHint)") >= 0
    && APP.indexOf("pn.setAttribute('data-tip', path)") >= 0
    && !/\btitle = /.test(APP.replace(/pn\.title|tr\.title/g, "")),
    "仍有 title = 赋值");
  check("tip-气泡样式与翻转到下方",
    CSS.indexOf("#dwrTip") >= 0 && CSS.indexOf(".tip-on") >= 0
    && CSS.indexOf(".tip-down") >= 0,
    "浮窗样式缺失");
  check("tip-尊重减少动效偏好",
    CSS.indexOf("prefers-reduced-motion") >= 0 && CSS.indexOf("#dwrTip") >= 0,
    "未处理 reduced-motion");
  // 全站覆盖：交互控件（按钮 / 下拉 / 表头 / 说明标签）都应带 data-tip，
  // 否则会有「有的能弹、有的不能弹」的割裂感。
  const CTRL = /<(button|select|textarea|th|li)\b[^>]*>/g;
  const controls = [...HTML.matchAll(CTRL)].map((m) => m[0])
    .filter((t) => !t.includes("data-tip=") && !t.includes("hidden"));
  check("tip-所有按钮/下拉/表头/步骤均有悬停说明",
    controls.length === 0, "missing=" + controls.map((t) => t.slice(0, 40)).join(" | "));
  check("tip-单选与复选选项说明挂在 label 上",
    (HTML.match(/name=\"(scope|action|outmode)\"/g) || []).length === 9
    && HTML.indexOf('name="scope"') >= 0
    && /<label data-tip="[^"]+"><input type="radio" name="scope"/.test(HTML)
    && /<label class="switch" data-tip="[^"]+"><input type="checkbox"/.test(HTML),
    "选项 label 缺少 data-tip");
  check("tip-列表状态徽章也带解释",
    APP.indexOf("escapeHtml(statusTip)") >= 0 && APP.indexOf("扫描发现 ") >= 0,
    "状态列缺少 data-tip");
}
/* ---------------- 6.9g 处理记录导出（CSV / JSON） ---------------- */
{
  reloadApp();
  change("fileInput", { target: { files: [fakeFile("docs/hit.txt",
    new TextEncoder().encode("内部 首行\n正文\n机密 尾行\n"))], value: "" } });
  await waitFor(() => el("fileBody").children.length === 1, 15000);
  const doneBefore = (logText().match(/处理完成/g) || []).length;
  click("runBtn");
  await waitFor(() => (logText().match(/处理完成/g) || []).length > doneBefore, 60000);
  check("app-处理后导出报告按钮高亮", !!$("reportBtn") && !$("reportBtn").disabled,
    "reportBtn 未启用（列表里应有一个 status=done 的文件）");
  check("app-高亮不污染按钮可用性", !$("runBtn").disabled, "runBtn 被误禁用");

  ctx.__lastBlob = null;
  click("reportBtn");
  const bytes = ctx.__lastBlob ? new Uint8Array(await ctx.__lastBlob.arrayBuffer()) : null;
  const csv = bytes ? new TextDecoder().decode(bytes) : "";
  check("app-导出 CSV 带 BOM", !!bytes && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    bytes ? "first3=" + bytes.slice(0, 3).join(",") : "null");
  // 结构：#注释元信息若干行 + path,... 表头 + 明细行
  const cl = csv.split("\r\n");
  check("app-CSV 含元信息注释行", cl[0].indexOf("#") === 0, JSON.stringify(cl.slice(0, 2)));
  check("app-CSV 表头与明细行",
    cl.some((l) => l.indexOf("file,") === 0) && cl.length > 6,
    JSON.stringify(cl.slice(0, 6)));
  check("app-CSV 含清除处数元信息",
    cl.some((l) => l.indexOf("#清除敏感词处数") === 0),
    JSON.stringify(cl.slice(0, 8)));

  ctx.__lastBlob = null;
  click("reportJsonBtn");
  const jt = ctx.__lastBlob ? JSON.parse(await ctx.__lastBlob.text()) : null;
  check("app-导出 JSON 结构完整",
    !!jt && jt.meta && typeof jt.meta === "object" && Array.isArray(jt.files)
      && typeof jt.meta["清除敏感词处数"] === "number",
    JSON.stringify(jt && jt.meta));
  check("app-JSON 明细状态为已处理",
    !!jt && jt.files.some((f) => f.status === "done"),
    JSON.stringify(jt && jt.files && jt.files[0]));
}

/* ---------------- 6.10 主题切换 ---------------- */
{
  reloadApp();
  const html = documentStub.documentElement;
  check("theme-初始落地为浅色", html.getAttribute("data-theme") === "light",
    html.getAttribute("data-theme"));
  check("theme-按钮初始文案为深色", $("themeBtn").textContent.indexOf("深色") >= 0,
    $("themeBtn").textContent);
  click("themeBtn");
  check("theme-切换到深色", html.getAttribute("data-theme") === "dark",
    html.getAttribute("data-theme"));
  check("theme-深色下按钮文案为浅色", $("themeBtn").textContent.indexOf("浅色") >= 0,
    $("themeBtn").textContent);
  check("theme-深色写入 localStorage", storage.get("dwr.theme") === "dark",
    String(storage.get("dwr.theme")));
  click("themeBtn");
  check("theme-可切回浅色", html.getAttribute("data-theme") === "light",
    html.getAttribute("data-theme"));
  check("theme-浅色下按钮文案恢复", $("themeBtn").textContent.indexOf("深色") >= 0,
    $("themeBtn").textContent);
}


/* ---------------- 6.10b 词库 chip 多选与批量删除 ---------------- */
/* ---------------- 6.10c 单选删除 / 编辑态选择引用 ---------------- */
{
  await waitFor(() => el("ruleChips").children.length >= 1, 15000);
  // v4.0 起 ruleChips 里除 chip 外还有 grp-head 组头节点，只取 chip
  const chips = () => Array.from(el("ruleChips").children).filter((c) => c.className.indexOf("chip") >= 0);
  // chip > [checkbox.chip-check, label, acts > [span.x.edit, span.x]]
  const pick = (i) => {
    const c = chips()[i];
    return { chip: c, cb: c.children[0], edit: c.children[2].children[0], del: c.children[2].children[1] };
  };
  // 每次勾选后 renderRules() 会重建 DOM，必须重新取节点
  const toggle = async (i) => {
    const p = pick(i);
    p.cb.dispatch("click", { target: p.cb, stopPropagation() {} });
    await waitFor(() => chips().length > 0, 5000);
  };

  await toggle(0);
  await toggle(1);
  check("rule-两项已勾选", /已选 2 个词条/.test(el("ruleSelCount").textContent),
    el("ruleSelCount").textContent);

  // 删除单个：只移除点 ✕ 的那个，另一项仍选中
  const n0 = chips().length;
  const victim = pick(0).deep ? null : null;
  const firstText = chips()[0].deepText();
  const d0 = pick(0);
  d0.chip.dispatch("click", { target: d0.del, stopPropagation() {} });
  await waitFor(() => chips().length < n0, 5000);
  check("rule-单个删除后其他选中项保留", chips().length === n0 - 1,
    "n0=" + n0 + " now=" + chips().length);
  check("rule-单个删除后勾选数减少", /已选 1 个词条/.test(el("ruleSelCount").textContent),
    el("ruleSelCount").textContent);
  check("rule-被删词条已不在列表", !chips().some((c) => c.deepText() === firstText),
    "被删词条仍在");

  // 编辑替换：原芯片被重建，选中引用应失效
  const t = chips().find((c) => c.deepText().length > 4) || chips()[0];
  t.dispatch("click", { target: t.children[2].children[0] });
  el("ruleInput").value = "替换后的词";
  click("addRuleBtn");
  await waitFor(() => chips().some((c) => c.deepText().indexOf("替换后的词") >= 0), 10000);
  const selLeft = chips().filter((c) => c.className.indexOf("sel") >= 0).length;
  check("rule-编辑替换后未残留选中芯片", selLeft === 0, "仍有 " + selLeft + " 个选中 chip");
  check("rule-编辑替换后选择引用失效",
    el("ruleSelBar").style.display === "none" || /已选 0 个词条/.test(el("ruleSelCount").textContent),
    "selCount=" + el("ruleSelCount").textContent);
}

/* ---------------- 6.10d 清空词库 ---------------- */
{
  await waitFor(() => el("ruleChips").children.length >= 1, 15000);
  click("clearRuleBtn");
  await waitFor(() => el("ruleChips").children.length === 0, 10000);
  check("rule-清空词库后选择条隐藏", el("ruleSelBar").style.display === "none",
    "display=" + el("ruleSelBar").style.display);
  check("rule-清空词库后全选按钮禁用", $("ruleSelAllBtn").disabled === true,
    "disabled=" + $("ruleSelAllBtn").disabled);
  // 恢复默认词库供后续用例
  click("loadPresetBtn");
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  check("rule-恢复默认词库", el("ruleChips").children.length >= 3,
    "chips=" + el("ruleChips").children.length);
}

/* ---- 6.24b 表格空态统一组件 ---- */
/* ---- 6.24d Office 预览的「处理后」必须真的清掉命中词 ----
   背景：预览走 extractText -> processText。抽取结果以 `[正文]` 这类可读定位行开头（早期是包内
   部件路径 `[word/document.xml]`，普通用户看不懂），
   processText 把它当成首行，真实首段落到第 2 行，于是 scope=first / firstlast 时首行永远判不中，
   「处理后」与原文一字不差，用户核对不出处理效果。
   真实处理走 processXml 按块判定，没有这个问题——只影响预览展示。*/
{
  reloadApp();
  const noise = new TextEncoder().encode("公开段落一\n公开段落二\n公开段落三\n");
  const headBytes = new TextEncoder().encode("公开段落一\n内部资料标题\n正文\n");
  const tailBytes = new TextEncoder().encode("正文\n秘密尾注\n");
  const docxBlob2 = await D.DWRZip.pack([
    { name: "word/document.xml", data: "<w:document><w:body>" +
      '<w:p><w:t>内部</w:t></w:p><w:p><w:t>资料</w:t></w:p>' +
      '<w:p><w:t>正文段落</w:t></w:p><w:p><w:t>机密</w:t></w:p>' +
      "</w:body></w:document>" },
    // 页眉是独立部件：真实处理时整部件算首尾，预览必须同样清掉它的命中，
    // 否则「列表行命中 3、预览处理后仍留着内部」自相矛盾（回归用例）
    { name: "word/header1.xml", data: "<w:hdr><w:p><w:t>内部页眉</w:t></w:p></w:hdr>" },
  ]);
  const bytes2 = new Uint8Array(await docxBlob2.arrayBuffer());
  change("fileInput", {
    target: {
      files: [
        fakeFile("docs/noise.txt", noise),
        fakeFile("docs/head.txt", headBytes),
        fakeFile("docs/tail.txt", tailBytes),
        fakeFile("docs/multi.docx", bytes2),
      ],
      value: "",
    },
  });
  await waitFor(() => el("fileBody").children.length === 4, 15000);
  // 点 docx 行：走 extractText + previewProcess 分支
  const docxRow = el("fileBody").children[3];
  docxRow.click();
  const docxPreview = await waitFor(() =>
    el("previewName").textContent === "docs/multi.docx" &&
    el("previewNew").textContent.indexOf("[正文]") >= 0 &&
    el("previewNew").textContent.indexOf("word/document.xml") < 0 &&
    el("previewNew").textContent.indexOf("正文段落") >= 0 &&
    !!el("previewOrig").innerHTML, 15000);
  check("pv-docx 预览加载完成", docxPreview, "new=" + el("previewNew").textContent.slice(0, 60));
  check("pv-docx 命中词徽章", el("previewHits").children.length >= 2, "badges=" + el("previewHits").children.length);
  check("pv-docx 处理后已清掉命中词",
    el("previewNew").textContent.indexOf("内部") < 0 && el("previewNew").textContent.indexOf("机密") < 0,
    JSON.stringify(el("previewNew").textContent));
  check("pv-docx 处理后保留正文", el("previewNew").textContent.indexOf("正文段落") >= 0,
    JSON.stringify(el("previewNew").textContent));
  // 原文栏高亮必须标在同一行上：处理后栏清掉的位置，就是原文栏画 <mark> 的位置
  const origHtml = el("previewOrig").innerHTML;
  check("pv-docx 原文栏高亮命中词", origHtml.indexOf("<mark>") >= 0, "html=" + origHtml.slice(0, 80));
  check("pv-docx 高亮不含定位行", origHtml.indexOf("<mark>[") < 0, "html=" + origHtml.slice(0, 80));
  // 预览不得再向用户暴露包内部件路径
  check("pv-docx 页眉也显示在预览中", el("previewNew").textContent.indexOf("[页眉]") >= 0,
    JSON.stringify(el("previewNew").textContent));
  check("pv-docx 页眉命中同样已清掉", el("previewNew").textContent.indexOf("内部") < 0,
    JSON.stringify(el("previewNew").textContent));
  check("pv-docx 预览不暴露内部部件名", origHtml.indexOf("word/document.xml") < 0
    && el("previewNew").textContent.indexOf("word/document.xml") < 0, "html=" + origHtml.slice(0, 80));
}

/* ---- 6.24f 预览必须等于最终写出结果（自检兜底口径对齐） ----
   背景：真实处理在「处理后检查残留」开启（默认）时，会用全文口径对首尾范围之外的残留再清一遍；
   而预览此前只按用户所选范围渲染。实测一个中段命中的文本：预览「处理后」保留中段命中词，
   真实写出的文件里却被兜底清掉——预览与实际输出不一致，预览失去核对价值。
   修法：预览在自检开启且范围不是「全文」时，按「范围结果 vs 全文结果取命中更多者」渲染，
   并给出提示条说明兜底清了多少处。 */
{
  reloadApp();
  el("verifyAfter").checked = true;   // 默认开启自检兜底
  el("tidySpace").checked = false;
  const midBytes = new TextEncoder().encode("内部资料\n这是普通正文，含内部二字在中间\n结尾一行\n");
  change("fileInput", { target: { files: [fakeFile("docs/mid.txt", midBytes)], value: "" } });
  await waitFor(() => el("fileBody").children.length === 1, 15000);
  el("fileBody").children[0].click();
  const midOk = await waitFor(() => el("previewNew").textContent.length > 0, 15000);
  check("pv-verify 预览加载完成", midOk, el("previewNew").textContent.slice(0, 60));
  check("pv-verify 中段命中也被预览清掉（与写出结果一致）",
    el("previewNew").textContent.indexOf("内部") < 0,
    JSON.stringify(el("previewNew").textContent));
  check("pv-verify 预览提示条说明兜底清除",
    el("previewNote").hidden === false && /首尾范围外/.test(el("previewNote").textContent),
    "note=" + el("previewNote").textContent);

  // 关闭自检：预览只按范围渲染，中段保留——此时预览同样等于写出结果（不做兜底）
  el("verifyAfter").checked = false;
  change("verifyAfter", { target: el("verifyAfter") });
  const offOk = await waitFor(() => el("previewNew").textContent.length > 0
    && el("previewNote").hidden === true, 15000);
  check("pv-verify 关闭自检后预览保留中段（口径一致）",
    offOk && el("previewNew").textContent.indexOf("内部") >= 0,
    JSON.stringify(el("previewNew").textContent));
}

/* ---- 6.24g Office 路径同样对齐：首尾范围 + 自检 -> 中段命中在预览里也被清 ---- */
{
  reloadApp();
  el("verifyAfter").checked = true;
  const z = await D.DWRZip.pack([
    { name: "word/document.xml", data: "<w:document><w:body>" +
      "<w:p><w:t>内部</w:t></w:p><w:p><w:t>正文</w:t></w:p>" +
      "<w:p><w:t>机密</w:t></w:p><w:p><w:t>结尾</w:t></w:p>" +
      "</w:body></w:document>" },
  ]);
  const bytes = new Uint8Array(await z.arrayBuffer());
  change("fileInput", { target: { files: [fakeFile("docs/mid.docx", bytes)], value: "" } });
  await waitFor(() => el("fileBody").children.length === 1, 15000);
  el("fileBody").children[0].click();
  const docxOk = await waitFor(() => el("previewNew").textContent.indexOf("[正文]") >= 0, 15000);
  check("pv-verify Office 预览加载完成", docxOk, el("previewNew").textContent.slice(0, 60));
  check("pv-verify Office 中段命中也被预览清掉",
    el("previewNew").textContent.indexOf("机密") < 0 && el("previewNew").textContent.indexOf("内部") < 0,
    JSON.stringify(el("previewNew").textContent));
}
  /* v4.44 侧栏卡片分层门禁。
     v2.81 引入 .card-primary 后，仓库里陆续又加了七条 .card 规则。
     .card-primary 与 .card 特异性相同（单类 0,1,0），若写在前面，
     后定义的规则会用 border / box-shadow 简写把它的高亮重置掉——
     实测主卡与普通卡计算样式曾完全一致（都是 rgba(0,0,0,0.06)），
     v2.81 的主卡高亮形同虚设。
     真正该守的不变量是「特异性」，不是源码顺序：
       ① 主卡规则必须是 .panel-column .card-primary（0,2,0 > 0,1,0）；
       ② 深色下 html[data-theme="dark"] .card 同为 0,2,0，
          必须再用一级选择器把主卡规则提到 0,3,0；
       ③ 主卡与非主卡的标题条规则同样要高一级，且不得被 .card h2::before 覆盖。 */
  {
    const CSS = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
    const ls = CSS.split(/\r?\n/);
    const lineOf = (sel) => ls.findIndex((l) => l.trim() === sel);

    // ① 主卡规则必须带 .panel-column 前缀（特异性 0,2,0）
    const scoped = lineOf('.panel-column .card-primary {');
    check('v444-CSS 主卡规则带 .panel-column 前缀（特异性高于 .card）',
      scoped >= 0 && lineOf('.card-primary {') >= 0,
      'scoped@' + (scoped + 1));

    // ② 深色覆盖：html[data-theme="dark"] .card 是 0,2,0，
    //    主卡规则必须再加一级选择器变 0,3,0 才压得住
    const darkCard = lineOf('html[data-theme="dark"] .card {');
    const darkScoped = lineOf('html[data-theme="dark"] .panel-column .card-primary {');
    check('v444-CSS 深色主卡规则 specificity 高于深色 .card',
      darkCard >= 0 && darkScoped >= 0,
      'darkCard@' + (darkCard + 1) + ' darkScoped@' + (darkScoped + 1));

    // ③ 标题条分层：主卡渐变、其余中性灰，且都要比 .card h2::before 高一级
    const barScoped = lineOf('.panel-column .card-primary h2::before {');
    const barDim = ls.findIndex((l) =>
      l.indexOf('.panel-column section.card:not(.card-primary) h2::before') === 0);
    check('v444-CSS 主卡与非主卡标题条分层规则都在',
      barScoped >= 0 && barDim >= 0,
      'barPrimary@' + (barScoped + 1) + ' barDim@' + (barDim + 1));
    // 两条都必须以 .panel-column 开头（0,2,1 > 0,1,1）
    check('v444-CSS 标题条分层规则 specificity 高于 .card h2::before',
      barScoped >= 0 && barDim >= 0
        && ls[barScoped].trim().indexOf('.panel-column') === 0
        && ls[barDim].trim().indexOf('.panel-column') === 0,
      'barPrimary=' + (barScoped >= 0 ? ls[barScoped].trim() : '?')
        + ' barDim=' + (barDim >= 0 ? ls[barDim].trim() : '?'));

    // 反向口径：主卡规则里必须真的设了 border-color 与 box-shadow，
    // 只写选择器不写属性等于没分层
    const blk = [];
    for (let n = scoped; n >= 0 && n < ls.length; n++) {
      blk.push(ls[n]);
      if (n > scoped && ls[n].trim() === '}') break;
    }
    const txt = blk.join(String.fromCharCode(10));
    check('v444-CSS 主卡规则实际设置边框与投影',
      /border-color\s*:\s*var\(--brand-1\)/.test(txt) && /box-shadow\s*:/.test(txt),
      txt.slice(0, 160));
  }




/* =====================================================================
   以下 6.30 ~ 6.39 为 v2.71 事故丢失章节的重建（依据 HANDOVER-log 各批次
   验收记录与现行 app.js 实现重新编写）：报告导入全链路 / 重新甄别 / 互斥与
   中止 / 多报告队列 / 统计口径 / 加入即移出 archive 语义 / 内嵌计数 /
   目录记忆 / flash 引导与快捷键 / 全局不变量。
   ===================================================================== */

/** 构造「盘符根」目录桩：pathBytes 为 相对路径 -> 字节，支持一层子目录 */
function fakeDriveRoot(name, pathBytes) {
  const dirs = new Map();
  for (const [p, bytes] of pathBytes) {
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    const dirRel = i < 0 ? "" : p.slice(0, i);
    const fn = p.slice(i + 1);
    if (!dirs.has(dirRel)) dirs.set(dirRel, new Map());
    dirs.get(dirRel).set(fn, { n: fn, bytes });
  }
  const mkDirH = (dirRel) => ({
    kind: "directory", name: dirRel || name,
    /** 报告定位只走 getDirectoryHandle / getFileHandle；多位置扫描走 entries() / values()，
     *  这里一并补齐：列出本层「直接子文件 + 直接子目录」，两种流程都能覆盖 */
    entries() {
      const rows = [];
      for (const [fn, e] of (dirs.get(dirRel) || new Map())) {
        rows.push([fn, { kind: "file", name: fn, getFile: async () => fakeFile(fn, e.bytes) }]);
      }
      const prefix = dirRel ? dirRel + "\\" : "";
      const subs = new Set();
      for (const d of dirs.keys()) {
        if (d && d !== dirRel && d.startsWith(prefix) && d.indexOf("\\", prefix.length) < 0) subs.add(d);
      }
      for (const d of subs) rows.push([d.slice(prefix.length), mkDirH(d)]);
      let i = 0;
      return { next: async () => (i < rows.length ? { done: false, value: rows[i++] } : { done: true, value: undefined }) };
    },
    // values() 只给句柄（entries() 才给 [名字, 句柄] 对），collectFiles 走的是这一支
    values() {
      const handles = [];
      for (const [fn, e] of (dirs.get(dirRel) || new Map())) {
        handles.push({ kind: "file", name: fn, getFile: async () => fakeFile(fn, e.bytes) });
      }
      let i = 0;
      return { next: async () => (i < handles.length ? { done: false, value: handles[i++] } : { done: true, value: undefined }) };
    },
    async getDirectoryHandle(seg) {
      const next = dirRel ? dirRel + "\\" + seg : seg;
      if (!dirs.has(next)) throw new Error("NotFoundError: " + next);
      return mkDirH(next);
    },
    async getFileHandle(fn) {
      const d = dirs.get(dirRel);
      if (!d || !d.has(fn)) throw new Error("NotFoundError: " + fn);
      const e = d.get(fn);
      return {
        kind: "file",
        async getFile() { return fakeFile(fn, e.bytes); },
      };
    },
  });
  return mkDirH("");
}

/** 构造一个报告文件（JSON 清单，parseAny 按扩展名分发到 parseJsonList） */
function fakeReportFile(name, entries) {
  return fakeFile(name, new TextEncoder().encode(JSON.stringify({ meta: {}, files: entries })));
}

const impRow = (n) => el("scanBody").children[n];
const impRowCheck = (n) => impRow(n).children[0].children[0];

/* ---------------- 6.30 报告导入全链路：授权 -> 定位 -> 复检 -> 误报徽章 -> 隐藏 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const enc = (s) => new TextEncoder().encode(s);
  const root = fakeDriveRoot("C盘", new Map([
    ["工作\\涉密文件.txt", enc("本文件含内部资料，属机密范围。\n")],
    ["工作\\公开说明.txt", enc("本文件为公开信息，可以外发。\n")],
    ["资料\\旧版文档.pdf", enc("%PDF-1.4 fake")],
  ]));
  ctx.showDirectoryPicker = async () => root;
  const report = fakeReportFile("检查报告.json", [
    { file: "C:\\工作\\涉密文件.txt", hits: 3, matched: ["内部", "机密", "秘密"], size: 100 },
    { file: "C:\\工作\\公开说明.txt", hits: 1, matched: ["秘密"], size: 60 },
    { file: "C:\\资料\\旧版文档.pdf", hits: 2, matched: ["机密"], size: 4096 },
  ]);
  change("reportFile", { target: { files: [report], value: "" } });
  const impOk = await waitFor(() => /已导入 3 条/.test(logText()), 30000);
  check("imp-导入完成", impOk, logText().slice(-400));
  check("imp-解析与授权日志",
    /报告解析完成：检查报告\.json → 3 个文件（C:）/.test(logText())
      && /请选择 C: 盘根目录/.test(logText()) && /已授权 C:：/.test(logText()),
    logText().slice(-500));
  check("imp-导入摘要口径（未复检行不计入确认命中）",
    /已导入 3 条（检查软件报告命中 3 个）：已定位 3 个，其中 2 个格式支持已按当前词库复检——确认命中 1 个、误报 1 个/
      .test(logText()) && /1 个为暂不支持的格式/.test(logText()),
    logText().slice(-500));
  check("imp-扫描卡片汇总（确认命中 1 / 误报 1 已隐藏）",
    el("scanMeta").innerHTML.indexOf("确认命中 <b>1</b> 个") >= 0
      && el("scanMeta").innerHTML.indexOf("误报 <b>1</b> 个已隐藏") >= 0,
    el("scanMeta").innerHTML);
  // 默认隐藏误报：可见行 = 确认命中 + 未复检 = 2 行
  check("imp-误报默认隐藏后剩 2 行", el("scanBody").children.length === 2,
    "rows=" + el("scanBody").children.length);
  check("imp-确认命中行自动勾选", impRowCheck(0).checked === true,
    "checked=" + impRowCheck(0).checked);
  check("imp-未复检行不勾选并带未复检徽章",
    impRowCheck(1).checked === false && impRow(1).innerHTML.indexOf("未复检 2 处") >= 0,
    impRow(1).innerHTML.slice(0, 240));
  check("imp-隐藏误报开关已显示且勾选",
    el("scanHideFpWrap").style.display !== "none" && el("scanHideFp").checked === true,
    "wrap=" + el("scanHideFpWrap").style.display);
  // 取消隐藏：误报行现形，带「误报」徽章与 fp 弱化类
  el("scanHideFp").checked = false;
  click("scanHideFp");
  await waitFor(() => el("scanBody").children.length === 3, 10000);
  check("imp-取消隐藏后 3 行全可见", el("scanBody").children.length === 3,
    "rows=" + el("scanBody").children.length);
  const fpRow = impRow(1);
  check("imp-误报行带误报徽章与弱化类",
    fpRow.innerHTML.indexOf(">误报</span>") >= 0 && fpRow.className.indexOf("fp") >= 0,
    "cls=" + fpRow.className + " html=" + fpRow.innerHTML.slice(0, 200));
  check("imp-误报行已取消勾选", impRowCheck(1).checked === false,
    "checked=" + impRowCheck(1).checked);
  check("imp-误报徽章带检查软件原始命中数",
    /保密检查软件报告命中 1 处（秘密），按当前词库复检 0 命中/.test(fpRow.innerHTML),
    fpRow.innerHTML.slice(0, 260));
}

/* ---------------- 6.31 重新甄别：改词库后全部已定位行按新词库重查 ---------------- */
{
  // 沿用 6.30 的模块状态（同一份导入结果）。换词库：「公开」成为命中词
  click("clearRuleBtn");
  el("ruleInput").value = "公开";
  click("addRuleBtn");
  await waitFor(() => el("ruleChips").children.length === 1, 10000);
  const r0 = (logText().match(/重新甄别完成/g) || []).length;
  click("scanRescreenBtn");
  const rsOk = await waitFor(() => (logText().match(/重新甄别完成/g) || []).length > r0, 30000);
  check("rescreen-重新甄别可完成", rsOk, logText().slice(-300));
  check("rescreen-摘要按新词库重算（1 命中 1 误报）",
    /重新甄别完成：1 个命中，1 个误报。/.test(logText()),
    logText().slice(-300));
  // 重新甄别后误报重新隐藏：取消隐藏看全部 3 行（顺序 = 报告行序）
  el("scanHideFp").checked = false;
  click("scanHideFp");
  await waitFor(() => el("scanBody").children.length === 3, 10000);
  check("rescreen-原命中行翻转为误报并取消勾选",
    impRow(0).innerHTML.indexOf("涉密文件.txt") >= 0
      && impRow(0).innerHTML.indexOf(">误报</span>") >= 0 && impRowCheck(0).checked === false,
    impRow(0).innerHTML.slice(0, 200));
  check("rescreen-新命中行自动勾选",
    impRow(1).innerHTML.indexOf("公开说明.txt") >= 0 && impRowCheck(1).checked === true,
    impRow(1).innerHTML.slice(0, 200));
  check("rescreen-汇总刷新", el("scanMeta").innerHTML.indexOf("确认命中 <b>1</b> 个") >= 0,
    el("scanMeta").innerHTML);
}

/* ---------------- 6.32 导入互斥：进行中禁止扫描 / 重复导入，按钮联动 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const root = fakeDriveRoot("C盘", new Map([
    ["x\\a.txt", new TextEncoder().encode("内部资料\n")],
  ]));
  let releasePicker = null;
  ctx.showDirectoryPicker = () => new Promise((res) => { releasePicker = res; });
  const report = fakeReportFile("互斥报告.json", [
    { file: "C:\\x\\a.txt", hits: 1, matched: ["内部"], size: 20 },
  ]);
  change("reportFile", { target: { files: [report], value: "" } });
  const busy = await waitFor(() => releasePicker && el("importReportBtn").disabled === true
    && el("scanFolderBtn").disabled === true && el("stopScanBtn").disabled === false, 10000);
  check("mutex-导入进行中按钮联动", busy,
    "picker=" + !!releasePicker + " imp=" + el("importReportBtn").disabled);
  // 导入未完成时点扫描：被挡下且不产生新的扫描结果
  click("scanFolderBtn");
  check("mutex-扫描被互斥挡下", /报告导入 \/ 复检进行中/.test(logText()), logText().slice(-200));
  // 重复选择报告文件：同样被挡下
  change("reportFile", { target: { files: [report], value: "" } });
  check("mutex-重复导入被挡下", /上次导入 \/ 复检仍在进行/.test(logText()), logText().slice(-200));
  releasePicker(root);
  const relOk = await waitFor(() => /已导入 1 条/.test(logText())
    && el("importReportBtn").disabled === false, 30000);
  check("mutex-导入完成后按钮解禁", relOk && el("scanFolderBtn").disabled === false
    && el("stopScanBtn").disabled === true,
    "imp=" + el("importReportBtn").disabled + " scan=" + el("scanFolderBtn").disabled);
}

/* ---------------- 6.33 定位阶段中止：停止扫描立即生效，未定位行明确计数 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const root = fakeDriveRoot("C盘", new Map([
    ["y\\1.txt", new TextEncoder().encode("内部资料\n")],
  ]));
  const realGet = root.getDirectoryHandle.bind(root);
  let releaseDir = null;
  const held = new Promise((res) => { releaseDir = res; });
  // 第一层 getDirectoryHandle 挂起：定位循环停在第 1 个文件，留出点「停止」的时间窗
  root.getDirectoryHandle = (seg) => held.then(() => realGet(seg));
  ctx.showDirectoryPicker = async () => root;
  const report = fakeReportFile("中止报告.json", [
    { file: "C:\\y\\1.txt", hits: 1, matched: ["内部"], size: 10 },
    { file: "C:\\y\\2.txt", hits: 1, matched: ["机密"], size: 10 },
    { file: "C:\\y\\3.txt", hits: 1, matched: ["秘密"], size: 10 },
  ]);
  change("reportFile", { target: { files: [report], value: "" } });
  const authOk = await waitFor(() => /已授权 C:：/.test(logText()), 10000);
  check("abort-导入进入定位阶段", authOk, logText().slice(-200));
  click("stopScanBtn");
  check("abort-停止按钮有日志", /正在停止导入复检/.test(logText()), logText().slice(-200));
  releaseDir();
  const abOk = await waitFor(() => /定位已中止：剩余 2 个文件未定位/.test(logText()), 30000);
  check("abort-中止后明确计数", abOk, logText().slice(-400));
  // 中止后 importCancel 延续到复检阶段：已定位的 1 行不再复检（复检也中止），确认命中 0 个
  check("abort-已定位的行保留、复检随中止跳过",
    /已导入 3 条/.test(logText()) && /中止时未定位 2 个/.test(logText())
      && /复检已中止（完成 0\/1）：确认命中 0 个、误报 0 个/.test(logText())
      && /已定位 1 个/.test(logText()),
    logText().slice(-500));
}

/* ---------------- 6.34 一次导入多个报告：排队依次处理 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const root = fakeDriveRoot("C盘", new Map([
    ["q\\r1.txt", new TextEncoder().encode("内部资料\n")],
    ["q\\r2.txt", new TextEncoder().encode("机密文件\n")],
  ]));
  ctx.showDirectoryPicker = async () => root;
  const rep1 = fakeReportFile("报告一.json", [
    { file: "C:\\q\\r1.txt", hits: 1, matched: ["内部"], size: 15 },
  ]);
  const rep2 = fakeReportFile("报告二.json", [
    { file: "C:\\q\\r2.txt", hits: 1, matched: ["机密"], size: 15 },
  ]);
  change("reportFile", { target: { files: [rep1, rep2], value: "" } });
  const qOk = await waitFor(() => /已加入导入队列：共 2 个报告文件/.test(logText()), 10000);
  check("queue-多报告入队日志", qOk, logText().slice(-200));
  const bothOk = await waitFor(() => (logText().match(/已导入 1 条/g) || []).length >= 2, 30000);
  check("queue-两个报告依次导入", bothOk, logText().slice(-400));
  check("queue-两份报告的行都在表中", el("scanBody").children.length === 2,
    "rows=" + el("scanBody").children.length);
}

/* ---------------- 6.35 统计口径：复检失败显式报错、未复检不计、JSON 摘要 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const root = fakeDriveRoot("C盘", new Map([
    ["z\\命中.txt", new TextEncoder().encode("内部资料\n")],
    ["z\\误报.txt", new TextEncoder().encode("公开内容\n")],
    ["z\\损坏.docx", new TextEncoder().encode("不是真的 docx")],
  ]));
  ctx.showDirectoryPicker = async () => root;
  const report = fakeReportFile("口径报告.json", [
    { file: "C:\\z\\命中.txt", hits: 2, matched: ["内部"], size: 15 },
    { file: "C:\\z\\误报.txt", hits: 1, matched: ["秘密"], size: 15 },
    { file: "C:\\z\\损坏.docx", hits: 4, matched: ["机密", "绝密"], size: 20 },
    { file: "C:\\z\\缺失.pdf", hits: 1, matched: ["机密"], size: 30 },
  ]);
  change("reportFile", { target: { files: [report], value: "" } });
  const impOk = await waitFor(() => /已导入 4 条/.test(logText()), 30000);
  check("std-导入完成", impOk, logText().slice(-500));
  // 损坏.docx：扩展名受支持但内容解析失败 -> 复检失败要显式报错，不能静默吞掉
  check("std-复检失败显式报错",
    /复检失败（暂按检查软件原报告处理）：C:\\z\\损坏\.docx/.test(logText())
      && /1 个复检失败/.test(logText()),
    logText().slice(-600));
  check("std-未定位行计数（缺失.pdf 磁盘上没有）", /磁盘上未找到 1 个/.test(logText()),
    logText().slice(-400));
  // 复检失败行保持勾选、按检查软件原结论列出（不擅自改判）
  const brokenRow = el("scanBody").children.map((r) => r.innerHTML)
    .find((h) => h.indexOf("损坏.docx") >= 0);
  check("std-复检失败行标未复检并保留原命中数",
    !!brokenRow && brokenRow.indexOf("未复检 4 处") >= 0,
    JSON.stringify(brokenRow && brokenRow.slice(0, 200)));
  // JSON 摘要口径：meta 带检查软件报告命中 / 复检误报，命中文件数只计确认命中
  ctx.__lastBlob = null;
  click("scanReportJsonBtn");
  const jt = ctx.__lastBlob ? JSON.parse(await ctx.__lastBlob.text()) : null;
  check("std-JSON 摘要含检查软件口径",
    !!jt && jt.meta["检查软件报告命中"] === 4 && jt.meta["复检误报（本工具 0 命中）"] === 1,
    JSON.stringify(jt && jt.meta));
  check("std-JSON 命中文件数只计确认命中",
    !!jt && jt.meta["命中文件数"] === 1 && jt.meta["读取失败"] === 1,
    JSON.stringify(jt && jt.meta));
  check("std-JSON 明细含全部 4 行（archive 不随显示过滤）",
    !!jt && Array.isArray(jt.files) && jt.files.length === 4,
    "files=" + (jt && jt.files && jt.files.length));
}

/* ---------------- 6.36 加入即移出：表格行移出、报告 archive 保留全量 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  ctx.showDirectoryPicker = async () => {
    const list = [
      fakeFile("a.txt", new TextEncoder().encode("内部资料 首行\n正文\n")),
      fakeFile("b.txt", new TextEncoder().encode("机密文件 首行\n正文\n")),
    ].map((f) => [f.name, { kind: "file", getFile: async () => f }]);
    let i = 0;
    return {
      kind: "directory", name: "join",
      entries: () => ({ next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true, value: undefined }) }),
    };
  };
  click("scanFolderBtn");
  await waitFor(() => /文件夹扫描完成/.test(logText()) && el("scanBody").children.length === 2, 30000);
  // 两行默认全选：整批加入 -> 行全部移出，文件列表 +2
  click("addScanToFiles");
  await waitFor(() => el("fileBody").children.length === 2, 15000);
  check("join-加入后文件列表新增 2 个", el("fileBody").children.length === 2,
    "rows=" + el("fileBody").children.length);
  check("join-扫描表清空并显示已加入空态",
    /命中的都已加入处理列表/.test(el("scanBody").innerHTML),
    el("scanBody").innerHTML.slice(0, 160));
  check("join-加入后加入按钮禁用", el("addScanToFiles").disabled === true,
    "disabled=" + el("addScanToFiles").disabled);
  // 关键取舍：报告数据源（archive）不受「加入」影响，仍可导出全量命中清单
  check("join-报告按钮仍可用", el("scanReportBtn").disabled === false
    && el("scanReportJsonBtn").disabled === false,
    "csv=" + el("scanReportBtn").disabled);
  ctx.__lastBlob = null;
  click("scanReportJsonBtn");
  const jt = ctx.__lastBlob ? JSON.parse(await ctx.__lastBlob.text()) : null;
  check("join-报告仍含全部 2 条命中",
    !!jt && jt.files.length === 2 && jt.meta["命中文件数"] === 2,
    JSON.stringify(jt && jt.meta));
  // 行内「加入」：单行操作不依赖勾选（先清空文件列表，避免 addFiles 按路径去重挡下）
  click("clearBtn");
  await waitFor(() => el("fileBody").children.length === 0, 10000);
  check("v476-清空后重新禁用开始处理并回到添加步骤",
    el("runBtn").disabled === true && el("flowAdd").className.indexOf("is-current") >= 0,
    "disabled=" + el("runBtn").disabled + " flow=" + el("flowAdd").className);
  const done2 = (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => (logText().match(/文件夹扫描完成/g) || []).length > done2
    && el("scanBody").children.length === 2, 30000);
  const addBtn = impRow(0).children[impRow(0).children.length - 1].children[0];
  addBtn.dispatch("click", { target: addBtn, stopPropagation() {} });
  await waitFor(() => el("scanBody").children.length === 1, 10000);
  check("join-行内加入移出该行", el("scanBody").children.length === 1,
    "rows=" + el("scanBody").children.length);
  check("join-行内加入日志", /已将 1 个命中文档加入处理列表并移出扫描结果（剩余 1 项）/.test(logText()),
    logText().slice(-200));
}

/* ---------------- 6.37 内嵌文档计入扫描命中 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const inner = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/sharedStrings.xml", data: "<sst><si><t>内部资料</t></si></sst>" },
  ]);
  const outer = await D.DWRZip.pack([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: "<w:document><w:body><w:p><w:t>内部资料</w:t></w:p></w:body></w:document>" },
    { name: "word/embeddings/inner.xlsx", data: new Uint8Array(await inner.arrayBuffer()) },
  ]);
  const outerBytes = new Uint8Array(await outer.arrayBuffer());
  ctx.showDirectoryPicker = async () => {
    const f = fakeFile("embed.docx", outerBytes);
    const list = [[f.name, { kind: "file", getFile: async () => f }]];
    let i = 0;
    return {
      kind: "directory", name: "embed",
      entries: () => ({ next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true, value: undefined }) }),
    };
  };
  click("scanFolderBtn");
  const ok = await waitFor(() => /文件夹扫描完成/.test(logText())
    && /命中 1 个文档 \/ 2 处敏感词/.test(logText()), 30000);
  check("embed-内嵌文档命中计入扫描", ok, logText().slice(-300));
  check("embed-单行显示 2 处",
    el("scanBody").children.length === 1 && /2 处/.test(el("scanBody").children[0].innerHTML),
    el("scanBody").children[0] ? el("scanBody").children[0].innerHTML.slice(0, 160) : "no row");
}

/* ---------------- 6.38 目录记忆：IndexedDB 复用 / 清除后重新询问 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  // 最小 IndexedDB 桩：覆盖 dirCacheGet / Put / Del / Clear 用到的 API 形状。
  // 真实 IDB 的事务完成回调挂在 tx 上：tx.oncomplete 由事务对象自己在下一跳触发，
  // objectStore 的 put/delete/clear 返回的请求对象与它无关（app 只监听 tx.oncomplete）
  const store = new Map();
  const doneReq = (result) => {
    const r = { result, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
    return r;
  };
  ctx.indexedDB = {
    open() {
      const r = { result: undefined, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      setTimeout(() => {
        r.result = {
          createObjectStore() {},
          transaction() {
            // 事务对象自身同时带 objectStore() 与事件回调——app 在 transaction() 的返回值上
            // 挂 tx.oncomplete，桩必须在同一个对象上触发它（拆成两个对象回调就永远不响）
            const tx = {
              oncomplete: null, onerror: null, onabort: null,
              objectStore() {
                return {
                  get(k) { return doneReq(store.has(k) ? store.get(k) : undefined); },
                  put(v, k) { store.set(k, v); return {}; },
                  delete(k) { store.delete(k); return {}; },
                  clear() { store.clear(); return {}; },
                };
              },
            };
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
          },
        };
        if (r.onupgradeneeded) r.onupgradeneeded({});
        if (r.onsuccess) r.onsuccess();
      }, 0);
      return r;
    },
  };
  let pickerCalls = 0;
  ctx.showDirectoryPicker = async () => {
    pickerCalls++;
    const f = fakeFile("a.txt", new TextEncoder().encode("内部资料 首行\n正文\n"));
    const list = [[f.name, { kind: "file", getFile: async () => f }]];
    let i = 0;
    return {
      kind: "directory", name: "mem-root",
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      entries: () => ({ next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true, value: undefined }) }),
    };
  };
  const scans = () => (logText().match(/文件夹扫描完成/g) || []).length;
  click("scanFolderBtn");
  await waitFor(() => scans() >= 1, 30000);
  check("dir-首次扫描弹出选择框", pickerCalls === 1, "calls=" + pickerCalls);
  click("scanFolderBtn");
  await waitFor(() => scans() >= 2, 30000);
  check("dir-第二次零点击复用", pickerCalls === 1 && /已复用上次扫描的文件夹/.test(logText()),
    "calls=" + pickerCalls);
  click("clearDirMemBtn");
  await waitFor(() => /已清除记住的目录/.test(logText()), 10000);
  check("dir-清除记忆有日志", /已清除记住的目录/.test(logText()), logText().slice(-200));
  click("scanFolderBtn");
  await waitFor(() => scans() >= 3, 30000);
  check("dir-清除后重新询问授权", pickerCalls === 2, "calls=" + pickerCalls);
}

/* ---------------- 6.39 flash 引导与快捷键（Ctrl+Enter / Esc） ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  change("fileInput", {
    target: { files: [fakeFile("docs/k.txt", new TextEncoder().encode("内部 首行\n正文\n"))], value: "" },
    value: "",
  });
  await waitFor(() => el("fileBody").children.length === 1, 15000);
  const kd = (o) => documentStub.dispatch("keydown", Object.assign({ preventDefault() {}, stopPropagation() {} }, o));
  // Ctrl+Enter 直接开始处理
  const done0 = (logText().match(/处理完成/g) || []).length;
  kd({ key: "Enter", ctrlKey: true, target: { tagName: "BODY" } });
  const runOk = await waitFor(() => (logText().match(/处理完成/g) || []).length > done0, 60000);
  check("kbd-Ctrl+Enter 直接开始处理", runOk, logText().slice(-200));
  // 处理完成后「导出记录」闪现引导（flash 类出现随后自动移除）
  const flashed = el("reportBtn").className.indexOf("flash") >= 0;
  const flashGone = await waitFor(() => el("reportBtn").className.indexOf("flash") < 0, 6000);
  check("flash-处理后导出按钮闪现", flashed, "cls=" + el("reportBtn").className);
  check("flash-闪现自动恢复", flashGone, "cls=" + el("reportBtn").className);
  // Esc 收起扫描结果卡片
  el("scanResultCard").style.display = "block";
  kd({ key: "Escape", target: { tagName: "BODY" } });
  check("kbd-Esc 收起扫描结果卡片", el("scanResultCard").style.display === "none",
    "display=" + el("scanResultCard").style.display);
}

/* ---------------- 6.40 多位置挑选：扫描所有存储 / 添加所有存储 / 盘符快选 ----------------
   v2.89-v2.91 引入的「连续选 + 列表确认 + 一次执行」流程此前零覆盖，
   而它正是 v2.94 精简重构（pickAddLocation / pickLine / renderPick 共用底座）改动最大的部分。 */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const enc = (s) => new TextEncoder().encode(s);
  const rootA = fakeDriveRoot("A盘", new Map([["p\\a.txt", enc("内部资料\n")]]));
  const rootB = fakeDriveRoot("B盘", new Map([["q\\b.txt", enc("机密内容\n")]]));

  // 选择器可编程：每次调用按队列返回一个句柄，抛错则模拟取消 / 未授权
  let pickerQueue = [];
  ctx.showDirectoryPicker = async () => {
    const item = pickerQueue.shift();
    if (item instanceof Error) throw item;
    if (!item) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return item;
  };
  const abortErr = () => Object.assign(new Error("user aborted"), { name: "AbortError" });
  const denyErr = () => Object.assign(new Error("denied"), { name: "NotAllowedError" });
  const scanDone = () => (logText().match(/全部位置扫描完成/g) || []).length;
  const rows = () => el("scanBody").children.length;

  // —— 扫描所有存储：入口即弹选择器，选中后进入挑选态且开始按钮解禁 ——
  pickerQueue = [rootA];
  click("scanDrivesBtn");
  const entOk = await waitFor(() => /已加入扫描列表：A盘/.test(logText()), 10000);
  check("pick-扫描入口自动弹出选择器并加入", entOk, logText().slice(-200));
  check("pick-挑选行可见且开始按钮解禁",
    el("drivePickRow").style.display === "flex" && el("driveStartBtn").disabled === false,
    "row=" + el("drivePickRow").style.display + " disabled=" + el("driveStartBtn").disabled);
  check("pick-挑选态禁用两个入口按钮",
    el("scanFolderBtn").disabled === true && el("scanDrivesBtn").disabled === true,
    "folder=" + el("scanFolderBtn").disabled + " drives=" + el("scanDrivesBtn").disabled);
  check("pick-提示显示已选位置",
    /已选 1 个位置：A盘/.test(el("drivePickHint").textContent), el("drivePickHint").textContent);

  // —— 重复选同一个位置：不重复入列，给出提示 ——
  pickerQueue = [rootA];
  click("driveAddBtn");
  await waitFor(() => /已经在列表里/.test(logText()), 10000);
  check("pick-重复位置不重复入列",
    /已经在列表里/.test(logText()) && /已选 1 个位置/.test(el("drivePickHint").textContent),
    el("drivePickHint").textContent);

  // —— 取消选择：静默返回，列表不变 ——
  pickerQueue = [abortErr()];
  click("driveAddBtn");
  await new Promise((r) => setTimeout(r, 60));
  check("pick-取消选择不报错也不入列",
    el("drivePickHint").textContent.indexOf("已选 1 个位置") >= 0
      && !/选择目录失败/.test(logText()),
    el("drivePickHint").textContent + " | " + logText().slice(-160));

  // —— 加入第二个位置后开始扫描：两个位置都扫到，列表被清空、挑选行收起 ——
  pickerQueue = [rootB];
  click("driveAddBtn");
  await waitFor(() => /已加入扫描列表：B盘/.test(logText()), 10000);
  check("pick-第二个位置入列", el("drivePickHint").textContent.indexOf("已选 2 个位置") >= 0,
    el("drivePickHint").textContent);
  click("driveStartBtn");
  const mulOk = await waitFor(() => scanDone() >= 1, 30000);
  check("pick-多位置一次扫描完成", mulOk && /共检查 2 个文件/.test(logText()), logText().slice(-260));
  check("pick-命中行来自两个位置", rows() === 2, "rows=" + rows());
  check("pick-扫描后清空列表并收起挑选行",
    el("drivePickRow").style.display === "none" && el("driveStartBtn").disabled === true,
    "row=" + el("drivePickRow").style.display + " disabled=" + el("driveStartBtn").disabled);
  check("pick-扫描后入口按钮解禁",
    el("scanFolderBtn").disabled === false && el("scanDrivesBtn").disabled === false,
    "folder=" + el("scanFolderBtn").disabled + " drives=" + el("scanDrivesBtn").disabled);
  check("pick-扫描结果可导出（lastScan 已落地）",
    el("scanReportBtn").disabled === false && el("scanReportJsonBtn").disabled === false,
    "csv=" + el("scanReportBtn").disabled + " json=" + el("scanReportJsonBtn").disabled);
  // scanMeta 与文件夹扫描同口径（只报总数）；逐位置明细在日志里
  check("pick-扫描元信息与日志口径一致",
    /扫描完成：共检查 <b>2<\/b> 个文件/.test(el("scanMeta").innerHTML)
      && /全部位置扫描完成（2 个位置）/.test(logText()),
    el("scanMeta").innerHTML + " | " + logText().slice(-200));

  // —— 盘符快选：面板按盘符建按钮；点一个等价于选该盘根目录 ——
  click("scanDrivesBtn");
  await waitFor(() => el("scanDrivesBtn").disabled === true, 5000);
  click("driveQuickBtn");
  // 面板由 app 动态建成并插入 drivePickRow 之后，与真实 DOM 一样在文档树里可查
  const panel = treeById("driveQuickPanel");
  check("quick-盘符快选面板已插入", !!panel && panel.children.length === 2,
    panel ? "children=" + panel.children.length : "no panel");
  const letters = panel && panel.children[1] ? panel.children[1].children.map((b) => b.textContent) : [];
  check("quick-盘符按钮 D: 到 Z:", letters.length === 23 && letters[0] === "D:" && letters[22] === "Z:",
    JSON.stringify(letters.slice(0, 3)) + "…" + JSON.stringify(letters.slice(-2)));

  // 点 D: 按钮 -> 直接选 D 盘根目录入列（不再单独弹「先选盘」的提示）
  const dBtn = panel.children[1].children[0];
  pickerQueue = [rootA];
  dBtn.click();
  const quickOk = await waitFor(() => /已加入：A盘/.test(logText()), 10000);
  check("quick-点盘符按钮直接加入该盘", quickOk, logText().slice(-200));
  check("quick-加入后开始按钮解禁", el("driveStartBtn").disabled === false,
    "disabled=" + el("driveStartBtn").disabled);

  // —— 盘符快选取消：保留原有「已取消或未授权选择 D 盘」日志 ——
  pickerQueue = [denyErr()];
  panel.children[1].children[0].click();
  await waitFor(() => /已取消或未授权选择 D 盘/.test(logText()), 10000);
  check("quick-取消 / 未授权有明确日志", /已取消或未授权选择 D 盘/.test(logText()), logText().slice(-200));

  // —— 面板已存在时再点：折叠 / 展开切换 ——
  const shown = panel.style.display;
  click("driveQuickBtn");
  check("quick-再点一次折叠面板", panel.style.display !== shown,
    "shown=" + shown + " now=" + panel.style.display);
}

/* ---------------- 6.41 添加所有存储：一次挑多个盘 / 目录批量加入处理列表 ---------------- */
{
  reloadApp();
  await waitFor(() => el("ruleChips").children.length >= 3, 15000);
  const enc = (s) => new TextEncoder().encode(s);
  // 放在盘根直下：collectFiles 只递归目录，不关心层级；这样 3 个文件一列到底
  const rootA = fakeDriveRoot("A盘", new Map([["a.txt", enc("内部资料\n")], ["c.txt", enc("机密\n")]]));
  const rootB = fakeDriveRoot("B盘", new Map([["b.txt", enc("秘密\n")]]));
  let pickerQueue = [];
  ctx.showDirectoryPicker = async () => {
    const item = pickerQueue.shift();
    if (!item) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return item;
  };
  const fileRows = () => el("fileBody").children.length;

  // 入口：自动弹选择器并进入挑选态，入口按钮被禁用
  pickerQueue = [rootA, rootB];
  click("addDrivesBtn");
  const entOk = await waitFor(() => /已加入列表：A盘/.test(logText()), 10000);
  check("add-入口自动弹出并加入第一个位置", entOk, logText().slice(-200));
  check("add-挑选行可见且入口按钮禁用",
    el("addPickRow").style.display === "flex" && el("addDrivesBtn").disabled === true,
    "row=" + el("addPickRow").style.display + " disabled=" + el("addDrivesBtn").disabled);

  // 继续添加：第二个位置入列，开始按钮解禁
  click("addPickAddBtn");
  await waitFor(() => /已加入列表：B盘/.test(logText()), 10000);
  check("add-继续添加第二个位置", /已选 2 个位置/.test(el("addPickHint").textContent),
    el("addPickHint").textContent);
  check("add-开始按钮解禁", el("addPickStartBtn").disabled === false,
    "disabled=" + el("addPickStartBtn").disabled);

  // 重复位置：不重复入列
  pickerQueue = [rootA];
  click("addPickAddBtn");
  await waitFor(() => /已经在列表里/.test(logText()), 10000);
  check("add-重复位置不重复入列", /已选 2 个位置/.test(el("addPickHint").textContent),
    el("addPickHint").textContent);

  // 一次加入：两个位置的文件全部进入处理列表，挑选行收起、入口按钮解禁
  click("addPickStartBtn");
  const joinOk = await waitFor(() => fileRows() === 3, 20000);
  check("add-两个位置的文件全部加入处理列表", joinOk, "rows=" + fileRows());
  check("add-加入后收起挑选行并解禁入口",
    el("addPickRow").style.display === "none" && el("addDrivesBtn").disabled === false,
    "row=" + el("addPickRow").style.display + " disabled=" + el("addDrivesBtn").disabled);
  check("add-汇总显示 3 个文件", /共 <b>3<\/b> 个文件/.test(el("fileSummary").innerHTML),
    el("fileSummary").innerHTML);

  // 未支持环境：入口直接报错，不进入挑选态
  delete ctx.showDirectoryPicker;
  click("addDrivesBtn");
  check("add-无目录选择 API 时明确报错",
    /当前环境不支持目录选择/.test(logText()) && el("addPickRow").style.display !== "flex",
    "row=" + el("addPickRow").style.display + " | " + logText().slice(-160));
  click("scanDrivesBtn");
  check("unsup-扫描入口同样明确报错且不进入挑选态",
    /当前环境不支持目录扫描/.test(logText()) && el("drivePickRow").style.display !== "flex",
    "row=" + el("drivePickRow").style.display + " | " + logText().slice(-160));
}

/* ---------------- 6.9h v3.5 场景预设 + 按命中词分组 ---------------- */
{
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');

  // 场景预设：控件在场、四个内置场景齐全、applyPreset 一次写全八项
  const presetIds = ['presetSel', 'presetRow'];
  check('v35-场景预设控件在场',
    presetIds.every((id) => new RegExp('id="' + id + '"').test(HTML)),
    'missing=' + presetIds.filter((id) => !HTML.includes('id="' + id + '"')).join(','));
  const presetVals = ['internal', 'secret', 'preview', 'handover'];
  check('v35-四个内置场景齐全',
    presetVals.every((v) => HTML.includes('value="' + v + '"')),
    'missing=' + presetVals.filter((v) => !HTML.includes('value="' + v + '"')).join(','));
  check('v35-预设与标签均有悬停说明',
    /<select id="presetSel"[^>]*data-tip=/.test(HTML) && /<label class="preset-lbl"[^>]*data-tip=/.test(HTML),
    'preset 缺少 data-tip');
  check('v35-applyPreset 一次设全八项',
    APP.indexOf('function applyPreset(key)') >= 0
    && ['scope', 'action', 'outmode', 'tidySpace', 'onlyChanged', 'backup', 'verifyAfter']
      .every((k) => APP.indexOf("setRadio('" + k + "'") >= 0 || APP.indexOf("$('" + k + "').checked") >= 0),
    'applyPreset 未覆盖全部选项');
  check('v35-手动改动回退到自定义',
    APP.indexOf("presetSel.value = ''") >= 0,
    '未在手动改动时重置预设下拉');
  check('v35-预设样式已落地',
    CSS.indexOf('.preset-row') >= 0 && CSS.indexOf('.preset-lbl') >= 0,
    'preset 样式缺失');

  // 按命中词分组：命中词渲染成可点按钮 + 事件委托 + 批量选中
  check('v35-命中词列改为可点按钮',
    APP.indexOf('function scanWordsCell(r)') >= 0
    && APP.indexOf('scanWordsCell(r)') >= 0
    && APP.indexOf('class="kw-btn"') >= 0,
    'scanWordsCell 未落地');
  check('v35-命中词点击用事件委托',
    APP.indexOf("scanBodyEl.addEventListener('click'") >= 0
    && APP.indexOf("t.className !== 'kw-btn'") >= 0,
    '缺少 kw-btn 事件委托');
  check('v35-按词批量选中与计数',
    APP.indexOf('function scanRowsWithWord(w)') >= 0
    && APP.indexOf('function selectScanByWord(w, on)') >= 0,
    'selectScanByWord 缺失');
  check('v35-命中词表头说明可点击',
    /<th scope="col" data-tip="[^"]*点其中一个词/.test(HTML),
    '表头未说明可点击');
  check('v35-命中词胶囊样式与焦点环',
    CSS.indexOf('.kw-btn') >= 0 && CSS.indexOf('.words-cell') >= 0
    && /\.kw-btn:focus-visible/.test(CSS),
    'kw-btn 样式或焦点环缺失');
}
/* ---------------- 6.9i v3.6 HTML 检查报告 ---------------- */
{
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const RH = fs.readFileSync(path.join(__dirname, 'js', 'reporthtml.js'), 'utf8');
  const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

  check('v36-reporthtml 模块在场且语法自洽',
    RH.indexOf('root.DWRReportHtml') >= 0 && RH.indexOf('function build(o)') >= 0,
    'DWRReportHtml 未导出');
  check('v36-已接入页面与预缓存',
    HTML.indexOf('js/reporthtml.js') >= 0 && SW.indexOf('./js/reporthtml.js') >= 0,
    'reporthtml.js 未接入');
  check('v36-两个 HTML 导出入口均有悬停说明',
    /<button[^>]*id="scanReportHtmlBtn"[^>]*data-tip=/.test(HTML)
    && /<button[^>]*id="reportHtmlBtn"[^>]*data-tip=/.test(HTML),
    'HTML 导出按钮缺少 data-tip');
  check('v36-导出函数与 CSV 版同源',
    APP.indexOf('function exportScanReportHtml()') >= 0
    && APP.indexOf('function exportCleanReportHtml()') >= 0
    && APP.indexOf('DWRReportHtml.build(') >= 0,
    'HTML 导出函数缺失');
  check('v36-禁用态与 CSV 按钮联动',
    APP.indexOf("$('scanReportHtmlBtn')") >= 0
    && APP.indexOf("$('reportHtmlBtn')") >= 0,
    'HTML 按钮禁用态未同步');
  check('v36-下载用 text/html 类型',
    (APP.match(/new Blob\(\[html\], \{ type: 'text\/html' \}\)/g) || []).length === 2,
    'HTML Blob 类型不对');

  // 真正跑一遍渲染：校验结构、转义与状态标签
  const sandbox = {};
  (new Function('window', RH))(sandbox);
  const doc = sandbox.DWRReportHtml.build({
    title: '扫描报告<script>',
    generatedAt: '2026-10-11 12:00',
    summary: [['文件总数', 3]],
    rows: [
      { file: 'docs/a.docx', hits: 2, matched: ['机密', '内部'], status: 'done' },
      { file: 'docs/b.txt', hits: 1, matched: ['秘密'], status: 'hit' },
      { file: 'docs/c.pdf', hits: 0, matched: [], status: 'error' }
    ]
  });
  check('v36-渲染出完整 A4 单页',
    doc.indexOf('<!DOCTYPE html>') === 0 && doc.indexOf('</html>') > 0
    && doc.indexOf('@media print') >= 0 && doc.indexOf('<caption>明细（3 条）</caption>') >= 0,
    '结构不完整');
  check('v36-标题与路径均转义（无 XSS）',
    doc.indexOf('扫描报告&lt;script&gt;') >= 0 && doc.indexOf('<script>') < 0,
    '未转义');
  check('v36-三种状态徽章齐全',
    doc.indexOf('t-ok') >= 0 && doc.indexOf('t-hit') >= 0 && doc.indexOf('t-err') >= 0,
    '状态徽章缺失');
  check('v36-空 rows 不崩',
    sandbox.DWRReportHtml.build({ title: '空', rows: [] }).indexOf('无记录') >= 0,
    '空 rows 未兜底');
}

/* ---------------- 6.9j v3.7 个人信息模板 + 智能打码 ---------------- */
{
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const RULES = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');

  check('v37-个人信息模板按钮在场且带悬停说明',
    /<button[^>]*id="piiPresetBtn"[^>]*data-tip=/.test(HTML),
    'piiPresetBtn 缺失或无 data-tip');
  check('v37-智能打码动作选项更新',
    HTML.indexOf('智能打码') >= 0 && HTML.indexOf('替换为 ***') < 0,
    'mask 选项文案未更新');
  check('v37-PII 预设场景在场',
    HTML.indexOf('value="pii"') >= 0 && HTML.indexOf('个人信息 · 智能打码') >= 0,
    'pii 场景缺失');
  check('v37-引擎支持规则中文名',
    RULES.indexOf('PII_PRESETS') >= 0 && APP.indexOf('label: p.label') >= 0,
    'PII_PRESETS 或 label 透传缺失');
  check('v37-模板加载函数在场',
    APP.indexOf('function loadPiiPresets()') >= 0
      && APP.indexOf("loadPiiPresets") >= 0,
    'loadPiiPresets 缺失');
  check('v37-选 pii 预设自动补模板词',
    APP.indexOf("key === 'pii'") >= 0 && APP.indexOf('已自动加入个人信息模板') >= 0,
    'pii 预设未自动补词');
  check('v37-chip 显示中文名',
    APP.indexOf("r.label && r.type === 'regex'") >= 0,
    'chip 未显示 label');
  check('v37-智能打码星数按内容长度',
    RULES.indexOf('function smartMask(t)') >= 0 && RULES.indexOf('function stars(n)') >= 0,
    'smartMask 缺失');

  // 真实点击：个人信息模板按钮 → 词库加 5 条 PII 规则 → 二次点击提示已存在
  const rulesBefore = el('ruleChips').children.length;
  click('piiPresetBtn');
  check('v37-点击后词库加 5 条 PII 规则',
    el('ruleChips').children.length === rulesBefore + 5,
    'before=' + rulesBefore + ' after=' + el('ruleChips').children.length);
  check('v37-日志提示模板已加入',
    /已加入个人信息模板 5 条/.test(logText()),
    logText().slice(-200));
  const savedRules = JSON.parse(storage.get('dwr.settings.v2')).rules;
  check('v37-PII 规则已持久化且带中文名',
    savedRules.filter((r) => r.label && r.type === 'regex').length >= 5
      && savedRules.some((r) => r.label === '手机号'),
    JSON.stringify(savedRules.filter((r) => r.label).map((r) => r.label)));
  click('piiPresetBtn');
  check('v37-重复点击提示已存在不重复添加',
    el('ruleChips').children.length === rulesBefore + 5
      && /个人信息模板已全部在词库中/.test(logText()),
    'chips=' + el('ruleChips').children.length + ' log=' + logText().slice(-150));

  // 预设参数静态校验：scope/action/outmode 与文案（切换行为已由 v35 的 applyPreset 断言覆盖）
  check('v37-pii 预设参数为全文 + 智能打码 + ZIP',
    APP.indexOf("pii: {") >= 0
      && APP.indexOf("scope: 'all', action: 'mask', outmode: 'zip'") >= 0,
    'pii 预设参数缺失');
}
/* ---------------- 6.9k v3.8 报告增强：结论先行 + 证据分级 + Evidence + 局限 ---------------- */
{
  const RH = fs.readFileSync(path.join(__dirname, 'js', 'reporthtml.js'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');

  check('v38-reporthtml 支持结论先行',
    RH.indexOf('function levelTag(kind)') >= 0 && RH.indexOf('var conclusion = o.conclusion') >= 0,
    'conclusion / levelTag 缺失');
  check('v38-概要表带分级与依据',
    RH.indexOf("var kind = kv[2] || 'obs'") >= 0 && RH.indexOf('class="ev"') >= 0,
    'kind / evidence 渲染缺失');
  check('v38-默认局限清单在场',
    RH.indexOf('DEFAULT_LIMITS') >= 0 && RH.indexOf('ul class="limits"') >= 0,
    '局限声明缺失');
  check('v38-scanSummary 已标分级与依据',
    APP.indexOf("['已检查文件数', s.scanned, 'obs',") >= 0
      && APP.indexOf("['结果完整', s.truncated ? '否（已达上限）' : '是', 'der',") >= 0,
    'scanSummary 未标分级');
  check('v38-扫描报告传入结论',
    APP.indexOf('var s0 = state.lastScan;') >= 0 && APP.indexOf('conclusion: concl,') >= 0,
    '扫描报告未传 conclusion');
  check('v38-清除报告传入结论与分级',
    APP.indexOf("'obs',") >= 0 && APP.indexOf('conclusion:') >= 0,
    '清除报告未标分级');

  // 真跑渲染：结论块、三种徽章、依据灰字、局限清单都在
  const sandbox = {};
  (new Function('window', RH))(sandbox);
  const doc = sandbox.DWRReportHtml.build({
    title: '扫描报告',
    generatedAt: '2026-10-12 10:00',
    conclusion: '本次扫描检查了 47 个文件，其中 12 个命中、共 31 处。',
    summary: [
      ['已检查文件数', 47, 'obs', '本次扫描实际读取的文件数'],
      ['命中文件数', 12, 'obs', '扫描中命中规则的文件数'],
      ['结果完整', '是', 'der', '与文件数上限比较得出'],
      ['建议处理', '勾选后一键处理', 'inf', '需人工确认'],
    ],
    rows: [{ file: 'docs/a.docx', hits: 3, matched: ['内部'], status: 'hit' }],
  });
  check('v38-渲染出结论块', doc.indexOf('class="concl"') >= 0 && doc.indexOf('本次扫描检查了 47 个文件') >= 0, '结论块缺失');
  check('v38-三种证据徽章齐全',
    doc.indexOf('lv-obs') >= 0 && doc.indexOf('lv-der') >= 0 && doc.indexOf('lv-inf') >= 0,
    '徽章缺失');
  check('v38-依据以灰字呈现', doc.indexOf('class="ev"') >= 0 && doc.indexOf('本次扫描实际读取的文件数') >= 0, '依据缺失');
  // v3.9 起：局限 = 基础五条 + extraLimits 动态追加，不再支持整体覆盖。
  // 注意只数「处理范围与局限」区块内的 <li>（「本次做法」也用 ul.limits）
  const limitsBlock = doc.slice(doc.indexOf('处理范围与局限'));
  check('v38-默认局限五条齐全',
    (limitsBlock.match(/<li>/g) || []).length === 5,
    'limits=' + (limitsBlock.match(/<li>/g) || []).length);
  check('v38-extraLimits 动态追加在基础之后',
    sandbox.DWRReportHtml.build({ title: 'x', rows: [], extraLimits: ['本次已达标上限'] }).indexOf('本次已达标上限') >= 0,
    'extraLimits 未生效');
  check('v38-旧调用方式仍兼容（无 conclusion / limits）',
    sandbox.DWRReportHtml.build({ title: 'x', summary: [['文件总数', 3]] }).indexOf('文件总数') >= 0,
    '向后兼容破坏');
}

/* ---------------- 6.9l v3.9 本次做法 + 动态局限（参照 REA Methodology） ---------------- */
{
  const RH2 = fs.readFileSync(path.join(__dirname, 'js', 'reporthtml.js'), 'utf8');
  const APP2 = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const sb = {};
  (new Function('window', RH2))(sb);





  const doc2 = sb.DWRReportHtml.build({
    title: '扫描报告',
    generatedAt: '2026-10-13 10:00',
    conclusion: '本次扫描检查了 47 个文件，其中 12 个命中、共 31 处。',
    summary: [['已检查文件数', 47, 'obs', '本次扫描实际读取的文件数']],
    steps: ['第一步：按词库全文匹配。', '第二步：统计命中。'],
    extraLimits: ['本次扫描已达到文件数上限（5000），未检查的文件不在本报告内。'],
    rows: [],
  });
  check('v39-渲染出本次做法区块',
    doc2.indexOf('本次做法') >= 0 && doc2.indexOf('第一步：按词库全文匹配。') >= 0,
    'steps 区块缺失');
  check('v39-动态局限追加在基础五条之后',
    (doc2.match(/<li>/g) || []).length === 8
      && doc2.indexOf('已达到文件数上限') >= 0,
    'li=' + (doc2.match(/<li>/g) || []).length);
  check('v39-不传 steps 时用默认四条',
    sb.DWRReportHtml.build({ title: 'x', rows: [] }).indexOf('归一化匹配') >= 0,
    '默认 steps 缺失');
  check('v39-不传 extraLimits 时只有基础五条',
    (sb.DWRReportHtml.build({ title: 'x', rows: [] }).match(/<li>/g) || []).length === 9,
    '基础条数不对');
  check('v39-app 传入 steps 与动态局限',
    APP2.indexOf('extraLimits') >= 0 && APP2.indexOf('var steps = [') >= 0
      && APP2.indexOf('已达到文件数上限') >= 0,
    'app.js 未接 steps / extraLimits');

}

/* ---------------- 6.9m v4.1 扫描复核轨（与处理阶段分开） ---------------- */
{
  const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const RH = fs.readFileSync(path.join(__dirname, 'js', 'reporthtml.js'), 'utf8');
// v4.1 扫描复核轨：与处理阶段分开记录
  check('v41-扫描复核输入框在场且带说明',
    /<input[^>]*id="scanReviewNote"[^>]*data-tip=/.test(HTML)
      && HTML.indexOf('id="scanReviewRow"') >= 0,
    'scanReviewNote 缺失或无 data-tip');
  check('v41-扫描复核与处理复核分开存放',
    APP.indexOf('var scanReviewNote') >= 0 && APP.indexOf('scanReviewNote = ') >= 0,
    'scanReviewNote 变量缺失');
  check('v41-lastScan 记录复核快照',
    APP.indexOf('review: scanReviewNote') >= 0,
    'finishScan 未记录 review');
  check('v41-扫描报告传入复核意见',
    APP.indexOf('review: s0.review || scanReviewNote') >= 0,
    '扫描 HTML 报告未接 review');
  check('v41-扫描概要追加复核行',
    APP.indexOf('扫描复核意见') >= 0 && APP.indexOf("'inf',") >= 0,
    'scanSummary 未加复核行');
  check('v41-新一轮扫描清空上一轮复核',
    APP.indexOf('scanReviewNote = ') >= 0 && APP.indexOf('复核意见按轮归零') >= 0,
    'resetScanRun 未清空复核意见');
  check('v41-复核块样式与结论块区分',
    RH.indexOf('.review{') >= 0 && RH.indexOf('class="review"') >= 0,
    'review 样式或渲染缺失');
}


  // v4.3 主流格式 + 自定义筛选：引擎层真实运行断言
  {
    const vm = await import('vm');
    const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    const c = { TextEncoder, TextDecoder, CompressionStream: globalThis.CompressionStream, DecompressionStream: globalThis.DecompressionStream,
      Blob: globalThis.Blob, Response: globalThis.Response, Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console };
    c.window = c;
    vm.createContext(c);
    vm.runInContext(files, c);
    const W = c.window.DWRDoc;
    check('v43-主流格式清单导出',
      W.COMMON_EXT.join(',') === 'docx,xlsx,pptx,txt,md,csv,rtf,docm,xlsm,pptm',
      'COMMON=' + W.COMMON_EXT.join(','));
    check('v43-默认不限制时 txt 通过',
      W.isSupported('a.txt') === true,
      'txt=' + W.isSupported('a.txt'));
    W.setExtFilter(['docx']);
    check('v43-过滤后 docx 通过 / txt 被排除',
      W.isSupported('a.docx') === true && W.isSupported('a.txt') === false,
      'docx=' + W.isSupported('a.docx') + ' txt=' + W.isSupported('a.txt'));
    W.setExtFilter(null);
    check('v43-清空过滤后恢复', W.isSupported('a.txt') === true, 'txt 未恢复');
    W.setExtFilter(['  .XLSX ']);
    check('v43-扩展名归一化（去空白 / 去点 / 小写）',
      W.getExtFilter().join(',') === 'xlsx',
      'got=' + W.getExtFilter().join(','));
  }

  // v4.3 界面接线与 scan.mjs 参数
  {
    const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    check('v43-格式筛选控件在场且带说明',
      HTML.indexOf('id="scanExtPreset"') >= 0 && HTML.indexOf('id="scanExtCustom"') >= 0,
      'scanExtPreset / scanExtCustom 缺失');
    check('v43-app 应用过滤并持久化',
      APP.indexOf('function applyExtFilter()') >= 0
        && APP.indexOf('extPreset') >= 0 && APP.indexOf('extCustom') >= 0,
      'applyExtFilter 或持久化缺失');
    check('v43-scan.mjs 支持 --ext / --all-ext / --shard',
      SCAN.indexOf("'--ext'") >= 0 && SCAN.indexOf("'--all-ext'") >= 0 && SCAN.indexOf("'--shard'") >= 0,
      '--ext / --all-ext / --shard 缺失');
    check('v43-超大文件与空文件跳过有计数',
      SCAN.indexOf('skippedBig') >= 0 && SCAN.indexOf('skippedEmpty') >= 0,
      'skippedBig / skippedEmpty 缺失');
    check('v43-中间落盘防长跑丢成果', SCAN.indexOf('checkpointEvery') >= 0,
      'checkpointEvery 缺失');
  }
  // v4.12 无障碍回归：v4.8 加复核清单时，24 个 radio 一个可访问名称都没给，
  // 读屏只会念「单选按钮」，用户根本不知道在选什么。ACCESSIBILITY.md 里
  // 「全部输入框有可访问名称」「单选组带 role=radiogroup」两条声明当时就已失效。
  {
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    check('v412-复核清单每个 radio 都带 aria-label',
      APP.indexOf("+ ' aria-label=\"' + escapeHtml(it.text) + '：' + label + '\">'") >= 0,
      'radio 仍无可访问名称');
    check('v412-aria-label 带上选项语义（符合 / 不符合 / 不适用）',
      APP.indexOf("escapeHtml(it.text) + '：' + label") >= 0,
      'label 只重复了条目名，没带选项');
    check('v412-每个清单项是具名 group，选项容器是 radiogroup',
      APP.indexOf("'<li class=\"rv-item\" role=\"group\" aria-label=\"'") >= 0
        && APP.indexOf("'<span class=\"rv-opts\" role=\"radiogroup\" aria-label=\"'") >= 0,
      '分组语义缺失');
    check('v412-组名与条目名一致（读屏可定位到具体项）',
      (APP.split('aria-label=' + String.fromCharCode(34)).length - 1) >= 3,
      '组名未用条目文本');
  }
  // v4.11 网页端大小写敏感：命令行早有 --case-sensitive，网页端 buildConfig 从不传这个字段，
  // 被写死成不敏感。对手机号 / IP / 英文编号这类 ASCII 规则有实际影响。
  {
    const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    check('v411-界面有「区分大小写」开关',
      HTML.indexOf('id="caseSensitive"') >= 0,
      '控件缺失');
    check('v411-开关带悬停解释',
      /data-tip="[^"]{20,}"><input type="checkbox" id="caseSensitive"/.test(HTML),
      '缺悬停解释');
    check('v411-buildConfig 真的把 caseSensitive 传给引擎',
      APP.indexOf('caseSensitive: !!($(' + String.fromCharCode(39) + 'caseSensitive' + String.fromCharCode(39) + ') && $(' + String.fromCharCode(39) + 'caseSensitive' + String.fromCharCode(39) + ').checked)') >= 0,
      'buildConfig 未接线');
    check('v411-设置存取两侧都在（刷新不丢）',
      APP.indexOf("if (typeof o.caseSensitive === 'boolean' && $('caseSensitive'))") >= 0
        && APP.indexOf("caseSensitive: $('caseSensitive') ? $('caseSensitive').checked : false,") >= 0,
      '存取一侧缺失');
    check('v411-开关变化即存',
      APP.indexOf("'scanSkipSys', 'caseSensitive',") >= 0,
      '未挂 change 监听');
    // 引擎层行为锁定：这是本功能的实质，不能只测控件在不在
    const SANDBOX = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
    check('v411-引擎按 caseSensitive 决定正则 flag',
      SANDBOX.indexOf("var flags = 'g' + (cfg.caseSensitive ? '' : 'i');") >= 0,
      '引擎未消费该字段');
  }
  // v4.10 网页端文件名关键字：v4.7 只在命令行做了 --name-words，界面一直没有入口。
  {
    const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    check('v410-界面有文件名关键字输入框与匹配方式下拉',
      HTML.indexOf('id="scanNameWords"') >= 0 && HTML.indexOf('id="scanNameMode"') >= 0,
      '控件缺失');
    check('v410-解析函数与命令行同口径（中英文分隔）',
      APP.indexOf('function parseNameWords(raw)') >= 0
        && APP.indexOf('/[,，;；\\s]+/') >= 0,
      'parseNameWords 缺失');
    check('v410-判定函数支持 and / or 两种模式',
      APP.indexOf('function nameHit(name, words, mode)') >= 0
        && APP.indexOf("return mode === 'and' ? words.every(has) : words.some(has);") >= 0,
      'nameHit 缺失或模式不对');
    check('v410-只判文件名不含目录路径',
      APP.indexOf("var low = String(name).toLowerCase();") >= 0,
      '仍可能用全路径判定');
    check('v410-扫描入口前置过滤（不读文件就判掉）',
      APP.indexOf('if (!nameHit(name, opts.nameWords, opts.nameMode)) { stats.nameSkipped = (stats.nameSkipped || 0) + 1; continue; }') >= 0,
      '前置过滤缺失');
    check('v410-scanOpts 带上 nameWords 与 nameMode',
      APP.indexOf("nameWords: parseNameWords($('scanNameWords') ? $('scanNameWords').value : ''),") >= 0,
      'scanOpts 未接线');
    check('v410-设置持久化（刷新不丢）',
      APP.indexOf("nameWords: $('scanNameWords') ? $('scanNameWords').value : '',") >= 0
        && APP.indexOf("if (typeof o.nameWords === 'string' && $('scanNameWords'))") >= 0,
      '存取一侧缺失');
    check('v410-扫描概要报告跳过的文件数（源码接线）',
      APP.indexOf("['文件名未匹配', s.nameSkipped || 0, 'obs', '文件名不含指定关键字，未读取直接跳过'],") >= 0,
      '概要行缺失');
  // v4.22 起 scanSummary 的 3 条断言全是源码字符串检查，报告的概要行从来没被行为验证过。
  // 这里用 vm 抽真实函数 + 注入 state 桩真跑：nameSkipped 为 0 时也要出行（不能悄悄省略），
  // 且导入报告的批次要额外插两行（检查软件口径）。
  // 扫描概要的最小 state 桩（scanSummary 只读这些字段）
  const BASE_SCAN = {
    time: '2026-10-14 12:00:00', root: 'D:\data', scanned: 12,
    hitFiles: 3, totalHits: 9, maxFiles: 5000, maxDepth: 6, skipSys: true,
    truncated: false, errors: 0, nameSkipped: 0, fromReport: false,
  };
  const SS_CTX = vm.createContext({
    // scanArchiveRatio 读 state.scanArchive：概要里的「平均命中占比」要有分母才算得出来
    state: { lastScan: BASE_SCAN, scanArchive: [] },
    scanReviewNote: '',
    reviewListText: function () { return ''; },
    console: console,
  });
  /** 从 app.js 源码里按大括号配对抽出一个顶层函数定义（用生产实现，不在测试里重写口径） */
  function sliceFn(name) {
    const k = APP.indexOf('function ' + name);
    if (k < 0) return '';
    let d = 0, e = -1;
    for (let i = APP.indexOf('{', k); i < APP.length; i++) {
      if (APP.charAt(i) === '{') d++;
      else if (APP.charAt(i) === '}') { d--; if (d === 0) { e = i + 1; break; } }
    }
    return APP.slice(k, e);
  }
  const SS = (function () {
    // v4.65 起 scanSummary 里多了 fmtRatio(scanArchiveRatio())，只抽它自己就会抛
    // ReferenceError——依赖必须一起抽进来，否则这段行为验证从 v4.65 就是死的。
    const body = ['fmtRatio', 'scanArchiveRatio', 'scanSummary']
      .map(sliceFn).join('\n');
    if (body.indexOf('function scanSummary') < 0) return null;
    vm.runInContext(body, SS_CTX);
    return vm.runInContext('scanSummary', SS_CTX);
  })();
  check('v422-scanSummary 可抽取且返回数组', typeof SS === 'function', '抽取失败');
  check('v469-抽取带上 fmtRatio / scanArchiveRatio 依赖',
    sliceFn('fmtRatio').length > 0 && sliceFn('scanArchiveRatio').length > 0
      && /fmtRatio\(scanArchiveRatio\(\)\)/.test(APP), '依赖函数抽不出来');
  if (typeof SS === 'function') {
    // nameSkipped = 0 时也要出这行（不能悄悄省略，否则用户不知道有没有跳过的）
    SS_CTX.state.lastScan = BASE_SCAN;
    const rows0 = SS();
    const row0 = rows0.filter((r) => r[0] === '文件名未匹配')[0];
    check('v422-概要含「文件名未匹配」行且 0 也显示',
      !!row0 && row0[1] === 0 && /未读取直接跳过/.test(row0[3] || ''),
      JSON.stringify(row0));
    // 有跳过时数字要透传
    SS_CTX.state.lastScan = Object.assign({}, BASE_SCAN, { nameSkipped: 7 });
    const rows7 = SS();
    const row7 = rows7.filter((r) => r[0] === '文件名未匹配')[0];
    check('v422-跳过的文件数透传到概要', !!row7 && row7[1] === 7, JSON.stringify(row7));
    // 导入报告的批次要额外插两行（检查软件口径，v4.32）
    SS_CTX.state.lastScan = Object.assign({}, BASE_SCAN, { fromReport: true, checkerHits: 26, falsePos: 191 });
    const rowsR = SS();
    const names = rowsR.map((r) => r[0]);
    check('v422-导入报告时概要插检查软件口径两行',
      names.indexOf('检查软件报告命中') >= 0 && names.indexOf('复检误报（本工具 0 命中）') >= 0,
      names.join(' | '));
    // 「平均命中占比」走的是真实 fmtRatio + scanArchiveRatio：按文件加权的平均值，
    // 无命中文件时显示 -。这两条只有依赖真抽进来了才可能通过（v4.65 的断口径）。
    SS_CTX.state.lastScan = BASE_SCAN;
    SS_CTX.state.scanArchive = [{ ratio: 0.25 }, { ratio: 0.5 }];
    const rowAvg = SS().filter((r) => r[0] === '平均命中占比')[0];
    check('v469-概要平均命中占比按文件加权（真实 fmtRatio）',
      !!rowAvg && rowAvg[1] === '37.5%', JSON.stringify(rowAvg));
    SS_CTX.state.scanArchive = [];
    const rowNil = SS().filter((r) => r[0] === '平均命中占比')[0];
    check('v469-无命中文件时占比显示 -（不显示 0%）',
      !!rowNil && rowNil[1] === '-', JSON.stringify(rowNil));
  }
    // 顺带修掉的重复键：finishScan 里 review 被写了两次
    check('v410-finishScan 的 review 键只出现一次（修重复键）',
      (function () {
        const seg = APP.slice(APP.indexOf('state.lastScan = {'), APP.indexOf('state.lastScan = {') + 900);
        return (seg.match(/review:/g) || []).length === 1;
      })(), 'review 键重复');
  }
  // v4.9 补足常见合规词：公文要素 8 + 时效标识 3 + 敏感内容 5。
  // 单字词（院/部/厅/局/委/署/司/令）故意不收——命中面过大，文档脱敏用会误伤一片。
  {
    const RU = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
    check('v49-新增公文要素 / 时效标识 / 敏感内容三组',
      RU.indexOf("group: '公文要素'") >= 0 && RU.indexOf("group: '时效标识'") >= 0
        && RU.indexOf("group: '敏感内容'") >= 0,
      '新词组缺失');
    check('v49-公文要素 8 词、时效标识 3 词、敏感内容 5 词',
      (RU.match(/group: '公文要素'/g) || []).length === 8
        && (RU.match(/group: '时效标识'/g) || []).length === 3
        && (RU.match(/group: '敏感内容'/g) || []).length === 5,
      '词数不对');
    // 单字词是「广撒网」口径，收了会把正常公文误伤一片
    const SINGLE = ['院', '部', '厅', '局', '委', '署', '司', '令'];
    check('v49-不收单字词（院/部/厅/局/委/署/司/令）',
      SINGLE.every((w) => RU.indexOf("{ word: '" + w + "',") < 0),
      '误收单字词');
    // 银行必须带上下文排除，否则「中国人民银行」「招商银行」全被误删
    check('v49-银行带 notBefore 排除（防误删人民银行 / 招商 / 商业）',
      RU.indexOf("{ word: '银行', group: '敏感内容', notBefore: ['商业', '招商', '人民'] }") >= 0,
      '银行缺排除上下文');
    check('v49-v4.6 原有的 18 词未被改动',
      (RU.match(/group: '公文文号'/g) || []).length === 14
        && (RU.match(/group: '政治安全'/g) || []).length === 4,
      '原有词组被改动');
  }
  // v4.8 结构化复核清单：把常见人工检查项改造成文档脱敏场景的 8 项。
  {
    const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    const CSS = fs.readFileSync(path.join(__dirname, 'css', 'style.css'), 'utf8');
    check('v48-复核清单容器与入口按钮在场',
      HTML.indexOf('id="reviewListPanel"') >= 0 && HTML.indexOf('id="reviewListBtn"') >= 0,
      '容器或按钮缺失');
    check('v48-清单数据来自常见人工检查项（8 项）',
      APP.indexOf('var REVIEW_ITEMS = [') >= 0
        && (APP.match(/id: '/g) || []).length >= 8,
      'REVIEW_ITEMS 缺失或项数不足');
    check('v48-三项一态（符合 / 不符合 / 不适用）',
      APP.indexOf("opt('ok', '符合')") >= 0
        && APP.indexOf("opt('bad', '不符合')") >= 0
        && APP.indexOf("opt('na', '不适用')") >= 0,
      '三态选项缺失');
    check('v48-默认全不选，不猜用户结论',
      APP.indexOf('var reviewChecks = {};') >= 0,
      'reviewChecks 未初始化为空');
    check('v48-有重置入口',
      HTML.indexOf('id="reviewListReset"') >= 0 && APP.indexOf("$('reviewListReset')") >= 0,
      '重置缺失');
    check('v48-init 里挂了绑定',
      APP.indexOf('bindReviewList();') >= 0,
      'bindReviewList 未调用');
    check('v48-勾选统计区分「不符合」并警示',
      APP.indexOf("el.className = 'hint' + (bad ? ' warn' : '');") >= 0,
      '统计缺不符合计数');
    check('v48-扫描报告带上结构化复核结论',
      APP.indexOf("['结构化复核', reviewListText() || '（未填写）', 'inf'") >= 0,
      '报告未带清单结论');
    check('v48-清单样式在场（含选中态）',
      CSS.indexOf('.review-list .rv-opt.on') >= 0,
      '样式缺失');
    check('v48-每项都有悬停解释',
      APP.indexOf('data-tip=' + String.fromCharCode(34)) >= 0 && APP.indexOf('escapeHtml(it.tip)') >= 0,
      '缺悬停解释');
  }
  // v4.7 文件名关键字：支持「文件名关键字 + 内容关键字，可设与/或」。
  {
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    check('v47-scan.mjs 支持 --name-words 与 --name-mode',
      SCAN.indexOf("'--name-words'") >= 0 && SCAN.indexOf("'--name-mode'") >= 0,
      '参数缺失');
    check('v47-解析函数在场且容忍中英文分隔符',
      SCAN.indexOf('function parseNameWords(raw)') >= 0
        && SCAN.indexOf('/[,，;；\\s]+/') >= 0,
      'parseNameWords 缺失');
    check('v47-判定函数支持 and / or 两种模式',
      SCAN.indexOf('function nameHit(fullPath, words, mode)') >= 0
        && SCAN.indexOf("return mode === 'and' ? words.every(has) : words.some(has);") >= 0,
      'nameHit 缺失或模式不对');
    // 只判文件名不判目录路径：否则目录名含目标词会让整棵子树的文件都算命中
    check('v47-只判文件名，不含目录路径',
      SCAN.indexOf("const base = String(fullPath).replace(/\\\\/g, '/').split('/').pop();") >= 0,
      '仍在用全路径判定');
    // 前置过滤：不读文件就判掉，省 IO
    check('v47-在 walker 里前置过滤（不读文件）',
      SCAN.indexOf('if (!nameHit(full, o.nameWords, o.nameMode)) { nameSkipped++; continue; }') >= 0
        && SCAN.indexOf('let nameSkipped = 0;') >= 0,
      '前置过滤缺失');
    check('v47-大小写不敏感',
      SCAN.indexOf('const low = base.toLowerCase();') >= 0
        && SCAN.indexOf('String(w).toLowerCase()') >= 0,
      '未做小写归一');
    check('v47-汇总行报告跳过的文件数',
      SCAN.indexOf("console.log('文件名未匹配: ' + nameSkipped + ' 个（未读取，直接跳过）');") >= 0,
      '汇总行缺失');
  }
  // v4.6 公文文号与政治安全词组：补充 18 个常见合规词。
  // 这些词命中面比密级词大得多，必须单独成组、默认可关，
  // 整组停用即回到 v4.5 及以前的默认行为。
  {
    const RU = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
    check('v46-默认词库含公文文号与政治安全两组',
      RU.indexOf("group: '公文文号'") >= 0 && RU.indexOf("group: '政治安全'") >= 0,
      '新词组缺失');
    check('v46-文号词 14 个 + 政治安全词 4 个',
      (RU.match(/group: '公文文号'/g) || []).length === 14
        && (RU.match(/group: '政治安全'/g) || []).length === 4,
      '词数不对');
    check('v475-默认词库只含四个密级词且不设置商业排除',
      RU.indexOf("{ word: '涉密', group: '涉密字样' }") < 0
        && RU.indexOf("{ word: '内部', group: '密级标识' }") >= 0
        && RU.indexOf("{ word: '秘密', group: '密级标识' }") >= 0
        && RU.indexOf("{ word: '机密', group: '密级标识' }") >= 0
        && RU.indexOf("{ word: '绝密', group: '密级标识' }") >= 0,
      '四词默认词库不正确');
    // 分组必须真的能整组停用：这是「不改变老用户处理结果」的前提
    const APP = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
    check('v46-界面支持按组整组停用 / 启用',
      APP.indexOf('function renderRuleGroup(box, gp)') >= 0
        && APP.indexOf('grp-sw') >= 0,
      '分组开关缺失');
    // 命令行侧此前丢 group，与网页端行为不一致
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    check('v46-scan.mjs 保留 group（与网页端口径一致）',
      SCAN.indexOf('group: p.group') >= 0,
      'buildRules 仍丢 group');
    check('v46-scan.mjs 有分组汇总与按组展示',
      SCAN.indexOf('function groupSummary(rules)') >= 0
        && SCAN.indexOf('function wordListHtml(opts)') >= 0,
      'groupSummary / wordListHtml 缺失');
    check('v46-HTML 报告目标字样按组展示',
      SCAN.indexOf('${wordListHtml(opts)}') >= 0,
      '报告仍平铺词条');
  }
  // v4.5 命中百分比（ratio）：结果表提供「命中百分比」列。
  // 口径 = 命中字符数 / 全文有效字符（去空白）。没有它就无法回答
  // 「这份文件到底有多涉密」，人工复核也没有排序依据。
  {
    const OO = fs.readFileSync(path.join(__dirname, 'js', 'ooxml.js'), 'utf8');
    const RU = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
    check('v45-rules.js 统计命中字符数 hitChars',
      RU.indexOf('hitChars += m.length') >= 0 && RU.indexOf('hitChars += norm.slice(sp.s, sp.e).length') >= 0,
      'hitChars 累计缺失');
    check('v45-rules.js 三个早退分支与 scan 都带 hitChars',
      (RU.match(/hitChars: 0/g) || []).length >= 3 && RU.indexOf('hitChars: r.hitChars') >= 0,
      'hitChars 未贯通');
    check('v45-ooxml.js 纯文本路径算 ratio',
      OO.indexOf('totalChars: totalChars,') >= 0 && OO.indexOf('ratio: totalChars > 0 ? hitChars / totalChars : 0') >= 0,
      'processText 的 ratio 缺失');
    check('v45-预览路径不掺入 ratio（预览无分母语义）',
      (function () {
        const pv = OO.slice(OO.indexOf('function previewProcess'), OO.indexOf('function mergeMatch'));
        return pv.indexOf('totalChars') < 0 && pv.indexOf('hitChars') < 0;
      })(), 'previewProcess 不应累计 totalChars / hitChars');
    // 以下 4 条保留源码检查：它们守的是「渲染层有没有这一列 / 预览路径有没有被污染」，
    // 这类断言看的是最终输出的字面内容，跑进程反而拿不到中间态；
    // 而 scan.mjs 的条目字段与分母位置已由 test-formats 的 v444-CLI * 三条行为断言
    // 和下面的 v43-Office * 四条覆盖（v4.44 清理冗余时删掉了对应的静态版）。
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    check('v45-CSV 与 HTML 报告都有命中占比列',
      SCAN.indexOf("'file,hits,matched,pos,ratio'") >= 0
        && SCAN.indexOf('命中占比</th>') >= 0 && SCAN.indexOf('c-ratio') >= 0,
      '报告列缺失');
    // 源码字符串查不出「分母有没有真的加对」，这里用真实引擎 + 真实 docx / xlsx 跑一遍：
    // 三处文本来源（正文块 / 属性值 / 简单文本节点）都必须计入分母。
    // v4.43 修复前 replaceAttrs 漏累计，命中只在工作表名上时分母为 0。
    {
      const vm = await import('vm');
      const src = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js']
        .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
      const c = {
        TextEncoder, TextDecoder,
        CompressionStream: globalThis.CompressionStream,
        DecompressionStream: globalThis.DecompressionStream,
        Blob: globalThis.Blob, Response: globalThis.Response,
        Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console: { log() {} }
      };
      c.window = c;
      vm.createContext(c);
      vm.runInContext(src, c);
      const R = c.window.DWRRules;
      const D = c.window.DWRDoc;
      const engine = R.createEngine({ rules: [{ text: '机密', label: '机密' }], action: 'delete', scope: 'all' });
      const scan = async (pack) => {
        const blob = await c.window.DWRZip.pack(pack);
        const ab = await blob.arrayBuffer();
        return D.scanOffice(ab, engine);
      };
      const docP = (t) => '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
        + '<w:p><w:r><w:t>' + t + '</w:t></w:r></w:p></w:body></w:document>';
      // A：命中在正文块，分母 = 全部正文（3 段）
      const docA = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
        + '<w:p><w:r><w:t>AAAAAAAA</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>机密CCCCCC</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t>BBBBBBBB</w:t></w:r></w:p></w:body></w:document>';
      const ra = await scan([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: docA }]);
      check('v43-Office 正文命中计入分母', ra.hits === 1 && ra.totalChars === 28 && Math.abs(ra.ratio - 2 / 28) < 1e-9,
        'hits=' + ra.hits + ' totalChars=' + ra.totalChars + ' ratio=' + ra.ratio);
      // 期望口径：三段正文 8+8+8 = 24，加上 <w:document>/<w:body> 上的属性值 4 个字符
      // （specFor 对 word/ 同时开 blocks 与 attrs，属性值同样计入分母）
      // B：命中只在属性值（Excel 工作表名），分母必须含这些属性值字符
      const docB = docP('AAAAAAAA') + '<w:p><w:r><w:t>BBBBBBBB</w:t></w:r></w:p></w:body></w:document>';
      const wb = '<?xml version="1.0"?><workbook xmlns="x"><sheets>'
        + '<sheet name="机密报表"/><sheet name="普通表"/></sheets></workbook>';
      const rb = await scan([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: docB },
        { name: 'xl/workbook.xml', data: wb }
      ]);
      check('v43-Office 属性值命中也计入分母（修分母漏累计）',
        rb.hits === 1 && rb.totalChars >= 23 && rb.ratio > 0 && rb.ratio < 0.2,
        'hits=' + rb.hits + ' totalChars=' + rb.totalChars + ' ratio=' + rb.ratio);
      // C：命中在简单文本节点（docProps），同样计入分母
      const core = '<?xml version="1.0"?><cp:coreProperties xmlns:cp="x"><dc:title>机密标题</dc:title>'
        + '<dc:subject>普通主题</dc:subject></cp:coreProperties>';
      const rc = await scan([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: docB },
        { name: 'docProps/core.xml', data: core }
      ]);
      check('v43-Office 文本节点命中也计入分母',
        rc.hits === 1 && rc.totalChars > 0 && rc.ratio > 0 && rc.ratio < 0.2,
        'hits=' + rc.hits + ' totalChars=' + rc.totalChars + ' ratio=' + rc.ratio);
      // 反向口径：未命中的正文也必须在分母里（这是 v45 最初的承诺）
      const rd = await scan([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: docB }]);
      check('v43-无命中时分母仍累计（占比不会虚高）', rd.hits === 0 && rd.totalChars === 20 && rd.ratio === 0,
        'hits=' + rd.hits + ' totalChars=' + rd.totalChars);
    }
  }
  // v4.4 分片均衡性：旧实现按顶层条目名哈希，一个超大目录就会独占一片
  // （早期实现按顶层条目名哈希，切片后文件数分布不均）。
  // 这里用真实文件树 + 真实 scan.mjs 的 inShard 验证：每片文件数应大体均摊。
  {
    const SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
    // 从 scan.mjs 抽出 inShard 整体（按花括号配平，不用非贪婪正则——
    // 函数体中间就有缩进两格的 }，非贪婪会提前截断出残缺函数）
    const start = SCAN.indexOf('function inShard(fullPath)');
    check('v44-inShard 实现在 scan.mjs 中', start >= 0, '未找到 inShard');
    let depth = 0, end = -1;
    for (let i = SCAN.indexOf('{', start); i < SCAN.length; i++) {
      if (SCAN.charAt(i) === '{') depth++;
      else if (SCAN.charAt(i) === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    check('v44-inShard 函数体完整截取', end > start, '花括号未配平');
    if (start >= 0 && end > start) {
      const body = SCAN.slice(start, end);
      // 用 vm 跑真实代码，而不是抄一份实现
      const mk = (k, n) => {
        const ctx = vm.createContext({ String, Math });
        vm.runInContext('shardK = ' + k + '; shardN = ' + n + ';', ctx);
        vm.runInContext(body + '; result = inShard;', ctx);
        return ctx.result;
      };
      // 场景：一个超大目录（占总量四分之三）+ 三个普通目录，正是 Z 盘的形状
      const BS = String.fromCharCode(92);
      const CN_BIG = String.fromCharCode(36215) + String.fromCharCode(22823) + String.fromCharCode(30446);
      const CN_SUB = String.fromCharCode(23376) + String.fromCharCode(25991);
      const CN_DIR = String.fromCharCode(26222) + String.fromCharCode(36890);
      const files = [];
      for (let i = 0; i < 750; i++) files.push('Z:' + BS + CN_BIG + BS + CN_SUB + (i % 7) + BS + 'f' + i + '.docx');
      for (let i = 0; i < 250; i++) files.push('Z:' + BS + CN_DIR + (i % 3) + BS + 'f' + i + '.docx');
      const N = 4;
      const counts = [];
      for (let k = 1; k <= N; k++) counts.push(files.filter((p) => mk(k, N)(p)).length);
      const total = counts.reduce((a, b) => a + b, 0);
      check('v44-分片不重不漏（各片之和等于文件总数）', total === files.length,
        'sum=' + total + ' expected=' + files.length);
      const mx = Math.max.apply(null, counts);
      // 旧实现在这个形状下最大片约 750（均值 3 倍）；新实现不应超过均值 1.5 倍
      check('v44-超大目录不再独占一片（最大片 <= 均值 1.5 倍）',
        mx <= (files.length / N) * 1.5,
        'counts=' + counts.join('/') + ' avg=' + (files.length / N));
      check('v44-最小片非空（没有空转的片）', Math.min.apply(null, counts) > 0,
        'counts=' + counts.join('/'));
      const f1 = mk(2, N), f2 = mk(2, N);
      check('v44-同一路径两次分片结果一致（可复现）',
        files.every((p) => f1(p) === f2(p)), '同路径两次判定不一致');
      check('v44-不启用分片时全部通过',
        files.every((p) => mk(1, 1)(p)), 'shardN=1 应放行全部文件');
      const fw = mk(1, 8);
      check('v44-反斜杠与正斜杠路径落进同一片',
        fw('Z:' + BS + 'a' + BS + 'b.docx') === fw('Z:/a/b.docx'), '分隔符未归一化');
      // 覆盖率：n=4 时 1000 个文件四片全非空，说明没有大片被整体漏掉
      check('v44-四片均摊且无空片', counts.every((c) => c > 0 && c <= (files.length / N) * 1.5),
        'counts=' + counts.join('/'));
    }
  }

/* ---------------- v4.20 SECURITY.md 约束门禁 ----------------
   CONTRIBUTING.md 把「零运行时依赖」与「数据不出本机」列为会拒绝合并的硬约束，
   但测试里此前一条断言都没有——约束只活在文档里，没人验证它真的被遵守。 */
{
  const SEC_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const SEC_APP = fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf8');
  const SEC_SCAN = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  const SEC_PJ = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

  // 1) 零运行时依赖（CONTRIBUTING 硬约束第一条）
  check('v420-零运行时依赖（无 dependencies）',
    !SEC_PJ.dependencies || Object.keys(SEC_PJ.dependencies).length === 0,
    'deps=' + JSON.stringify(SEC_PJ.dependencies || {}));

  // 2) CSP 限制网络出口为 self（数据不出本机的技术依据）
  check("v420-CSP 限制 connect-src 为 self",
    SEC_HTML.indexOf("connect-src 'self'") >= 0, 'CSP 缺 connect-src self');

  // 3) 无外部 CDN 资源（脚本 / 样式表不得走 http(s)）
  const extAssets = SEC_HTML.match(/src="https?:|href="https?:\/\/[^"]*\.(js|css)/g) || [];
  check('v420-无外部 CDN 脚本/样式', extAssets.length === 0,
    'ext=' + extAssets.join(','));

  // 4) 命令行不发网络请求
  const scanNet = SEC_SCAN.match(/from 'https?:|require\('https?:|fetch\(|http\.request/g) || [];
  check('v420-scan.mjs 无网络请求', scanNet.length === 0, scanNet.join(','));

  // 5) 网页端不外发数据
  const appNet = SEC_APP.match(/fetch\(|XMLHttpRequest|sendBeacon/g) || [];
  check('v420-js/app.js 无数据外发接口', appNet.length === 0, appNet.join(','));
}

/* ---------------- v4.21 行尾策略门禁 ----------------
   CONTRIBUTING.md 硬约束第三条：不要改 .gitattributes 的行尾策略（源码 LF、批处理 CRLF
   是刻意设定）。.gitattributes 注释写明破坏后果：Start.sh 若被检出为 CRLF，
   在 UOS / Linux 上直接报 bash 找不到命令。
   此前没有任何断言守着它：谁把 .md 存成 CRLF、谁把 .bat 洗成 LF，都没人知道。
   本轮补上守护。注意：核对时必须用 git show :<file> 取索引里的原始字节，
   不能信 git status——仓库开了 core.autocrlf=true，干净的 .md 也会被显示成 M。*/
{
  const GA = fs.readFileSync(path.join(__dirname, '.gitattributes'), 'utf8');
  const gaLf = (GA.match(/\*(?:\.\w+)?\s+text eol=lf/g) || []).length;
  const gaCrlf = (GA.match(/\*(?:\.\w+)?\s+text eol=crlf/g) || []).length;
  check('v421-.gitattributes 同时声明 LF 与 CRLF 两档', gaLf > 0 && gaCrlf > 0,
    'lf=' + gaLf + ' crlf=' + gaCrlf);
  // 只查 git 跟踪的文件：cleaned/ 等产物目录不适用，且已被 .gitignore 排除
  const gaR = spawnSync('git', ['ls-files'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 67108864 });
  const tracked = (gaR.stdout || '').split(/\r\n|\n/).filter(Boolean);
  const lfExts = ['.js', '.mjs', '.json', '.html', '.css', '.md', '.yml', '.sh', '.desktop'];
  const crlfExts = ['.bat', '.cmd'];
  function fileEol(fp) {
    const b = fs.readFileSync(fp);
    let crlf = 0, lf = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 13 && b[i + 1] === 10) { crlf++; i++; }
      else if (b[i] === 10) lf++;
    }
    if (crlf && lf) return 'MIXED';
    if (crlf) return 'CRLF';
    if (lf) return 'LF';
    return 'none';
  }
  const badEol = [];
  for (const f of tracked) {
    const fp = path.join(__dirname, f);
    if (!fs.existsSync(fp)) continue;
    const ext = path.extname(f).toLowerCase();
    const e = fileEol(fp);
    if (lfExts.indexOf(ext) >= 0 && e !== 'LF') badEol.push(f + ' ' + e);
    if (crlfExts.indexOf(ext) >= 0 && e !== 'CRLF') badEol.push(f + ' ' + e);
  }
  check('v421-跟踪的源码/脚本/文档一律 LF、批处理 CRLF', badEol.length === 0,
    badEol.slice(0, 8).join(' ; '));
}

/* ---------------- v4.22 目标尺寸门禁（WCAG 2.5.8）----------------
   ACCESSIBILITY.md「可操作」一节写着「按钮 / 复选框符合最小交互尺寸」，
   但没有任何测试守着它。本轮实测发现 13 个词条复选框只有 13×13，
   连 WCAG 2.5.8 的间距例外都不满足（相邻间距 0-4px，需要 6px）。
   
   判定口径（与 WCAG 2.5.8 一致，两种满足方式任一即可）：
     1) 目标本身 ≥ 24×24；或
     2) 以目标中心为圆心、24px 为直径的圆不与其它目标相交
        （即到最近邻目标的间距 ≥ 12 - min(w,h)/2）。
   被 <label> 包裹的 input 用 label 的盒子算命中区（点 label 即激活 input）。
   被祖先 overflow 裁掉的元素不算——它们此刻不可点击。 */
{
  const H = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const H_ACC = fs.readFileSync(path.join(__dirname, 'ACCESSIBILITY.md'), 'utf8');
  // CSS 必须把词条复选框做成 24×24 命中区：原生 checkbox 在 appearance:auto 下
  // 会忽略 border/padding，所以必须 appearance:none + 透明 border 撑盒。
  const CSS = fs.readFileSync(path.join(__dirname, 'css/style.css'), 'utf8');
  const ccBlock = (CSS.match(/\.chip \.chip-check\s*\{[^}]*\}/) || [''])[0];
  check('v422-词条复选框声明 24px 命中区（appearance:none + 5px 透明 border）',
    /appearance:\s*none/.test(ccBlock) && /border:\s*5px solid transparent/.test(ccBlock),
    'chip-check 块未按 24×24 命中区声明');
  // 命中区不能把 chip 撑高：绝对定位，让 24px 盒子溢出到 chip 外、不占布局。
  // 少了这条，chip 会从 26px 变 38px，整块词库跟着变高（v4.22 实测回归）。
  check('v422-命中区用绝对定位，不撑高 chip',
    /position:\s*absolute/.test(ccBlock) && /left:\s*4px/.test(ccBlock),
    'chip-check 未绝对定位');
  // 相邻开关的间距例外：label 高 20px，需 ≥ 10px 上下间距（--sp-2 的 8px 不够）。
  check('v422-相邻开关留 10px 间距（满足 2.5.8 间距例外）',
    /\.switch\s*\{[^}]*margin-top:\s*10px/.test(CSS.replace(/\n/g, ' ')),
    '.switch margin-top 不是 10px');
  // 无障碍文档必须写明这条口径，否则后人不知道 24px 是刻意设定
  check('v422-ACCESSIBILITY.md 记录目标尺寸口径',
    /最小交互尺寸|2\.5\.8|24/.test(H_ACC), 'ACCESSIBILITY.md 未写目标尺寸口径');
}

/* ---------------- v4.23 输出方式 / 备份开关的行为断言 ----------------
   v4.16 审计用关键词扫过 7 个开关，只确认了「名字在代码里出现」，没验行为。
   本轮逐个核对，发现 backup 与 outmode 的联动完全没被行为覆盖：
     - backup：只有 setOutDirInfo 里那条「覆盖原文件且不备份」的红色告警，零覆盖；
     - outmode：只验了 HTML 里有 9 个 radio name，没验 zip / newfolder / inplace
       三档真的走不同写出路径。
   onlyChanged / verifyAfter / onlyHit / scanHideFp 已有行为覆盖（见 6.4 / 6.24f / 6.6 / imp 节）。 */
{
  reloadApp();
  // 桩的 querySelectorAll 返回 []，radio 的 change 监听器绑不上，
  // 所以 outmode 的联动只能用静态接线断言；backup 是真 checkbox，可走真实事件。
  const recalc = () => fire(el('backup'), 'change');

  radios.outmode = 'zip';
  el('backup').checked = true;
  recalc();
  check('v423-zip 模式且开备份：无覆盖告警',
    el('outDirWarn').hidden === true,
    'hidden=' + el('outDirWarn').hidden + ' text=' + el('outDirWarn').textContent);

  radios.outmode = 'inplace';
  el('backup').checked = false;
  recalc();
  check('v423-覆盖原文件且不备份：出现红色告警',
    el('outDirWarn').hidden === false && /不保留备份/.test(el('outDirWarn').textContent),
    'hidden=' + el('outDirWarn').hidden + ' text=' + el('outDirWarn').textContent);

  radios.outmode = 'zip';
  el('backup').checked = false;
  recalc();
  check('v423-zip 模式不开备份：无覆盖告警（不改写原文件）',
    el('outDirWarn').hidden === true,
    'hidden=' + el('outDirWarn').hidden + ' text=' + el('outDirWarn').textContent);

  radios.outmode = 'inplace';
  el('backup').checked = true;
  recalc();
  check('v423-覆盖原文件且开备份：无覆盖告警（有 .bak 可还原）',
    el('outDirWarn').hidden === true,
    'hidden=' + el('outDirWarn').hidden + ' text=' + el('outDirWarn').textContent);

  radios.outmode = 'newfolder';
  el('backup').checked = false;
  recalc();
  check('v423-保存到新目录且不开备份：无覆盖告警（原文件不动）',
    el('outDirWarn').hidden === true,
    'hidden=' + el('outDirWarn').hidden + ' text=' + el('outDirWarn').textContent);

  // 穷举 6 种组合：告警只应出现在 inplace 且不备份
  const risky = [];
  for (const mode of ['zip', 'newfolder', 'inplace']) {
    for (const bk of [true, false]) {
      radios.outmode = mode;
      el('backup').checked = bk;
      recalc();
      const shown = el('outDirWarn').hidden === false;
      if (shown !== (mode === 'inplace' && !bk)) risky.push(mode + '/backup=' + bk + '=>shown=' + shown);
    }
  }
  check('v423-覆盖告警仅出现在 inplace 且不备份（6 种组合穷举）', risky.length === 0, risky.join(' ; '));

  // 切 outmode 也必须重算告警：此前只有 backup 的 change 调 setOutDirInfo，
  // 用户「先关备份、再选覆盖原文件」时看不到任何警告就改写了原文件。
  const SRC = fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf8');
  // 截取 radio change 处理器：从 outmode 的 querySelectorAll 到 syncCustomWrap 定义前
  const rhStart = SRC.indexOf('input[name="outmode"]');
  const rhEnd = SRC.indexOf('function syncCustomWrap', rhStart);
  const radioHandler = rhStart >= 0 && rhEnd > rhStart ? SRC.slice(rhStart - 140, rhEnd) : '';
  check('v423-切换输出方式的 change 也重算覆盖告警',
    /el\.name === 'outmode'\) setOutDirInfo\(\);/.test(radioHandler),
    'outmode 的 change 处理器没有调 setOutDirInfo（切到覆盖原文件时告警不更新）');
  // backup 自己的 change 同样要重算（两个入口都要守）
  check('v423-backup 开关变化也重算覆盖告警',
    /if \(id === 'backup'\) setOutDirInfo\(\);/.test(SRC),
    'backup 的 change 处理器没有调 setOutDirInfo');

  const CSS = fs.readFileSync(path.join(__dirname, 'css/style.css'), 'utf8');
  /* v4.25 页头滚动加深：design-qa.md 的 Follow-up Polish 里唯一未评估项。
     实测确认页头已吸顶（position: sticky, top: 0），但滚动前后样式完全一样，
     半透明底会把下方内容透上来，标题与正文叠在一起难读。 */
  check('v425-CSS 定义 .app-header.scrolled 加深态',
    /\.app-header\.scrolled\s*\{[^}]*background:/s.test(CSS),
    'CSS 里没有 .app-header.scrolled 的加深背景');
  check('v425-深色主题也有对应的加深态',
    /html\[data-theme="dark"\] \.app-header\.scrolled\s*\{/.test(CSS),
    '深色主题缺少 .app-header.scrolled 定义');
  check('v425-加深态加了分隔阴影（不只是改透明度）',
    /.app-header\.scrolled\s*\{[\s\S]{0,400}?box-shadow:[\s\S]{0,200}?0 6px/.test(CSS),
    '.app-header.scrolled 没有加投影分隔');
  check('v425-过渡只作用于背景与阴影，不牵动布局',
    /.app-header\s*\{[\s\S]{0,200}?transition:\s*background[\s\S]{0,120}?box-shadow/.test(CSS),
    '.app-header 的 transition 未限定在 background / box-shadow');
  check('v425-尊重减少动效偏好',
    /prefers-reduced-motion[\s\S]{0,200}\.app-header\s*\{[^}]*transition:\s*none/s.test(CSS),
    'prefers-reduced-motion 下没有关掉页头过渡');
  check('v425-app.js 有 bindHeaderScroll 且用 querySelector 取页头',
    /function bindHeaderScroll\(\)[\s\S]{0,300}document\.querySelector\('\.app-header'\)/.test(SRC),
    'bindHeaderScroll 缺失或没用 querySelector 取 .app-header');
  check('v425-滚动监听是 passive 且只在状态变化时写 class',
    /addEventListener\('scroll', sync, \{ passive: true \}\)/.test(SRC)
      && /if \(want === on\) return;/.test(SRC),
    'scroll 监听不是 passive，或没有做状态去重');
  check('v425-init 里调用了 bindHeaderScroll',
    /bindHeaderScroll\(\);/.test(SRC),
    'init() 没有调用 bindHeaderScroll');

  /* v4.26 ACCESSIBILITY.md 剩余声明变断言。
     核对文档逐条后发现「读屏播报 / 语言标记 / 标题层级 / 状态播报」四项
     在 index.html 里都真实存在，但测试里一条断言都没有——属「说了没守」。
     变量在本块内重新声明，不依赖外层作用域（v4.25 踩过跨块引用的坑）。 */
  const H426 = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  check('v426-处理日志是 role=log 且 aria-live=polite（读屏可播报）',
    /role="log"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="log"/.test(H426),
    'index.html 里找不到 role=log + aria-live=polite 的日志容器');
  check('v426-进度条是 role=progressbar 且带 aria-valuenow',
    /role="progressbar"/.test(H426) && /aria-valuenow/.test(SRC),
    '进度条缺 role=progressbar，或 app.js 没有动态写 aria-valuenow');
  check('v426-文档声明 lang=zh-CN',
    /<html[^>]*lang="zh-CN"/.test(H426),
    'html 根元素缺 lang=zh-CN');
  check('v426-标题层级起点唯一（有且仅有一个 h1）',
    (H426.match(/<h1[\s>]/g) || []).length === 1
      && (H426.match(/<h2[\s>]/g) || []).length > 0,
    'h1 数量不是 1，或没有 h2（标题层级不完整）');
  check('v426-状态变化走 role=status / aria-live，不只靠视觉',
    /role="status"|aria-live/.test(H426),
    '页面没有 role=status 或 aria-live 的状态播报点');
  check('v426-危险操作告警条存在（覆盖原文件且不备份）',
    /id="outDirWarn"/.test(H426) && /outDirWarn/.test(SRC),
    '缺 outDirWarn 告警条');

  /* v4.27 Service Worker 预缓存清单完整性。
     README 声称「静态资源全部预缓存、断网仍可用」，但清单里漏了 js/app.js——
     断网时 index.html 能从缓存打开，主逻辑却取不到，工具完全不能用。
     assets/app-icon.ico 也漏了。这里把「清单覆盖全部本地资源」变成断言。 */
  const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  const HIDX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // index.html 引用的每个本地资源（去掉 ?v= 缓存参数）都必须在预缓存清单里
  const refRe = /(?:src|href)="([^"]+)"/g;
  let rm;
  const missSw = [];
  while ((rm = refRe.exec(HIDX))) {
    const u = rm[1];
    if (/^(https?:|data:|#)/.test(u)) continue;
    const clean = u.split('?')[0];
    if (SW.indexOf("'./" + clean + "'") < 0) missSw.push(u);
  }
  check('v427-index.html 引用的本地资源全部在预缓存清单', missSw.length === 0, missSw.join(' ; '));
  // js/ 目录每个文件都必须在清单里（新增模块时最容易漏）
  const jsDir = path.join(__dirname, 'js');
  const jsMiss = fs.readdirSync(jsDir).filter(fn => SW.indexOf('./js/' + fn) < 0);
  check('v427-js 目录全部模块都在预缓存清单', jsMiss.length === 0, jsMiss.join(' ; '));
  // 断网兜底策略必须保留：ignoreSearch 让 ?v=__DWR_VERSION__ 的请求也能命中缓存
  check('v427-离线兜底用 ignoreSearch 匹配（兼容 ?v= 缓存参数）',
    /ignoreSearch:\s*true/.test(SW),
    'sw.js 的离线匹配没有 ignoreSearch，带 ?v= 的请求断网时取不到');
  // 缓存键带版本号，发版后旧缓存要被清掉
  check('v427-缓存键带版本且在 activate 里清理旧缓存',
    /const CACHE = 'dwr-v\d+'/.test(SW) && /caches\.delete\(k\)/.test(SW),
    '缓存键未带版本，或 activate 没有清理旧缓存');
  check('v427-Service Worker 只缓存 GET 且不回源跨域（数据不出本机）',
    /e.request.method !== 'GET'/.test(SW) && /url.origin !== location.origin/.test(SW),
    'sw.js 缺少「只 GET」或「不回源跨域」的守卫');

  /* v4.28 版本号注入链路。HANDOVER.md 把保留 index.html 的 __DWR_VERSION__ 占位符
     列为发布前检查项，但测试里只有一处弱覆盖：meta 标签被删、或 app.js 的版本显示
     逻辑被改坏，都不会有人知道——用户界面上的版本号会静默消失。 */
  const HV = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const SRC428 = fs.readFileSync(path.join(__dirname, 'js/app.js'), 'utf8');
  check('v428-index.html 保留 dwr-version meta 占位符（release.yml 的 sed 依赖它）',
    /<meta name=\"dwr-version\" content=\"__DWR_VERSION__\">/.test(HV),
    'dwr-version meta 占位符缺失或被改写，发版时版本号注入会失效');
  check('v428-样式表带 ?v= 缓存参数（发版后强制刷新 CSS）',
    /css\/style\.css\?v=__DWR_VERSION__/.test(HV),
    'style.css 的 ?v= 缓存参数缺失，发版后用户可能拿到旧样式');
  // app.js 必须读 meta 显示版本，且未注入时不显示（避免把占位符原文暴露给用户）
  check('v428-app.js 从 meta 读版本并写入页脚',
    /querySelector\(\'meta\[name=\"dwr-version\"]\'\)/.test(SRC428)
      && /footVer\.textContent/.test(SRC428),
    'app.js 没有从 dwr-version meta 读版本并写入页脚');
  check('v428-未注入版本时界面上不出现占位符原文',
    /fver\.indexOf\('__DWR_VERSION__'\) < 0/.test(SRC428) && /ver\.indexOf\('__DWR_VERSION__'\) < 0/.test(SRC428),
    'app.js 缺少占位符守卫，未发版时界面会显示 __DWR_VERSION__ 原文');
  const PJ28 = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  check('v428-package.json 版本号是三位 SemVer（release.yml 按 tag 截两段）',
    /^\d+\.\d+\.\d+$/.test(PJ28.version),
    'package.json version 不是 x.y.z 三段: ' + PJ28.version);

  /* v4.30 CLI 参数覆盖强度门禁。
     v418 只保证「README 写了全部参数」，不保证参数被验——v4.29 就查出
     四个参数（--limit / --exclude / --max-file-mb / --html）只在清单里出现、
     零行为覆盖。这里把「每个参数至少被一个测试套引用」变成断言，
     新增参数时若忘了补测试，这条会红。
     注意：这是下限守卫（防彻底没人管），不替代逐个验行为。 */
  const SCAN_SRC = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  // 全部测试套 + 网页端源码：参数可能在任意一套里被引用
  // 注意：不能把 scan.mjs 自己算进来——它声明了参数，算进来就永远「被引用」，
  // 门禁会失效（v4.30 第一版就犯了这个错，反向验证时注入新参数也没红）。
  const SUITES430 = ['test-app.mjs','test-formats.mjs','test-rules.mjs','test-roundtrip.mjs','test-report.mjs','test-coverage.mjs','test-concurrency.mjs','test-allparts.mjs','test-e2e.mjs','js/app.js']
    .map((x) => { try { return fs.readFileSync(path.join(__dirname, x), 'utf8'); } catch (e) { return ''; } })
    .join('\n');
  // 从 parseArgs 的 else-if 链抽参数名
  const flagRe = /a === '(--[a-z][a-z0-9-]*)'/g;
  const cliFlags = [];
  let fm;
  while ((fm = flagRe.exec(SCAN_SRC))) { if (cliFlags.indexOf(fm[1]) < 0) cliFlags.push(fm[1]); }
  check('v430-能从 scan.mjs 解析出 CLI 参数（防解析规则失效）',
    cliFlags.length >= 30, '只解析到 ' + cliFlags.length + ' 个，解析规则可能失效');
  const noCover = cliFlags.filter((fl) => SUITES430.indexOf("'" + fl + "'") < 0);
  check('v430-每个 CLI 参数至少被一个测试套引用', noCover.length === 0,
    '零覆盖: ' + noCover.join(', '));

  /* v4.31 util.js 报告构造 API。这些是用户直接接触的产物格式——CSV 要给 Excel
     双击打开、JSON 要能被解析——但 9 个导出在测试里零直接调用。
     本块用自己的 U，不依赖外层变量（踩过三次作用域坑）。 */
  const U = D.DWRUtil;
  check('v431-DWRUtil 已导出 9 个 API',
    !!U && typeof U.csvCell === 'function' && typeof U.buildReportCsv === 'function'
      && typeof U.buildReportJson === 'function' && typeof U.mapPool === 'function',
    'DWRUtil 导出不完整');

  // csvCell：RFC 4180 转义
  check('v431-csvCell 普通字符串不加引号', U.csvCell('abc') === 'abc', JSON.stringify(U.csvCell('abc')));
  check('v431-csvCell 含逗号加引号', U.csvCell('a,b') === '"a,b"', JSON.stringify(U.csvCell('a,b')));
  check('v431-csvCell null 输出空串', U.csvCell(null) === '', JSON.stringify(U.csvCell(null)));
  // 网页端导出的 CSV 同样走这份实现：文件名 / 命中词是外来内容，Excel 双击不能当公式跑
  const injCsv431 = U.buildScanReportCsv([], [{ path: '=4+5.txt', kind: 'txt', size: 1, hits: 1, matched: ['@内部'] }]);
  check('v470-网页端扫描报告 CSV 对外来值加文本前缀',
    /'=4\+5\.txt/.test(injCsv431) && /'@内部/.test(injCsv431), JSON.stringify(injCsv431));

  // buildReportCsv：CRLF 行尾 + 行首 # 元信息
  const csv431 = U.buildCleanReportCsv([['时间', '2026']], [{
    file: 'a,b.txt', hits: 2, matched: ['内部', '机密'], status: 'done', out: ''
  }]);
  check('v431-CSV 元信息行以 # 开头',
    csv431.indexOf('#时间,2026') === 0, JSON.stringify(csv431.slice(0, 30)));
  check('v431-CSV 表头与明细行齐全',
    /file,hits,matched,status,out/.test(csv431) && csv431.indexOf('内部 / 机密') >= 0,
    JSON.stringify(csv431));
  check('v431-CSV 用 CRLF 行尾',
    csv431.indexOf(String.fromCharCode(13) + String.fromCharCode(10)) >= 0, JSON.stringify(csv431.slice(-6)));

  // buildReportJson
  const js431 = U.buildCleanReportJson([['时间', '2026']], [{ file: 'a.txt', hits: 1, matched: ['内部'], status: 'done', out: '' }]);
  let parsed431 = null;
  try { parsed431 = JSON.parse(js431); } catch (e) { parsed431 = null; }
  check('v431-JSON 可解析且结构为 meta files',
    !!parsed431 && parsed431.meta['时间'] === '2026'
      && Array.isArray(parsed431.files) && parsed431.files.length === 1,
    JSON.stringify(js431).slice(0, 120));

  // 扫描报告用另一套列
  const scanCsv = U.buildScanReportCsv([], [{ path: 'x.txt', kind: 'txt', size: 10, hits: 1, matched: ['内部'] }]);
  check('v431-扫描报告 CSV 用自己的列顺序',
    /path,kind,size,hits,matched/.test(scanCsv), JSON.stringify(scanCsv));

  // suggestedConcurrency：保守区间 [2,8]
  const sc = U.suggestedConcurrency();
  check('v431-suggestedConcurrency 落在 [2,8]', sc >= 2 && sc <= 8, 'sc=' + sc);

  // mapPool：顺序一致 + 单任务失败不拖垮整体
  const mp = await U.mapPool([1, 2, 3, 4, 5], 2, (n) => Promise.resolve(n * 2));
  check('v431-mapPool 结果顺序与输入一致', JSON.stringify(mp) === '[2,4,6,8,10]', JSON.stringify(mp));
  const mpErr = await U.mapPool([1, 2, 3], 2, (n) => (n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n)));
  check('v431-mapPool 单任务失败不影响其余',
    mpErr[0] === 1 && mpErr[2] === 3 && mpErr[1] && mpErr[1].__error,
    JSON.stringify(mpErr.map((x) => (x && x.__error ? 'ERR' : x))));

  /* v4.32 report.js 解析内部件。编码探测错了整个报告读不出、实体解码错了
     关键字匹配不上、路径认不出则行定位全部失败——这三个是报告解析的地基，
     但此前只在 parseHtml 全链路里被间接覆盖，没有直接断言。 */
  const RP = D.DWRReport;
  // 无 BOM 的 UTF-16：ASCII 隔位零字节是最强特征
  function u16le(s) {
    var a = [];
    for (var i = 0; i < s.length; i++) { a.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8); }
    return new Uint8Array(a);
  }
  check('v432-detectEncoding 认出无 BOM 的 UTF-16LE',
    RP.detectEncoding(u16le('<html>test</html>')) === 'utf-16le',
    RP.detectEncoding(u16le('<html>test</html>')));
  check('v432-detectEncoding 认出带 BOM 的 UTF-16LE',
    RP.detectEncoding(new Uint8Array([0xFF, 0xFE].concat(Array.from(u16le('abc'))))) === 'utf-16le');
  check('v432-detectEncoding 认出 UTF-8（有无 BOM）',
    RP.detectEncoding(new TextEncoder().encode('<html>x</html>')) === 'utf-8'
      && RP.detectEncoding(new Uint8Array([0xEF, 0xBB, 0xBF].concat(Array.from(new TextEncoder().encode('abc'))))) === 'utf-8');

  // decodeEntities：HTML 实体 → 字符（关键字列常被转义）
  check('v432-decodeEntities 十六进制实体', RP.decodeEntities('&#x5185;') === '内', JSON.stringify(RP.decodeEntities('&#x5185;')));
  check('v432-decodeEntities 十进制实体', RP.decodeEntities('&#20869;') === '内', JSON.stringify(RP.decodeEntities('&#20869;')));
  check('v432-decodeEntities 命名实体', RP.decodeEntities('&amp;') === '&', JSON.stringify(RP.decodeEntities('&amp;')));
  check('v432-decodeEntities 未知实体原样保留',
    RP.decodeEntities('&nosuch;') === '&nosuch;', JSON.stringify(RP.decodeEntities('&nosuch;')));
  check('v432-decodeEntities 无实体原文返回',
    RP.decodeEntities('abc') === 'abc' && RP.decodeEntities('') === '',
    JSON.stringify(RP.decodeEntities('abc')));

  // parseKeywords：词(次数) 列表，中英文分隔都要认，括号与次数要剥掉
  check('v432-parseKeywords 英文分隔',
    JSON.stringify(RP.parseKeywords('秘密(1)|内部(2)')) === '["秘密","内部"]',
    JSON.stringify(RP.parseKeywords('秘密(1)|内部(2)')));
  check('v432-parseKeywords 中文分隔',
    JSON.stringify(RP.parseKeywords('秘密(1)，内部(2)')) === '["秘密","内部"]',
    JSON.stringify(RP.parseKeywords('秘密(1)，内部(2)')));
  check('v432-parseKeywords 空值与重复',
    RP.parseKeywords('').length === 0 && RP.parseKeywords(null).length === 0
      && JSON.stringify(RP.parseKeywords('内部(1)|内部(2)')) === '["内部"]',
    JSON.stringify(RP.parseKeywords('内部(1)|内部(2)')));

  // isPathLike：Windows / UNC / POSIX 都要认（CI 在 Linux 跑，POSIX 认不出则测试必挂）
  check('v432-isPathLike 三种绝对路径都认',
    RP.isPathLike('C:\\a\\b.txt') && RP.isPathLike('D:/a/b.txt')
      && RP.isPathLike('\\\\srv\\share\\a') && RP.isPathLike('/usr/local/a'),
    '');
  check('v432-isPathLike 相对路径不认',
    !RP.isPathLike('a/b.txt') && !RP.isPathLike(''),
    '');
  /* v4.32 format.js 的 fmtSize 与 undo.js 的撤销批次 API.
     fmtSize 是用户直接在文件表格里看的大小列；undo 的 record/latest/dropLatest
     是一键撤销的全部逻辑——撤销错了会覆盖用户文件，行为必须锁死。 */
  const FM = D.DWRFormat;
  const UN = D.DWRUndo;
  check('v433-DWRFormat 与 DWRUndo 均已导出',
    !!FM && typeof FM.fmtSize === 'function' && !!UN && typeof UN.record === 'function',
    'FM=' + !!FM + ' UN=' + !!UN);

  // fmtSize：B / KB / MB 三档，1024 进位，一位小数
  check('v433-fmtSize 字节档不加小数',
    FM.fmtSize(0) === '0 B' && FM.fmtSize(512) === '512 B' && FM.fmtSize(1023) === '1023 B',
    FM.fmtSize(0) + ' / ' + FM.fmtSize(512) + ' / ' + FM.fmtSize(1023));
  check('v433-fmtSize 1024 进位到 KB 且一位小数',
    FM.fmtSize(1024) === '1.0 KB' && FM.fmtSize(1536) === '1.5 KB',
    FM.fmtSize(1024) + ' / ' + FM.fmtSize(1536));
  check('v433-fmtSize 1MB 进位到 MB',
    FM.fmtSize(1048576) === '1.0 MB' && FM.fmtSize(5242880) === '5.0 MB',
    FM.fmtSize(1048576) + ' / ' + FM.fmtSize(5242880));

  // undo：先清空，避免受其他测试节影响
  while (UN.latest()) UN.dropLatest();
  check('v433-undo 空栈时 latest 为 null', UN.latest() === null, JSON.stringify(UN.latest()));
  check('v433-undo record 空数组不写入',
    (UN.record([]), UN.count() === 0), 'count=' + UN.count());

  // record 后 latest 取到该批，字段完整
  UN.record([{ path: 'a.txt', size: 10 }, { path: 'b.txt', size: 20 }]);
  const ub = UN.latest();
  check('v433-undo record 后 latest 取到该批且字段完整',
    !!ub && ub.count === 2 && ub.items.length === 2
      && ub.items[0].path === 'a.txt' && ub.items[1].size === 20
      && typeof ub.at === 'number',
    JSON.stringify(ub));

  // dropLatest 弹出最近一批，栈变空
  const dropped = UN.dropLatest();
  check('v433-undo dropLatest 弹出最近一批',
    !!dropped && dropped.count === 2 && UN.latest() === null && UN.count() === 0,
    JSON.stringify(dropped));

  // 超过 5 批时丢弃最旧的（写入只保留后 5 批）
  for (let i = 0; i < 7; i++) UN.record([{ path: 'p' + i + '.txt', size: i }]);
  check('v433-undo 超过 5 批只保留最近 5 批',
    UN.count() === 5 && UN.latest().items[0].path === 'p6.txt',
    'count=' + UN.count() + ' last=' + (UN.latest() && UN.latest().items[0].path));
  // 最旧的两批（p0/p1）应已被丢弃
  let undoTail = null;
  for (let i = 0; i < 4; i++) undoTail = UN.dropLatest();
  check('v433-undo 丢弃的是最旧批次（FIFO）',
    !!undoTail && undoTail.items[0].path === 'p3.txt' && UN.count() === 1,
    JSON.stringify(undoTail));

  // fmtTime：YYYY-MM-DD HH:mm，个位补零
  const ft = UN.fmtTime(new Date(2026, 0, 5, 9, 7).getTime());
  check('v433-fmtTime 格式为 YYYY-MM-DD HH:mm 且补零',
    /^2026-01-05 09:07$/.test(ft), ft);
  check('v433-fmtTime 异常输入返回空串',
    UN.fmtTime(NaN) === '', JSON.stringify(UN.fmtTime(NaN)));
  /* v4.33 ui.js 的 bindMoreMenu——「更多 ▾」浮层通用逻辑。
     它被三处复用（工具栏 / 扫描设置 / 词库），但此前只有静态源码检查，
     没有一条真跑行为：开合、Esc 关闭并回焦、点外面关闭、点内部不冒泡、
     aria-expanded 同步——这些用户每次都用，改坏了没人知道。
     Playwright 实测确认当前实现全部正确（v4.33 记录），这里把行为锁死。 */
  console.log('MARK34-A');
  const UI = D.DWRUi;
  console.log('MARK34-B UI=' + (UI ? Object.keys(UI).join(',') : 'MISSING'));
  check('v434-DWRUi 导出 bindMoreMenu 与 bindTips',
    !!UI && typeof UI.bindMoreMenu === 'function' && typeof UI.bindTips === 'function',
    'keys=' + (UI ? Object.keys(UI).join(',') : 'none'));

  // 造一对按钮 + 浮层，跑真实 bindMoreMenu
  const mBtn = el('v434MoreBtn');
  const mPop = el('v434MorePop');
  mPop.hidden = true;
  mBtn._handlers = {};
  mPop._handlers = {};
  UI.bindMoreMenu(mBtn, mPop);
  check('v434-初始为隐藏且尚未设置 aria-expanded',
    mPop.hidden === true && mBtn.getAttribute('aria-expanded') === null,
    'hidden=' + mPop.hidden);
  // 点击展开，aria-expanded 同步为 true
  fire(mBtn, 'click', { target: mBtn, stopPropagation() {} });
  check('v434-点击展开且 aria-expanded 同步',
    mPop.hidden === false && mBtn.getAttribute('aria-expanded') === 'true',
    'hidden=' + mPop.hidden + ' exp=' + mBtn.getAttribute('aria-expanded'));
  // 再点一次收起
  fire(mBtn, 'click', { target: mBtn, stopPropagation() {} });
  check('v434-再点一次收起',
    mPop.hidden === true && mBtn.getAttribute('aria-expanded') === 'false',
    'hidden=' + mPop.hidden);
  // Esc 关闭并把焦点还给触发按钮
  fire(mBtn, 'click', { target: mBtn, stopPropagation() {} });
  fire(documentStub, 'keydown', { key: 'Escape' });
  check('v434-Esc 关闭浮层且 aria-expanded 归位',
    mPop.hidden === true && mBtn.getAttribute('aria-expanded') === 'false',
    'hidden=' + mPop.hidden);
  // Esc 时已隐藏则不应改变状态（不误弹）
  fire(documentStub, 'keydown', { key: 'Escape' });
  check('v434-Esc 在已隐藏时不改变状态',
    mPop.hidden === true, 'hidden=' + mPop.hidden);
  // 展开后点「外面」（document 级 click）应关闭
  fire(mBtn, 'click', { target: mBtn, stopPropagation() {} });
  fire(documentStub, 'click', { target: documentStub });
  check('v434-点外面关闭浮层',
    mPop.hidden === true, 'hidden=' + mPop.hidden);
  // 点浮层内部不应冒泡到 document 而关闭
  fire(mBtn, 'click', { target: mBtn, stopPropagation() {} });
  const stopCalled = [];
  fire(mPop, 'click', { target: mPop, stopPropagation() { stopCalled.push(1); } });
  check('v434-点浮层内部不关闭且阻止冒泡',
    mPop.hidden === false && stopCalled.length === 1,
    'hidden=' + mPop.hidden + ' stopProp=' + stopCalled.length);
  // app.js 三处都挂了（工具栏 / 扫描设置 / 词库）
  const APPUI = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  const moreCalls = (APPUI.match(/bindMoreMenu\(/g) || []).length;
  check('v434-app.js 三处复用 bindMoreMenu', moreCalls === 3, 'calls=' + moreCalls);

  /* v4.34 ooxml.js 的格式常量与 isTextFile / encodeXml / decodeXml。
     isTextFile 是格式判定的地基：判错就走错处理路径，结果完全错误。
     这 8 个导出此前只被别的函数内部使用，没有一条直接断言。 */
  const DX = D.DWRDoc;
  check('v435-格式常量齐全（文本/Word/Excel/PPT/Office/主流）',
    Array.isArray(DX.TEXT_EXT) && Array.isArray(DX.WORD_EXT)
      && Array.isArray(DX.EXCEL_EXT) && Array.isArray(DX.PPT_EXT)
      && Array.isArray(DX.OFFICE_EXT) && Array.isArray(DX.COMMON_EXT),
    'T=' + DX.TEXT_EXT.length + ' W=' + DX.WORD_EXT.length
      + ' X=' + DX.EXCEL_EXT.length + ' P=' + DX.PPT_EXT.length);
  // OFFICE_EXT 应是三类之和，且文本与 Office 无交集（否则 isTextFile 自相矛盾）
  const officeAll = DX.WORD_EXT.concat(DX.EXCEL_EXT, DX.PPT_EXT);
  check('v435-OFFICE_EXT 是三类并集且与 TEXT_EXT 无交集',
    DX.OFFICE_EXT.length === officeAll.length
      && DX.TEXT_EXT.every((e) => DX.OFFICE_EXT.indexOf(e) < 0),
    'office=' + DX.OFFICE_EXT.length + ' union=' + officeAll.length);

  // isTextFile：主流文本认、Office 与二进制不认、大小写不敏感
  check('v435-isTextFile 认出主流文本格式',
    DX.isTextFile('a.txt') && DX.isTextFile('a.md') && DX.isTextFile('a.csv')
      && DX.isTextFile('a.json') && DX.isTextFile('a.xml') && DX.isTextFile('a.html')
      && DX.isTextFile('a.log') && DX.isTextFile('a.py') && DX.isTextFile('a.yml'),
    '');
  check('v435-isTextFile 不认 Office 与二进制',
    !DX.isTextFile('a.docx') && !DX.isTextFile('a.doc') && !DX.isTextFile('a.xlsx')
      && !DX.isTextFile('a.pptx') && !DX.isTextFile('a.docm') && !DX.isTextFile('a.dotx')
      && !DX.isTextFile('a.potx') && !DX.isTextFile('a.ppsx')
      && !DX.isTextFile('a.pdf') && !DX.isTextFile('a.png') && !DX.isTextFile('a'),
    '');
  check('v435-isTextFile 大小写不敏感',
    DX.isTextFile('a.TXT') && DX.isTextFile('a.Md') && !DX.isTextFile('a.DOCX'),
    '');

  // encodeXml / decodeXml：五个 XML 实体 + 往返一致
  check('v435-encodeXml 转义五个 XML 字符',
    DX.encodeXml('<a>&"x"') === '&lt;a&gt;&amp;&quot;x&quot;',
    JSON.stringify(DX.encodeXml('<a>&"x"')));
  check('v435-decodeXml 还原实体（含十六进制）',
    DX.decodeXml('&lt;a&gt;&amp;&#x5185;') === '<a>&内',
    JSON.stringify(DX.decodeXml('&lt;a&gt;&amp;&#x5185;')));
  check('v435-encodeXml 与 decodeXml 往返一致',
    DX.decodeXml(DX.encodeXml('内部<机密>&')) === '内部<机密>&',
    JSON.stringify(DX.decodeXml(DX.encodeXml('内部<机密>&'))));
  check('v435-decodeXml 无实体原文返回',
    DX.decodeXml('abc') === 'abc' && DX.decodeXml('') === '',
    JSON.stringify(DX.decodeXml('abc')));
  /* v4.35 rules.js 的 normalizeWithMap / normalizePattern / escapeRegExp.
     normalizeWithMap 是反规避归一的核心：它产出的 map 把归一化后的位置映射回
     原文位置，整个「插零宽 / 全角 / 空格变体」的命中区间定位都建立在它上面。
     这三个导出此前只被别的函数内部使用，没有一条直接断言。 */
  const RL = D.DWRRules;
  const nw = (s) => RL.normalizeWithMap(s);
  check('v436-normalizeWithMap 纯净文本原样返回且 gap 全 false',
    (() => { const r = nw('内部'); return r.norm === '内部' && r.map.length === 3 && r.gap.every((g) => g === false); })(),
    JSON.stringify(nw('内部')));
  check('v436-normalizeWithMap 剔除空格并在 gap 标位',
    (() => { const r = nw('内 部'); return r.norm === '内部' && r.gap[1] === true && r.gap[0] === false && r.gap[2] === false; })(),
    JSON.stringify(nw('内 部')));
  check('v436-normalizeWithMap 剔除零宽空格',
    nw('内​部').norm === '内部' && nw('内​部').gap[1] === true,
    JSON.stringify(nw('内​部')));
  check('v436-normalizeWithMap 剔除软连字符',
    nw('内­部').norm === '内部',
    JSON.stringify(nw('内­部')));
  check('v436-normalizeWithMap 全角折半角且不计入 gap',
    (() => { const r = nw('ＡＢ'); return r.norm === 'AB' && r.map.length === 3 && r.gap.every((g) => g === false); })(),
    JSON.stringify(nw('ＡＢ')));
  check('v436-normalizeWithMap 全角空格也剔除并计 gap',
    (() => { const r = nw('a　b'); return r.norm === 'ab' && r.gap[1] === true; })(),
    JSON.stringify(nw('a　b')));
  // map 单调不减：归一化位置能映射回原文位置（区间定位的地基）
  check('v436-normalizeWithMap 的 map 单调不减',
    (() => { const r = nw('内 部​机­密');
      for (let i = 1; i < r.map.length; i++) if (r.map[i] < r.map[i - 1]) return false;
      return r.map.length === r.norm.length + 1 && r.gap.length === r.norm.length + 1; })(),
    JSON.stringify(nw('内 部​机­密')));

  // normalizePattern 必须等于 normalizeWithMap(x).norm（两处口径不能分叉）
  check('v436-normalizePattern 与 normalizeWithMap 的 norm 一致',
    RL.normalizePattern('内部') === nw('内部').norm
      && RL.normalizePattern('内 部') === nw('内 部').norm
      && RL.normalizePattern('ＡＢ') === nw('ＡＢ').norm,
    JSON.stringify(RL.normalizePattern('内 部')));

  // escapeRegExp：五个正则元字符都要转义
  check('v436-escapeRegExp 转义正则元字符',
    RL.escapeRegExp('a.b*c+d?') === 'a\\.b\\*c\\+d\\?',
    JSON.stringify(RL.escapeRegExp('a.b*c+d?')));
  check('v436-escapeRegExp 转义括号（中文规则同样可能带括号）',
    RL.escapeRegExp('内部(机密)') === '内部\\(机密\\)',
    JSON.stringify(RL.escapeRegExp('内部(机密)')));
  check('v436-escapeRegExp 普通中文不加转义',
    RL.escapeRegExp('内部资料') === '内部资料',
    JSON.stringify(RL.escapeRegExp('内部资料')));
  /* v4.36 util.js 的 buildScanReportJson——扫描报告 JSON 构建。
     它与 buildCleanReportJson 的关键差别：扫描报告**原样透传**所有字段
     （要保留检查软件的原始数据），清除报告只保留 5 个规定字段。
     这个差别此前后任何断言都没锁。 */
  const scanRows437 = [{ path: 'x.txt', kind: 'txt', size: 10, hits: 1, matched: ['内部'], extra: 'keepme' }];
  let sj437 = null;
  try { sj437 = JSON.parse(U.buildScanReportJson([['时间', '2026']], scanRows437)); } catch (e) { sj437 = null; }
  check('v437-buildScanReportJson 可解析且结构为 meta files',
    !!sj437 && sj437.meta['时间'] === '2026' && Array.isArray(sj437.files) && sj437.files.length === 1,
    JSON.stringify(sj437).slice(0, 120));
  // 扫描报告原样透传：额外字段必须保留（检查软件原始数据）
  check('v437-buildScanReportJson 原样透传字段（含额外字段）',
    !!sj437 && sj437.files[0].path === 'x.txt' && sj437.files[0].kind === 'txt'
      && sj437.files[0].size === 10 && sj437.files[0].hits === 1
      && Array.isArray(sj437.files[0].matched) && sj437.files[0].extra === 'keepme',
    JSON.stringify(sj437 && sj437.files[0]));
  // 与清除报告对照：清除报告只保留 5 个规定字段，额外字段被丢弃
  let cj437 = null;
  try { cj437 = JSON.parse(U.buildCleanReportJson([['时间', '2026']],
    [{ file: 'a.txt', hits: 1, matched: ['内部'], status: 'done', out: '', extra: 'dropme' }])); } catch (e) { cj437 = null; }
  check('v437-清除报告只保留规定字段（与扫描报告的透传形成对照）',
    !!cj437 && cj437.files[0].extra === undefined && cj437.files[0].file === 'a.txt',
    JSON.stringify(cj437 && cj437.files[0]));

  // tidySpace 与三档写出路径的静态接线（真实磁盘行为需 File System Access API）
  check('v423-tidySpace 在真实处理路径按 touched 生效',
    /if \(\$\('tidySpace'\)\.checked && r\.touched\) r\.text = Rules\.tidy\(r\.text\);/.test(SRC),
    'processOne 里找不到 tidySpace + touched 的条件');
  check('v423-tidySpace 在预览路径同样生效（预览=写出结果）',
    /if \(\$\('tidySpace'\)\.checked\) effective\.text = Rules\.tidy\(effective\.text\);/.test(SRC),
    'renderPreviewSource 里找不到 tidySpace 的条件');
  /* v4.39 Rules.tidy 的行为断言。上面两条只验了「源码里有那行 if」，
     没有一条真跑过 tidy 本身——而它的行为有细节（多空格折叠、尾部空白清除、
     空行与制表符不动），改坏了界面上看不出来。 */
  const T = D.DWRRules;
  check('v439-Rules.tidy 是函数且空串安全',
    typeof T.tidy === 'function' && T.tidy('') === '',
    JSON.stringify(T.tidy('')));
  check('v439-tidy 折叠连续空格为一个',
    T.tidy('内部  机密') === '内部 机密',
    JSON.stringify(T.tidy('内部  机密')));
  // 首部空白保留、尾部空白清除（实测行为，v4.39 锁死）
  check('v439-tidy 清尾部空白且保留首部',
    T.tidy('  内部  ') === ' 内部',
    JSON.stringify(T.tidy('  内部  ')));
  // 空行与制表符不归 tidy 管（动了会改变文档结构）
  check('v439-tidy 不动空行与制表符',
    T.tidy('内部\n\n\n机密') === '内部\n\n\n机密'
      && T.tidy('内部\t机密') === '内部\t机密',
    JSON.stringify(T.tidy('内部\n\n\n机密')));
  check('v439-tidy 无多余空格时原样返回',
    T.tidy('内部机密') === '内部机密',
    JSON.stringify(T.tidy('内部机密')));
  check('v423-三档输出方式都接到写出路径',
    /outmode === 'zip'/.test(SRC) && /outmode === 'newfolder'/.test(SRC) && /outmode === 'inplace'/.test(SRC),
    'zip / newfolder / inplace 有分支没接');
  check('v423-覆盖原文件分支受 backup 开关控制',
    /} else if \(outmode === 'inplace'\) \{[\s\S]{0,240}if \(\$\('backup'\)\.checked\)/.test(SRC),
    'inplace 分支里没有按 backup 决定是否备份');
}
/* ---------------- 全局不变量：以上任何一节都不得产生运行时错误 ----------------
   fire() 把 app.js handler 的异常收进 handlerErrors、console.error 进 errors；
   收尾统一复查一次，保证全部章节都被这层保护覆盖（v2.37 引入，v2.71 事故后随本章重建）。
   顶层未捕获异常不走这条路：见上面 abortOn()，记录后立刻非零退出，绝不留下半截绿灯。 */
check("全局-全程无运行时错误（handler 异常 / unhandledRejection / console.error）",
  errors.length + handlerErrors.length === 0, errors.concat(handlerErrors).join(" | "));


console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
