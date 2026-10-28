    // notBeforeRe 锚定 $ 时 pre 的结尾带上了换行，排除不生效。这是真实行为，锁住。
/**
 * test-rules.mjs —— 准确性回归测试（反规避 / 防误伤 / 编码 / 端到端 / CLI）
 *
 * 覆盖 v1.5 准确性优化的全部行为，防止回归：
 *  A. 反规避归一化：零宽 / 软连字符 / 全角 / 空格混淆写法必须命中，不可见字符随命中一并清除；
 *  A3. 繁体容错：「內部 / 機密 / 絕密」等繁体写法命中，一字多繁的传统字（臺 / 髮 / 製…）绝不误伤；
 *  B. 上下文排除：默认密级词直接命中，自定义排除项仍生效；
 *  C. 整词匹配：AI 不误伤 said / armchair，全角 ＡＩ 仍命中，中文规则不受影响；
 *  D. 编码：UTF-16 LE / BE 文本正确解码、脱敏并回写 UTF-8 BOM；
 *  E. 快慢路径一致：触发与不触发归一化时，清除结果一致；
 *  F. 动作兼容：mask / custom 在归一化路径下同样生效；
 *  G. 端到端：docx 跨 run + 零宽字符的敏感词被彻底清除，页眉密级词一并清除；
 *  H. CLI：--words / --whole / --exclude-ctx / --case-sensitive。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
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

/* C18) v4.56 符号插字规避的字符覆盖面：SEP_CHARS 与 SEP_MAX。
   README 承诺「符号插字规避：在敏感词字符之间插入标点 / 符号（『内·部』『机-密』
   『内_部』『内(部)』等）仍需命中」。
   SEP_CHARS 收录取 66 个连接性符号（中间点 / 短横 / 下划线 / 斜杠 / 括号 / 书名号…及全角形式），
   既有 17 条用例只覆盖了其中一部分；SEP_MAX=3 的上限则**一条断言都没有**——
   有人把它改成 0 或 1，测试一片绿，而插字规避整体失效。 */
{
  const RS = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
  const tail = '  global.DWRRules = {';
  const patched = RS.replace(tail,
    '  global.__sepsrc = SEP_SRC;\n  global.__sepchars = SEP_CHARS;\n  global.__max = SEP_MAX;\n  global.__scan = SEP_SCAN_RE;\n' + tail);
  const c2 = {
    TextEncoder, TextDecoder,
    String: String, RegExp: RegExp, Array: Array, Object: Object, Math: Math,
    JSON: JSON, console: { log() {}, warn() {}, error() {} },
  };
  c2.window = c2;
  vm.createContext(c2);
  vm.runInContext(patched, c2);
  const SEP = c2.__sepchars;
  const MAX = c2.__max;
  const SCAN = c2.__scan;
  check('v456-SEP 内部件可取到',
    Array.isArray(SEP) && typeof MAX === 'number' && SCAN instanceof RegExp,
    'SEP=' + (Array.isArray(SEP) ? SEP.length : typeof SEP) + ' MAX=' + typeof MAX);

  // ① 66 个符号逐类验证：每个插在「内」「部」之间都必须命中
  {
    const eng = D.DWRRules.createEngine({
      rules: [{ text: '内部', type: 'text', enabled: true }],
      scope: 'all', action: 'delete', custom: ''
    });
    const bad = SEP.filter((s) => eng.apply('内' + s + '部', true, true).hits !== 1);
    check('v456-SEP_CHARS 逐符号命中（' + SEP.length + ' 个）', bad.length === 0,
      bad.map((s) => 'U+' + s.charCodeAt(0).toString(16)).join(','));

    // ② SEP_MAX 上限：MAX 个连续分隔符仍命中，MAX+1 个不命中（防回溯爆炸的设计）
    // 边界用字面量 3 / 4，不读 MAX 变量——否则改常量时期待值跟着变，断言变成自证
    const atMax = eng.apply('内' + '-'.repeat(3) + '部', true, true);
    const overMax = eng.apply('内' + '-'.repeat(4) + '部', true, true);
    check('v456-SEP_MAX 锁死为 3（3 个命中 / 4 个不命中）',
      MAX === 3 && atMax.hits === 1 && overMax.hits === 0,
      'MAX=' + MAX + ' atMax=' + atMax.hits + ' overMax=' + overMax.hits);

    // ③ 混合不同类分隔符：总数不超上限时仍命中
    const mixed = eng.apply('内' + '·-_' + '部', true, true);
    check('v456-混合 3 个不同类分隔符仍命中（不超过 MAX）',
      MAX >= 3 ? mixed.hits === 1 : true,
      'hits=' + mixed.hits + ' MAX=' + MAX);

    // ④ 三字词逐字插符号（既有用例的加强版：每个字间都插）
    const eng3 = D.DWRRules.createEngine({
      rules: [{ text: '国家秘密', type: 'text', enabled: true }],
      scope: 'all', action: 'delete', custom: ''
    });
    const r3 = eng3.apply('国·家-秘密', true, true);
    check('v456-三字词逐字插符号一次清完',
      r3.hits === 1 && r3.text === '',
      JSON.stringify(r3.text) + ' hits=' + r3.hits);

    // ⑤ SEP_SCAN_RE 与 SEP_CHARS 口径一致（快路径判据不能漏字符）
    const scanBad = SEP.filter((s) => !SCAN.test(s));
    check('v456-SEP_SCAN_RE 覆盖全部 SEP_CHARS', scanBad.length === 0,
      scanBad.map((s) => 'U+' + s.charCodeAt(0).toString(16)).join(','));

    // ⑥ 生成的 SEP_SRC 是合法正则且带 {0,MAX} 量词
    const srcOk = c2.__sepsrc.charAt(0) === '[' && c2.__sepsrc.indexOf(']{0,' + MAX + '}') === c2.__sepsrc.length - ((']{0,' + MAX + '}').length);
    let compiles = true;
    try { new RegExp(c2.__sepsrc); } catch (e) { compiles = false; }
    check('v456-SEP_SRC 形态正确且可编译', srcOk && compiles,
      JSON.stringify(c2.__sepsrc.slice(0, 60)));
  }
}


/** 与 app.js / scan.mjs 一致：默认词库连同自带的排除上下文一起装配 */
function presetRules() {
  return D.DWRRules.DEFAULT_PRESETS.map((p) => ({
    text: p.word, type: 'text', enabled: true,
    notBefore: p.notBefore, notAfter: p.notAfter, whole: p.whole
  }));
}
function engine(rules, extra) {
  return D.DWRRules.createEngine(Object.assign({ rules: rules, scope: 'all', action: 'delete', custom: '' }, extra || {}));
}
function clean(text, eng) { return eng.apply(text, true, true).text; }

const defaultEngine = engine(presetRules());

/* ================= A. 反规避归一化 ================= */
{
  const cases = [
    ['零宽空格 ZWSP', '这是内\u200b部文件', '这是文件'],
    ['零宽不连字 + 连接符', '内\u200c\u200d部', ''],
    ['软连字符', '机\u00ad密', ''],
    ['行首 BOM 夹带', '\ufeff内部资料', '\ufeff资料'],
    ['全角空格', '内\u3000部', ''],
    ['半角空格', '内 部', ''],
    ['制表符', '内\t部', ''],
    ['混合规避', '机\u200b密 文\u3000件', ' 文\u3000件'],
  ];
  for (const [name, input, expect] of cases) {
    const r = defaultEngine.apply(input, true, true);
    check('规避-' + name, r.text === expect && r.hits === 1, '得到 ' + JSON.stringify(r.text) + ' hits=' + r.hits);
  }

  const noInvisible = clean('这是内\u200b部、机\u00ad密文件', defaultEngine);
﻿  /* ---- A2. 符号插字规避（v2.1） ---- */
  const sepCases = [
    ['中间点', '内·部资料', '资料'],
    ['全角中间点', '内･部', ''],
    ['短横线', '机-密', ''],
    ['下划线', '内_部', ''],
    ['斜杠', '内/部', ''],
    ['反斜杠', '内\\部', ''],
    ['空格 + 符号', '内 - 部', ''],
    ['连续分隔符', '机--密', ''],
    ['波浪号', '内~部', ''],
    ['加号', '内+部', ''],
    ['星号', '机*密', ''],
    ['逗号', '内，部', ''],
    ['句号', '机。密', ''],
    ['书名号', '内《部》', ''],
    ['圆括号', '内(部)', ''],
    ['方括号包裹', '【机密】', ''],
    ['英文括号包裹', '(机密)', ''],
  ];
  const threeEngine = engine([{ text: '国家秘密', type: 'text', enabled: true }]);
  const asciiEngine = engine([{ text: 'AI', type: 'text', enabled: true, whole: true }]);
  const three = threeEngine.apply('国·家-秘密', true, true);
  check('插字-三字词逐字插符号', three.text === '' && three.hits === 1, JSON.stringify(three.text) + ' hits=' + three.hits);
  const ascii = asciiEngine.apply('A·I 文档', true, true);
  check('插字-ASCII 词被符号分开', ascii.text === ' 文档' && ascii.hits === 1, JSON.stringify(ascii.text) + ' hits=' + ascii.hits);
  for (const [name, input, expect] of sepCases) {
    const r = defaultEngine.apply(input, true, true);
    check('插字-' + name, r.text === expect && r.hits === 1, '得到 ' + JSON.stringify(r.text) + ' hits=' + r.hits);
  }

  const noCross = clean('公司。内部资料，机密文件', defaultEngine);
  check('插字-不跨句误伤', noCross === '公司。资料，文件', noCross);

  const keepBrackets = clean('（公司）内部资料', defaultEngine);
  check('插字-无关括号保留', keepBrackets === '（公司）资料', keepBrackets);

  // v2.27：括号「成对才清、缺配对保留」
  const halfBracket = clean('（内部72007年', defaultEngine);
  check('插字-半括号保留左括号', halfBracket === '（72007年', halfBracket);
  const leadGroup = clean('第（3号机密文件', defaultEngine);
  check('插字-无关前导括号保留', leadGroup === '第（3号文件', leadGroup);
  const fullWidthInner = defaultEngine.apply('内（部）', true, true);
  check('插字-全角词内括号', fullWidthInner.text === '' && fullWidthInner.hits === 1, JSON.stringify(fullWidthInner.text) + ' hits=' + fullWidthInner.hits);

  const mixedAll = defaultEngine.apply('内部、机-密、绝密', true, true);
  check('插字-混合规避一次清三种', mixedAll.text === '、、' && mixedAll.hits === 3, JSON.stringify(mixedAll.text) + ' hits=' + mixedAll.hits);

  check('规避-不可见字符随命中一并清除', !/[\u200b\u200c\u200d\u00ad\ufeff]/.test(noInvisible), noInvisible);

  const untouched = clean('内部文件与保密资料、受控清单', defaultEngine);
  check('规避-词库外词汇不受影响', untouched === '文件与保密资料、受控清单', untouched);

  const full = clean('绝密★30年', defaultEngine);
  check('规避-正常密级标识清除', full === '★30年', full);
  /* ---- A2b. 空格变体 / 格式字符规避（v2.20） ---- */
  const gapCases = [
    ['NBSP 不换行空格', '内\u00a0部', ''],
    ['EN QUAD', '内\u2000部', ''],
    ['EN SPACE', '内\u2002部', ''],
    ['EM SPACE', '内\u2003部', ''],
    ['THIN SPACE', '内\u2009部', ''],
    ['HAIR SPACE', '内\u200a部', ''],
    ['窄 NBSP', '内\u202f部', ''],
    ['数学空格', '内\u205f部', ''],
    ['Ogham 空格', '内\u1680部', ''],
    ['蒙古元音分隔符', '内\u180e部', ''],
    ['bidi 隔离符 LRI', '内\u2066部', ''],
    ['bidi 嵌入 LRE', '内\u202a部', ''],
    ['阿拉伯方向标记', '内\u061c部', ''],
    ['行分隔符 U+2028', '内\u2028部', ''],
    ['段分隔符 U+2029', '内\u2029部', ''],
    ['行内注释锚点', '内\ufff9部', ''],
    ['垂直制表符', '内\u000b部', ''],
    ['换页符', '内\u000c部', ''],
    ['多类字符叠加', '机\u2066\u00a0密', ''],
    ['繁体叠加 NBSP', '內\u00a0部', ''],
  ];
  for (const [name, input, expect] of gapCases) {
    const r = defaultEngine.apply(input, true, true);
    check('空格变体-' + name, r.text === expect && r.hits === 1, '得到 ' + JSON.stringify(r.text) + ' hits=' + r.hits);
  }

  const gapKept = clean('内部\u00a0资料、机密\u2028文件', defaultEngine);
  check('空格变体-区间外原样保留', gapKept === '\u00a0资料、\u2028文件', gapKept);
}

/* ================= A3. 繁体写法容错（v2.5） ================= */
{
  // 逐字生成「简体|繁体」字符类：繁体写法也该命中，但不做全局繁简转换（避免误伤）
  check('繁简-內部 命中', clean('這是內部文件', defaultEngine) === '這是文件', JSON.stringify(clean('這是內部文件', defaultEngine)));
  check('繁简-機密 命中', clean('機密文件', defaultEngine) === '文件', JSON.stringify(clean('機密文件', defaultEngine)));
  check('繁简-絕密 命中', clean('絕密★30年', defaultEngine) === '★30年', JSON.stringify(clean('絕密★30年', defaultEngine)));
  check('繁简-祕密 命中', clean('祕密事項', defaultEngine) === '事項', JSON.stringify(clean('祕密事項', defaultEngine)));
  const manualSecret = engine([{ text: '涉密', type: 'text' }]);
  check('繁简-手动添加「涉密」后仍可命中', clean('涉密資料', manualSecret) === '資料',
    JSON.stringify(clean('涉密資料', manualSecret)));
  // 繁体 + 符号插字叠加
  check('繁简-繁体叠加符号插字', clean('內·部', defaultEngine) === '', JSON.stringify(clean('內·部', defaultEngine)));
  // 规则本身写成繁体，也应命中简体正文
  const tradRule = engine([{ text: '內部', type: 'text' }]);
  check('繁简-繁体规则命中简体正文', clean('这是内部文件', tradRule) === '这是文件', JSON.stringify(clean('这是内部文件', tradRule)));
  // 默认词库不再排除商业前缀，繁体「商業機密」也只清密级词
  check('繁简-商業機密直接清除', clean('商業機密文件', defaultEngine) === '商業文件', JSON.stringify(clean('商業機密文件', defaultEngine)));
  // 一字多繁的传统字绝不做全局折叠：这些词必须原样保留
  const amb = engine([{ text: '台', type: 'text' }]);
  check('繁简-一对多字不误伤台湾', clean('臺灣商務', amb) === '臺灣商務', JSON.stringify(clean('臺灣商務', amb)));
  const amb2 = engine([{ text: '发', type: 'text' }]);
  check('繁简-一对多字不误伤头发', clean('頭髮护', amb2) === '頭髮护', JSON.stringify(clean('頭髮护', amb2)));
  // 正则规则不参与繁简宽容：用户写什么就匹配什么
  const reTrad = engine([{ text: '內部', type: 'regex' }]);
  check('繁简-正则规则原样匹配繁体', clean('內部文件', reTrad) === '文件', JSON.stringify(clean('內部文件', reTrad)));
  const reSimp = engine([{ text: '内部', type: 'regex' }]);
  check('繁简-正则规则不反向匹配繁体', clean('內部文件', reSimp) === '內部文件', JSON.stringify(clean('內部文件', reSimp)));
  // 快慢路径一致：正文只有繁体、无任何需折叠字符时走快速路径，结果仍须命中
  const fast = engine([{ text: '內部', type: 'text' }]);
  const viaFast = clean('內部', fast);
  const viaNorm = clean('內·部', fast);
  check('繁简-快慢路径一致', viaFast === '' && viaNorm === '', viaFast + ' / ' + viaNorm);
}


/* ================= A3b. 一字多繁上下文判别（v2.15） ================= */
{
  // 可判定写法：相邻字唯一确定繁体候选，多字规则应命中（此前整类漏报）
  const taiwan = engine([{ text: '台湾', type: 'text' }]);
  check('繁简-台湾命中臺灣', clean('臺灣商務協議', taiwan) === '商務協議', JSON.stringify(clean('臺灣商務協議', taiwan)));
  check('繁简-台湾仍命中简体', clean('台湾商务协议', taiwan) === '商务协议', JSON.stringify(clean('台湾商务协议', taiwan)));
  const hair = engine([{ text: '头发', type: 'text' }]);
  check('繁简-头发命中頭髮', clean('頭髮护理', hair) === '护理', JSON.stringify(clean('頭髮护理', hair)));
  const gan = engine([{ text: '干净', type: 'text' }]);
  check('繁简-干净命中乾淨', clean('乾淨整潔', gan) === '整潔', JSON.stringify(clean('乾淨整潔', gan)));
  const ganbu = engine([{ text: '干部', type: 'text' }]);
  check('繁简-干部命中幹部', clean('幹部名單', ganbu) === '名單', JSON.stringify(clean('幹部名單', ganbu)));
  const fabu = engine([{ text: '发布', type: 'text' }]);
  check('繁简-发布命中發布', clean('發布會通知', fabu) === '會通知', JSON.stringify(clean('發布會通知', fabu)));
  const zhizao = engine([{ text: '制造', type: 'text' }]);
  check('繁简-制造命中製造', clean('製造業產值', zhizao) === '業產值', JSON.stringify(clean('製造業產值', zhizao)));
  const fangsong = engine([{ text: '放松', type: 'text' }]);
  check('繁简-放松命中放鬆', clean('放鬆管制', fangsong) === '管制', JSON.stringify(clean('放鬆管制', fangsong)));
  const fuza = engine([{ text: '复杂', type: 'text' }]);
  check('繁简-复杂命中複雜', clean('複雜問題', fuza) === '問題', JSON.stringify(clean('複雜問題', fuza)));
  const fanfu = engine([{ text: '反复', type: 'text' }]);
  check('繁简-反复命中反覆', clean('反覆測試', fanfu) === '測試', JSON.stringify(clean('反覆測試', fanfu)));
  const mianbao = engine([{ text: '面包', type: 'text' }]);
  check('繁简-面包命中麵包', clean('麵包店', mianbao) === '店', JSON.stringify(clean('麵包店', mianbao)));
  const rili = engine([{ text: '日历', type: 'text' }]);
  check('繁简-日历命中日曆', clean('日曆', rili) === '', JSON.stringify(clean('日曆', rili)));
  const lishi = engine([{ text: '历史', type: 'text' }]);
  check('繁简-历史命中歷史', clean('歷史文件', lishi) === '文件', JSON.stringify(clean('歷史文件', lishi)));
  const taifeng = engine([{ text: '台风', type: 'text' }]);
  check('繁简-台风命中颱風', clean('颱風警報', taifeng) === '警報', JSON.stringify(clean('颱風警報', taifeng)));
  const jiekou = engine([{ text: '借口', type: 'text' }]);
  check('繁简-借口命中藉口', clean('藉口推託', jiekou) === '推託', JSON.stringify(clean('藉口推託', jiekou)));
  const zhiyou = engine([{ text: '只有', type: 'text' }]);
  check('繁简-只有命中衹有（港式写法）', clean('衹有一次', zhiyou) === '一次', JSON.stringify(clean('衹有一次', zhiyou)));
  const faxing = engine([{ text: '发型', type: 'text' }]);
  check('繁简-发型命中髮型', clean('髮型設計', faxing) === '設計', JSON.stringify(clean('髮型設計', faxing)));
  const guitai = engine([{ text: '柜台', type: 'text' }]);
  check('繁简-柜台命中櫃檯', clean('櫃檯人員', guitai) === '人員', JSON.stringify(clean('櫃檯人員', guitai)));
  const limian = engine([{ text: '里面', type: 'text' }]);
  check('繁简-里面命中裡面', clean('夾在裡面', limian) === '夾在', JSON.stringify(clean('夾在裡面', limian)));
  // 反向：规则写繁体，命中简体正文
  const rev1 = engine([{ text: '臺灣', type: 'text' }]);
  check('繁简-繁体规则命中简体正文', clean('台湾问题', rev1) === '问题', JSON.stringify(clean('台湾问题', rev1)));
  const rev2 = engine([{ text: '髮型', type: 'text' }]);
  check('繁简-繁体规则髮型反向命中', clean('发型设计', rev2) === '设计', JSON.stringify(clean('发型设计', rev2)));
  const rev3 = engine([{ text: '乾淨', type: 'text' }]);
  check('繁简-繁体规则乾淨反向命中', clean('干净整洁', rev3) === '整洁', JSON.stringify(clean('干净整洁', rev3)));
  // 不可判定（无上下文）：单字规则保持保守，绝不误伤
  const singleTai = engine([{ text: '台', type: 'text' }]);
  check('繁简-单字台仍不误伤臺灣', clean('臺灣商務', singleTai) === '臺灣商務', JSON.stringify(clean('臺灣商務', singleTai)));
  const singleFa = engine([{ text: '发', type: 'text' }]);
  check('繁简-单字发仍不误伤頭髮', clean('頭髮护理', singleFa) === '頭髮护理', JSON.stringify(clean('頭髮护理', singleFa)));
  check('繁简-单字发不误伤髮型', clean('髮型設計', singleFa) === '髮型設計', JSON.stringify(clean('髮型設計', singleFa)));
  // 上下文不匹配时该候选不出现：保持原样
  const taici = engine([{ text: '台词', type: 'text' }]);
  check('繁简-上下文不命中不展开', clean('颱風警報', taici) === '颱風警報', JSON.stringify(clean('颱風警報', taici)));
}
/* ================= B. 上下文排除（防误伤） ================= */
{
  check('排除-默认密级词不保留商业秘密', clean('本公司商业秘密保护协议', defaultEngine) === '本公司商业保护协议');
  check('排除-默认密级词不保留商业机密', clean('本商业机密文件', defaultEngine) === '本商业文件');
  check('排除-默认密级词不保留商业绝密', clean('商业绝密资料', defaultEngine) === '商业资料');
  check('排除-国家秘密仍清除', clean('国家秘密事项', defaultEngine) === '国家事项');
  check('排除-密级标识仍清除', clean('机密★1年', defaultEngine) === '★1年');

  // 排除后同段其他规则继续生效
  const mixed = defaultEngine.apply('商业秘密与内部资料', true, true);
  check('排除-其他规则不受牵连', mixed.text === '商业与资料' && mixed.hits === 2, JSON.stringify(mixed.text));

  // 自定义 notBefore / notAfter（字符串与数组两种写法）
  const nb = engine([{ text: '秘密', notBefore: '业' }]);
  check('排除-自定义 notBefore 保留', clean('商业秘密条款', nb) === '商业秘密条款');
  check('排除-自定义 notBefore 后仍清除', clean('内部秘密条款', nb) === '内部条款');
  const nb2 = engine([{ text: '秘密', notBefore: '商业' }]);
  check('排除-多字排除词', clean('商业秘密条款', nb2) === '商业秘密条款');
  // 回归（v2.37）：排除词必须「紧邻」才生效——出现在前文任意位置时不能把不相关命中也跳过
  // （曾因 notBeforeRe 未锚定 $，前文含「商业」就导致后面的「机密」整段漏删）
  const nbFar = engine([{ text: '机密', notBefore: ['商业'] }]);
  check('排除-非紧邻前缀不触发排除', clean('该公司从事商业咨询，文件中含有机密数据。', nbFar) === '该公司从事商业咨询，文件中含有数据。', clean('该公司从事商业咨询，文件中含有机密数据。', nbFar));
  check('排除-紧邻前缀仍触发排除', clean('商业机密数据', nbFar) === '商业机密数据', clean('商业机密数据', nbFar));
  const na = engine([{ text: '机密', notAfter: ['资料', '文件'] }]);
  check('排除-自定义 notAfter 保留', clean('机密资料与机密文件', na) === '机密资料与机密文件');

  // 旧式映射（不携带 notBefore）保持历史行为，防止使用者手工装配时行为漂移
  const legacy = engine(D.DWRRules.DEFAULT_PRESETS.map((p) => ({ text: p.word, type: 'text', enabled: true })));
  check('排除-旧式映射保持旧行为', clean('商业秘密', legacy) === '商业', clean('商业秘密', legacy));
}

/* ================= C. 整词匹配 ================= */
{
  const w = engine([{ text: 'AI', whole: true }, { text: 'chair', whole: true }, { text: 'internal', whole: true }]);
  check('整词-不误伤 said/secretary/armchair', clean('The chair said the secretary armchair internalish', w) === 'The  said the secretary armchair internalish');
  check('整词-正常整词命中', clean('AI-report and internal.docx', w) === '-report and .docx');
  check('整词-全角ＡＩ命中', clean('ＡＩ 文档', w) === ' 文档');
  check('整词-标点边界命中', clean('(AI)、internal。', w) === '、。');
  check('整词-括号包裹整段清除', clean('AI（人工）引擎', w) === '（人工）引擎');

  const zhWhole = engine([{ text: '内部', whole: true }]);
  check('整词-中文规则开启后行为不变', clean('这是内部文件', zhWhole) === '这是文件');

  const legacyNoWhole = engine([{ text: 'AI' }]);
  check('整词-未开启时保持子串旧行为', clean('said', legacyNoWhole) === 'sd');

  const spaced = engine([{ text: 'AI', whole: true }]);
  check('整词-空格混淆同样命中', clean('A I', spaced) === '');
}

/* ================= D. 编码：UTF-16 ================= */
{
  function u16(str, be) {
    const a = new Uint8Array(2 + str.length * 2);
    a[0] = be ? 0xfe : 0xff; a[1] = be ? 0xff : 0xfe;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (be) { a[2 + i * 2] = c >> 8; a[3 + i * 2] = c & 0xff; }
      else { a[2 + i * 2] = c & 0xff; a[3 + i * 2] = c >> 8; }
    }
    return a;
  }
  for (const be of [false, true]) {
    const tag = be ? 'BE' : 'LE';
    const dec = D.DWRDoc.decodeText(u16('标题：内部资料', be).buffer);
    check('utf16-' + tag + '-解码', dec.text === '标题：内部资料' && dec.encoding === 'utf-16' + (be ? 'be' : 'le'), JSON.stringify(dec.text));
    const r = D.DWRDoc.processText(dec.text, defaultEngine, dec.encoding);
    check('utf16-' + tag + '-脱敏', r.text === '标题：资料' && r.hits === 1, JSON.stringify(r.text));
    const bytes = D.DWRDoc.encodeText(r.text, dec.bom, dec.encoding);
    check('utf16-' + tag + '-回写 UTF-8 BOM', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  }
  const plain = D.DWRDoc.decodeText(new TextEncoder().encode('普通UTF8内部'));
  check('utf16-普通 UTF-8 路径不受影响', plain.encoding === 'utf-8' && plain.text === '普通UTF8内部');

  // v4.69：UTF-8 BOM 必须被识别并写回归还。TextDecoder('utf-8') 默认吞掉 BOM，
  // 旧实现用 text.charAt(0)===BOM 判定，恒为 false → 带 BOM 的 .csv/.txt 脱敏后丢 BOM，
  // 中文 Windows 双击变乱码（与本工具 CSV 导出必带 BOM 的口径自相矛盾）。
  const bomHead = [0xef, 0xbb, 0xbf];
  const bomBytes = new Uint8Array(bomHead.concat(Array.from(new TextEncoder().encode('内部机密'))));
  const bdec = D.DWRDoc.decodeText(bomBytes.buffer);
  check('v469-UTF-8 带 BOM 识别出 bom',
    bdec.encoding === 'utf-8' && bdec.bom === true && bdec.text === '内部机密',
    JSON.stringify({ enc: bdec.encoding, bom: bdec.bom, head: bdec.text.charCodeAt(0) }));
  const bref = D.DWRDoc.encodeText(bdec.text, bdec.bom, bdec.encoding);
  check('v469-UTF-8 带 BOM 写回仍带 BOM',
    bref[0] === 0xef && bref[1] === 0xbb && bref[2] === 0xbf,
    Array.from(bref.slice(0, 3)).join(','));
}

/* ================= E. 快慢路径一致性 ================= */
{
  const plainEng = engine([{ text: '内部' }, { text: '机密' }]);
  const cleanPlain = clean('这是内部文件与机密资料', plainEng);
  const cleanEvaded = clean('这是内部文件与机\u200b密资料', plainEng);
  check('路径-归一化前后结果一致', cleanPlain === cleanEvaded, cleanPlain + ' vs ' + cleanEvaded);
  const multi = clean('内部机密绝密', plainEng);
  check('路径-多词连续命中', multi === '绝密', multi);
}

/* ================= F. 动作兼容 ================= */
{
  const mask = engine([{ text: '内部' }], { action: 'mask' });
  check('动作-mask 归一化路径', clean('内\u200b部', mask) === '**');
  const custom = engine([{ text: '内部' }], { action: 'custom', custom: '【已脱敏】' });
  check('动作-custom 归一化路径', clean('这是内 部文件', custom) === '这是【已脱敏】文件');
}

/* ================= I. v3.7 智能打码 + 个人信息模板 ================= */
{
  const smart = engine([{ text: '内部', type: 'text', enabled: true }], { action: 'mask' });
  check('智能打码-中文词按字数打星',
    smart.apply('内部资料', true, true).text === '**资料',
    smart.apply('内部资料', true, true).text);
  const smartPii = engine(D.DWRRules.PII_PRESETS.map((p) => ({ text: p.text, type: 'regex', enabled: true, label: p.label })), { action: 'mask', scope: 'all' });
  check('智能打码-手机号保留头3尾4',
    smartPii.apply('联系19999999999', true, true).text === '联系199****9999',
    smartPii.apply('联系19999999999', true, true).text);
  check('智能打码-身份证保留头尾',
    smartPii.apply('号999999999999999999', true, true).text === '号999***********9999',
    smartPii.apply('号999999999999999999', true, true).text);
  check('智能打码-邮箱遮用户名保域名',
    smartPii.apply('邮箱tester@example.invalid', true, true).text === '邮箱t***@example.invalid',
    smartPii.apply('邮箱tester@example.invalid', true, true).text);
  check('智能打码-IP保留头尾',
    smartPii.apply('IP 192.0.2.10', true, true).text === 'IP 19******10',
    smartPii.apply('IP 192.0.2.10', true, true).text);

  const pii = engine(D.DWRRules.PII_PRESETS.map((p) => ({ text: p.text, type: 'regex', enabled: true, label: p.label })), { action: 'mask', scope: 'all' });
  const sample = '手机19999999999 邮箱tester@example.invalid IP 192.0.2.10';
  const piiOut = pii.apply(sample, true, true);
  check('PII-五类规则可编译可命中',
    piiOut.hits >= 3 && piiOut.matched.indexOf('手机号') >= 0 && piiOut.matched.indexOf('邮箱') >= 0,
    JSON.stringify(piiOut));
  check('PII-命中词显示中文名',
    piiOut.matched.every((m) => !/^\(\?/.test(m)),
    JSON.stringify(piiOut.matched));
  const sample2 = '证号999999999999999999 卡号9999999999999999';
  const piiOut2 = pii.apply(sample2, true, true);
  check('PII-身份证与银行卡均命中',
    piiOut2.hits >= 2,
    JSON.stringify(piiOut2));
  check('PII-不误伤普通短数字',
    pii.apply('编号12345 电话400-123-4567', true, true).hits === 0,
    'hits=' + pii.apply('编号12345 电话400-123-4567', true, true).hits);
}

/* ================= G. 端到端：docx 跨 run + 规避字符 ================= */
{
  const docx = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:p><w:t>这是内</w:t><w:r><w:t>\u200b部资料，保密</w:t></w:r></w:p>' },
    { name: 'word/header1.xml', data: '<w:p><w:t>商业秘密保护制度</w:t></w:p>' },
  ]);
  const res = await D.DWRDoc.processOffice(await docx.arrayBuffer(), defaultEngine);
  const zip2 = await D.WWRZipFix ? null : await D.DWRZip.load(await res.blob.arrayBuffer());
  const doc = await zip2.getText('word/document.xml');
  const hdr = await zip2.getText('word/header1.xml');
  check('端到端-跨 run + 零宽已清除', res.hits === 2 && doc.indexOf('内部') === -1 && doc.indexOf('\u200b') === -1, 'hits=' + res.hits);
  check('端到端-页眉密级词已清除', hdr.indexOf('秘密') === -1 && hdr.indexOf('保护制度') !== -1);
  check('端到端-词库外词汇保留', doc.indexOf('保密') !== -1);
}

/* ================= H. CLI 准确性选项 ================= */
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-rules-'));
  try {
    fs.writeFileSync(path.join(base, 'latin.txt'), 'report from AI said chair', 'utf8');
    fs.writeFileSync(path.join(base, 'doc.txt'), '标题：内部资料\r\n说明：本公司商业秘密保护协议\r\n', 'utf8');
    const rep = path.join(base, 'report.json');

    const run = spawnSync(process.execPath, ['scan.mjs', '--dir', base,
      '--words', 'AI,内部,秘密', '--whole', '--exclude-ctx', '商业',
      '--json', '--report', rep], { encoding: 'utf8' });
    check('cli-退出码为 0', run.status === 0, run.stderr);
    const list = JSON.parse(fs.readFileSync(rep, 'utf8'));
    const byName = {};
    list.forEach((x) => { byName[path.basename(x.file)] = x; });
    check('cli-整词命中 AI 且不误伤 said',
      byName['latin.txt'] && byName['latin.txt'].hits === 1 && byName['latin.txt'].matched.join() === 'AI',
      JSON.stringify(byName['latin.txt'] || null));
    check('cli-排除上下文保留商业秘密',
      byName['doc.txt'] && byName['doc.txt'].hits === 1 && byName['doc.txt'].matched.join() === '内部',
      JSON.stringify(byName['doc.txt'] || null));
    check('cli-启动日志标注准确性开关', run.stdout.indexOf('整词匹配') !== -1 && run.stdout.indexOf('排除上下文') !== -1);

    fs.writeFileSync(path.join(base, 'case.txt'), 'AI REPORT here', 'utf8');
    const rep2 = path.join(base, 'report2.json');
    spawnSync(process.execPath, ['scan.mjs', '--dir', base, '--words', 'report', '--json', '--report', rep2], { encoding: 'utf8' });
    const insensitive = JSON.parse(fs.readFileSync(rep2, 'utf8')).filter((x) => path.basename(x.file) === 'case.txt');
    check('cli-默认大小写不敏感命中', insensitive.length === 1 && insensitive[0].hits === 1, JSON.stringify(insensitive));
    const rep3 = path.join(base, 'report3.json');
    spawnSync(process.execPath, ['scan.mjs', '--dir', base, '--words', 'report', '--case-sensitive', '--json', '--report', rep3], { encoding: 'utf8' });
    const sensitive = JSON.parse(fs.readFileSync(rep3, 'utf8')).filter((x) => path.basename(x.file) === 'case.txt');
    check('cli-大小写敏感生效', sensitive.length === 0, JSON.stringify(sensitive));

    /* v4.47 --words 的 /正则/ 形式：README 与 scan.mjs 的用法注释都承诺
       「/正则/ 视为正则规则」，但此前 CLI 段只测过纯字面量词（AI,内部,秘密）。
       这条路径零覆盖——解析分支写错时，/绝密\\d*年/ 会被当成字面量去匹配，
       含数字变体的文件全部漏检，而测试一片绿。
       夹具设计：a.txt 含「绝密2024年」、b.txt 含「绝密年」、c.txt 无关键词。
       正则 /绝密\\d*年/ 应命中 a（7 字）与 b（3 字）；若被当字面量则两者都不中。 */
    fs.writeFileSync(path.join(base, 'rx-a.txt'), '标题\n这是绝密2024年的内部资料\n正文\n落款', 'utf8');
    fs.writeFileSync(path.join(base, 'rx-b.txt'), '标题\n这是绝密年的资料\n正文\n落款', 'utf8');
    fs.writeFileSync(path.join(base, 'rx-c.txt'), '标题\n普通内容没有关键词\n正文\n落款', 'utf8');
    const repRx = path.join(base, 'report-rx.json');
    const rxRun = spawnSync(process.execPath, ['scan.mjs', '--dir', base,
      '--words', '/绝密\\d*年/', '--json', '--report', repRx, '--scope', 'all'], { encoding: 'utf8' });
    check('cli-正则形式退出码为 0', rxRun.status === 0, rxRun.stderr);
    const rxList = JSON.parse(fs.readFileSync(repRx, 'utf8'));
    const rxByName = {};
    rxList.forEach((x) => { rxByName[path.basename(x.file)] = x; });
    // 启动日志把生效词条打印成剥离斜杠后的正则源，证明走的是 regex 分支
    check('cli-正则形式被解析为正则规则（日志印出正则源）',
      rxRun.stdout.indexOf('绝密\\d*年') !== -1 && rxRun.stdout.indexOf('/绝密') === -1,
      JSON.stringify((rxRun.stdout.match(/生效词条[^\n]*/) || ['<无生效词条行>'])[0]));
    // 数字变体与零次重复都要命中：证明 \\d* 真的在起作用，不是字面量匹配
    check('cli-正则命中数字变体（绝密2024年）',
      !!rxByName['rx-a.txt'] && rxByName['rx-a.txt'].hits === 1
        && rxByName['rx-a.txt'].hitChars === 7,
      JSON.stringify(rxByName['rx-a.txt'] || null));
    check('cli-正则命中零次重复（绝密年）',
      !!rxByName['rx-b.txt'] && rxByName['rx-b.txt'].hits === 1
        && rxByName['rx-b.txt'].hitChars === 3,
      JSON.stringify(rxByName['rx-b.txt'] || null));
    // 无关文件不得被殃及
    check('cli-正则形式不误伤无关文件', !rxByName['rx-c.txt'],
      JSON.stringify(rxByName['rx-c.txt'] || null));
    // 对照：同一批文件用普通词「绝密」扫，命中字数应明显更小（2 字而非 7 / 3 字）
    const repLit = path.join(base, 'report-lit.json');
    spawnSync(process.execPath, ['scan.mjs', '--dir', base,
      '--words', '绝密', '--json', '--report', repLit, '--scope', 'all'], { encoding: 'utf8' });
    const litList = JSON.parse(fs.readFileSync(repLit, 'utf8'));
    const litA = litList.filter((x) => path.basename(x.file) === 'rx-a.txt')[0];
    check('cli-普通词形式命中字数更小（与正则形成对照）',
      !!litA && litA.hits === 1 && litA.hitChars === 2,
      JSON.stringify(litA || null));
    // 混合形式：正则与普通词逗号分隔同框出现，两条都要生效
    const repMix = path.join(base, 'report-mix.json');
    spawnSync(process.execPath, ['scan.mjs', '--dir', base,
      '--words', '/绝密\\d*年/,内部', '--json', '--report', repMix, '--scope', 'all'], { encoding: 'utf8' });
    const mixList = JSON.parse(fs.readFileSync(repMix, 'utf8'));
    const mixA = mixList.filter((x) => path.basename(x.file) === 'rx-a.txt')[0];
    check('cli-正则与普通词混合解析（两类规则都生效）',
      !!mixA && mixA.hits === 2 && mixA.matched.indexOf('绝密\\d*年') !== -1,
      JSON.stringify(mixA || null));
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}


/* ================= H2. 报告子集处理：挑选 / 就地脱敏 / 删除 =================
   用户的实际流程是「先扫出几百条，再挑其中几条删掉或脱敏」。
   这里锁住四件事：
     ① --pick-word / --pick-dir 只动挑中的文件，未挑中的一个字节都不能变；
     ② --in-place 改写原文件并留下 .bak 原文备份，且 --delete-bak 能清掉备份；
     ③ --delete-dry-run 只列计划；--delete 才真删；
     ④ --in-place 与 --delete 同时给出必须直接报错（否则原件无处可留）。 */
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-pick-'));
  const A = path.join(base, 'a');
  const B = path.join(base, 'b');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  const one = path.join(A, 'one.txt');
  const two = path.join(B, 'two.txt');
  const three = path.join(B, 'three.txt');
  fs.writeFileSync(one, '\u5185\u90e8 \u9996\u884c\n\u6b63\u6587\n\u5185\u90e8 \u5c3e\u884c\n', 'utf8');
  fs.writeFileSync(two, '\u673a\u5bc6 \u9996\u884c\n\u6b63\u6587\n\u673a\u5bc6 \u5c3e\u884c\n', 'utf8');
  fs.writeFileSync(three, '\u7edd\u5bc6 \u9996\u884c\n\u6b63\u6587\n\u7edd\u5bc6 \u5c3e\u884c\n', 'utf8');
  const rep = path.join(base, 'r.json');
  fs.writeFileSync(rep, JSON.stringify([
    { file: one, hits: 2, matched: ['\u5185\u90e8'], firstHit: true, lastHit: true },
    { file: two, hits: 2, matched: ['\u673a\u5bc6'], firstHit: true, lastHit: true },
    { file: three, hits: 2, matched: ['\u7edd\u5bc6'], firstHit: true, lastHit: true },
  ]), 'utf8');
  const run = (...args) => spawnSync(process.execPath, ['scan.mjs', ...args], { encoding: 'utf8' });

  try {
    /* ① 只处理命中的那一条 */
    const out1 = path.join(base, 'out1');
    const r1 = run('--from-report', rep, '--authorized-root', base, '--pick-word', '\u5185\u90e8', '--out', out1);
    const copies = fs.existsSync(out1) ? fs.readdirSync(out1, { recursive: true })
      .filter((n) => String(n).endsWith('one.txt')) : [];
    check('pick-按命中词只生成 1 条副本', r1.status === 0 && copies.length === 1,
      'status=' + r1.status + ' copies=' + JSON.stringify(copies));
    check('pick-未挑中的文件未被写入输出目录',
      !fs.existsSync(out1) || !fs.readdirSync(out1, { recursive: true }).some((n) => String(n).endsWith('two.txt')),
      r1.stdout);
    check('pick-副本已去掉敏感词',
      copies.length === 1 && fs.readFileSync(path.join(out1, copies[0]), 'utf8').indexOf('\u5185\u90e8') === -1,
      copies.length ? fs.readFileSync(path.join(out1, copies[0]), 'utf8') : '<无副本>');
    check('pick-副本模式下原文件保持不变',
      fs.readFileSync(one, 'utf8').indexOf('\u5185\u90e8') >= 0);

    /* ② 按目录就地脱敏 + 备份 */
    const r2 = run('--from-report', rep, '--authorized-root', base, '--pick-dir', B, '--in-place');
    check('inplace-退出码为 0', r2.status === 0, r2.stderr);
    check('inplace-选中目录内的文件已脱敏',
      fs.readFileSync(two, 'utf8').indexOf('\u673a\u5bc6') === -1
        && fs.readFileSync(three, 'utf8').indexOf('\u7edd\u5bc6') === -1,
      fs.readFileSync(two, 'utf8'));
    check('inplace-留下 .bak 原文备份',
      fs.readFileSync(two + '.bak', 'utf8').indexOf('\u673a\u5bc6') >= 0,
      '两个备份存在=' + (fs.existsSync(two + '.bak') && fs.existsSync(three + '.bak')));
    check('inplace-未选中的目录一个字都没动',
      fs.readFileSync(one, 'utf8').indexOf('\u5185\u90e8') >= 0);

    /* --delete-bak 清掉含原文的备份（对外交付口径） */
    const r2b = run('--from-report', rep, '--authorized-root', base, '--pick-word', '\u5185\u90e8', '--in-place', '--delete-bak');
    check('deletebak-退出码为 0', r2b.status === 0, r2b.stderr);
    check('deletebak-备份已删除、正文已脱敏',
      !fs.existsSync(one + '.bak') && fs.readFileSync(one, 'utf8').indexOf('\u5185\u90e8') === -1,
      'bakExists=' + fs.existsSync(one + '.bak'));

    /* ③ 删除演练不落盘，真删才落盘 */
    const dry = run('--from-report', rep, '--authorized-root', base, '--pick-word', '\u7edd\u5bc6', '--delete-dry-run');
    check('delete-演练退出码为 0 且文件仍在',
      dry.status === 0 && fs.existsSync(three), dry.stderr);
    const del = run('--from-report', rep, '--authorized-root', base, '--pick-word', '\u7edd\u5bc6', '--delete', '--confirm-delete');
    check('delete-只删掉挑中的那一个',
      del.status === 0 && !fs.existsSync(three) && fs.existsSync(two),
      'three=' + fs.existsSync(three) + ' two=' + fs.existsSync(two));

    /* ④ 冲突组合与空筛选必须快速失败 */
    const bad = run('--from-report', rep, '--authorized-root', base, '--in-place', '--delete');
    check('guard-就地脱敏与删除互斥', bad.status !== 0 && /不能同时使用/.test(bad.stderr), bad.stderr);
    const none = run('--from-report', rep, '--authorized-root', base, '--pick-word', '\u4e0d\u5b58\u5728\u7684\u8bcd', '--delete-dry-run');
    check('guard-筛选不到文件时非 0 退出',
      none.status !== 0 && /未匹配到任何文件/.test(none.stderr), none.stderr);

    /* ⑤ 通配符 --pick、清单 --pick-list、无备份 --no-backup：
       用户手工圈定文件的两条路都要能走通，且 --no-backup 确实不留 .bak。 */
    const C = path.join(base, 'c');
    fs.mkdirSync(C);
    const four = path.join(C, 'four.txt');
    const five = path.join(C, 'five.txt');
    fs.writeFileSync(four, '\u5185\u90e8 \u9996\u884c\n\u6b63\u6587\n\u5185\u90e8 \u5c3e\u884c\n', 'utf8');
    fs.writeFileSync(five, '\u5185\u90e8 \u9996\u884c\n\u6b63\u6587\n\u5185\u90e8 \u5c3e\u884c\n', 'utf8');
    const rep2 = path.join(base, 'r2.json');
    fs.writeFileSync(rep2, JSON.stringify([
      { file: four, hits: 2, matched: ['\u5185\u90e8'], firstHit: true, lastHit: true },
      { file: five, hits: 2, matched: ['\u5185\u90e8'], firstHit: true, lastHit: true },
    ]), 'utf8');
    // 星号要跨目录：写成 "任意上级/c/four.txt" 必须能挑到
    const wild = run('--from-report', rep2, '--authorized-root', base, '--pick', '*/c/four.txt', '--delete-dry-run');
    check('pick-通配符跨目录只挑中一个',
      wild.status === 0 && (wild.stdout.match(/\[将删除\]/g) || []).length === 1
        && wild.stdout.indexOf('four.txt') >= 0 && wild.stdout.indexOf('five.txt') < 0,
      wild.stdout);
    const listFile = path.join(base, 'picked.txt');
    fs.writeFileSync(listFile, '# \u624b\u5de5\u6311\u9009\n' + five + '\n', 'utf8');
    const listed = run('--from-report', rep2, '--authorized-root', base, '--pick-list', listFile, '--delete-dry-run');
    check('pick-清单文件只挑中清单里的一个',
      listed.status === 0 && (listed.stdout.match(/\[将删除\]/g) || []).length === 1
        && listed.stdout.indexOf('five.txt') >= 0, listed.stdout);
    const nb = run('--from-report', rep2, '--authorized-root', base, '--pick', '*/c/four.txt', '--in-place', '--no-backup');
    check('nobackup-就地脱敏但不留备份',
      nb.status === 0 && fs.readFileSync(four, 'utf8').indexOf('\u5185\u90e8') === -1
        && !fs.existsSync(four + '.bak') && fs.readFileSync(five, 'utf8').indexOf('\u5185\u90e8') >= 0,
      nb.stdout + nb.stderr);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
  }
}


/* C15) v4.53 charSource：一字多繁的上下文判别。
   README 承诺「一字多繁者（臺 / 髮 / 製 / 鬆 / 著…）自 v2.15 起按相邻字判别，
   『台湾』命中『臺灣』，单字规则『台』仍不误伤『臺灣』」。
   此前只有端到端行为断言（台湾 / 單字台两例），charSource 本身零直接覆盖——
   而它有四条独立分支（无映射 / 繁体规则字 / 简体一对一 / 一字多繁上下文），
   改错任何一条，既有断言未必红。 */
{
  const RS = fs.readFileSync(path.join(__dirname, 'js', 'rules.js'), 'utf8');
  const tail = '  global.DWRRules = {';
  check('v453-charSource 注入点存在', RS.indexOf(tail) >= 0, '未找到 DWRRules 导出');
  // charSource 在 IIFE 内、未导出：在内存里把它挂到 global 再求值
  const patched = RS.replace(tail, '  global.__cs = charSource;\n' + tail);
  const c = {
    TextEncoder, TextDecoder,
    String: String, RegExp: RegExp, Array: Array, Object: Object, Math: Math,
    JSON: JSON, console: { log() {}, error() {} },
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(patched, c);
  const cs = c.__cs;
  check('v453-charSource 可取到', typeof cs === 'function', 'typeof=' + typeof cs);

  // ① 无映射：原样转义，不包字符类
  check('v453-无映射字原样返回（不包字符类）',
    cs('中') === '中' && cs('a') === 'a',
    JSON.stringify([cs('中'), cs('a')]));

  // ② 规则字本身是繁体 -> 纳入简体
  check('v453-繁体规则字纳入简体',
    cs('內') === '[內内]' && cs('機') === '[機机]' && cs('絕') === '[絕绝]',
    JSON.stringify([cs('內'), cs('機'), cs('絕')]));

  // ③ 规则字是简体且有繁体等价 -> 纳入繁体
  check('v453-简体规则字纳入繁体',
    cs('国') === '[国國]' && cs('内') === '[内內]',
    JSON.stringify([cs('国'), cs('内')]));

  // ④ 一字多繁：next 判定（本字 + 后一个简体字）
  const nextCases = [
    ['台', '湾', '臺'], ['台', '风', '颱'], ['台', '历', '檯'],
    ['发', '展', '發'], ['发', '型', '髮'],
    ['干', '部', '幹'], ['干', '净', '乾'],
    ['制', '造', '製'], ['面', '包', '麵'], ['只', '是', '衹'],
    ['着', '名', '著'], ['汇', '率', '匯'], ['历', '史', '歷'],
    ['借', '口', '藉'], ['松', '弛', '鬆'],
  ];
  const nextBad = nextCases.filter((x) => cs(x[0], null, x[1]) !== '[' + x[0] + x[2] + ']');
  check('v453-一字多繁按 next 判别（15 组）', nextBad.length === 0,
    nextBad.map((x) => x[0] + '+' + x[1] + '=>' + cs(x[0], null, x[1])).join(' ; '));

  // ⑤ 一字多繁：prev 判定（前一个简体字 + 本字）
  const prevCases = [
    ['台', '柜', '檯'], ['台', '平', '臺'], ['发', '头', '髮'], ['干', '树', '幹'],
    ['汇', '词', '彙'], ['历', '日', '曆'], ['松', '放', '鬆'], ['着', '显', '著'],
    ['复', '反', '覆'], ['面', '泡', '麵'], ['只', '一', '隻'], ['里', '这', '裡'],
  ];
  const prevBad = prevCases.filter((x) => { const src = cs(x[0], x[1], null); return src.charAt(0) !== '[' || src.indexOf(x[2]) < 0; });
  check('v453-一字多繁按 prev 判别（12 组）', prevBad.length === 0,
    prevBad.map((x) => x[1] + '+' + x[0] + '=>' + cs(x[0], x[1], null) + ' want ' + x[2]).join(' ; '));

  // ⑥ next 与 prev 冲突时 next 优先（台 + 柜 + 湾：取臺不取檯）
  check('v453-next 优先于 prev',
    cs('台', '柜', '湾') === '[台臺]' && cs('发', '头', '展') === '[发發]',
    JSON.stringify([cs('台', '柜', '湾'), cs('发', '头', '展')]));

  // ⑦ 无可判定上下文时保持原样——这是「绝不全局折叠」的保证
  check('v453-无上下文时保持原样（不全局折叠）',
    cs('台') === '台' && cs('发') === '发' && cs('干') === '干' && cs('制') === '制',
    JSON.stringify([cs('台'), cs('发'), cs('干'), cs('制')]));

  // ⑧ 一对多 + 上下文会叠加：复+杂 → [复復複]，历+日 → [历歷曆]
  check('v453-一对多与上下文候选叠加',
    cs('复', null, '杂') === '[复復複]' && cs('历', '日', null) === '[历歷曆]',
    JSON.stringify([cs('复', null, '杂'), cs('历', '日', null)]));

  // ⑨ 生成的字符类必须是合法正则（能编译）
  let allCompile = true, badSrc = '';
  ['台', '发', '干', '制', '面', '只', '着', '复', '汇', '历', '借', '里', '松', '內', '机'].forEach((ch) => {
    ['湾', '展', '部', '造'].forEach((nx) => {
      ['柜', '头', '树'].forEach((pv) => {
        try { new RegExp(cs(ch, pv, nx)); } catch (e) { allCompile = false; badSrc = cs(ch, pv, nx); }
      });
    });
    try { new RegExp(cs(ch)); } catch (e) { allCompile = false; badSrc = cs(ch); }
  });
  check('v453-生成的字符类全是合法正则', allCompile, 'bad=' + badSrc);

  // ⑩ 端到端对照：charSource 的判定要能兑现成「台湾命中臺灣、单字台不误伤」
  {
    const eng = (txt) => D.DWRRules.createEngine({
      rules: [{ text: txt, type: 'text', enabled: true }], scope: 'all', action: 'delete', custom: ''
    });
    const tw = eng('台湾');
    const single = eng('台');
    const clean = (s, e) => e.apply(s, true, true).text;
    check('v453-端到端：台湾命中臺灣、单字台不误伤臺灣',
      clean('臺灣商務協議', tw) === '商務協議'
        && clean('臺灣商務', single) === '臺灣商務',
      JSON.stringify([clean('臺灣商務協議', tw), clean('臺灣商務', single)]));
  }
}

/* C16) v4.54 上下文排除的紧邻锚定与字面量语义。
   v2.37 的回归是「notBeforeRe 漏掉 $ 锚定，前文任意位置出现排除词就把后面的命中整段跳过」——
   那条断言只验了「长前文」一种形态。这里补三类它没覆盖的：
   ① 排除词出现在前文但被其它文字隔开（不紧邻）不触发；
   ② notAfter 方向的 ^ 锚定同样不能少；
   ③ 排除词按**字面量**编译（tolerantSource），不是正则——
      「商[业]」这种写法匹配不到「商业」，这是设计决策，必须锁住防止有人改成正则。 */
{
  const clean = (s, e) => e.apply(s, true, true).text;
  const mk = (rules) => D.DWRRules.createEngine({
    rules: rules, scope: 'all', action: 'delete', custom: ''
  });
  const BS = String.fromCharCode(92);

  // ① notBefore：只有紧邻才排除（v2.37 回归的守护）
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: ['商业'] }]);
    check('v454-notBefore 紧邻才排除',
      clean('商业机密数据', e) === '商业机密数据',
      JSON.stringify(clean('商业机密数据', e)));
    check('v454-notBefore 前文远处出现不排除',
      clean('该公司从事商业咨询多年，文件中含有机密数据。', e)
        === '该公司从事商业咨询多年，文件中含有数据。',
      JSON.stringify(clean('该公司从事商业咨询多年，文件中含有机密数据。', e)));
    // 中间隔一个字也不行：锚定要求排除词正好在命中区间之前
    check('v454-notBefore 隔一字不排除',
      clean('的商业x机密', e) === '的商业x',
      JSON.stringify(clean('的商业x机密', e)));
  }

  // ② notAfter：只有紧邻才排除（^ 锚定）
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notAfter: ['商业'] }]);
    check('v454-notAfter 紧邻才排除',
      clean('机密商业', e) === '机密商业',
      JSON.stringify(clean('机密商业', e)));
    check('v454-notAfter 后文远处出现不排除',
      clean('本机密事项涉及商业合作。', e) === '本事项涉及商业合作。',
      JSON.stringify(clean('本机密事项涉及商业合作。', e)));
    check('v454-notAfter 隔一字不排除',
      clean('机密x商业', e) === 'x商业',
      JSON.stringify(clean('机密x商业', e)));
  }

  // ③ 排除词按字面量编译，不是正则（设计决策，防有人「顺手」改成正则）
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: ['商[业]'] }]);
    check('v454-排除词按字面量编译（正则元字符不生效）',
      clean('商业机密', e) === '商业',
      JSON.stringify(clean('商业机密', e)));
  }

  // ④ 排除词兼容繁体（tolerantSource 的行为）
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: ['商业'] }]);
    check('v454-排除词兼容繁体写法',
      clean('商業机密', e) === '商業机密' && clean('商业機密', e) === '商业機密',
      JSON.stringify([clean('商業机密', e), clean('商业機密', e)]));
  }

  // ⑤ 多个排除词逐个判定，任一命中即排除
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: ['商业', '招商', '人民'] }]);
    check('v454-多排除词任一命中即排除',
      clean('商业机密', e) === '商业机密'
        && clean('招商机密', e) === '招商机密'
        && clean('人民机密', e) === '人民机密',
      JSON.stringify([clean('商业机密', e), clean('招商机密', e), clean('人民机密', e)]));
    check('v454-多排除词都不命中仍清除',
      clean('普通机密', e) === '普通',
      JSON.stringify(clean('普通机密', e)));
  }

  // ⑥ 空白 / 换行被视为天然边界，不破坏「紧邻」
  {
    const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: ['商业'] }]);
    check('v454-换行破坏紧邻（排除要求真正紧邻，实测行为）',
      clean('商业' + BS + 'n机密', e) === '商业' + BS + 'n',
      JSON.stringify(clean('商业' + BS + 'n机密', e)));
  }

  // ⑦ 空 / 非法排除词被过滤，不会误排除也不会抛错
  {
    const edge = ['', null, 42, '   '];
    let ok = true, msg = '';
    edge.forEach(function (v) {
      try {
        const e = mk([{ text: '机密', type: 'text', enabled: true, notBefore: [v] }]);
        const out = clean('商业机密', e);
        if (out !== '商业') { ok = false; msg = 'edge ' + JSON.stringify(v) + ' -> ' + out; }
      } catch (err) { ok = false; msg = 'edge ' + JSON.stringify(v) + ' threw ' + err.message; }
    });
    check('v454-空与非法排除词被安全过滤', ok, msg);
  }

  // ⑧ 排除不影响同段其他规则（v2.x 既有行为，这里锁死）
  {
    const e = mk([
      { text: '机密', type: 'text', enabled: true, notBefore: ['商业'] },
      { text: '内部', type: 'text', enabled: true },
    ]);
    const r = e.apply('商业秘密与内部资料', true, true);
    check('v454-排除后同段其他规则继续生效',
      r.text === '商业秘密与资料' && r.hits === 1,
      JSON.stringify(r.text));
  }

  // ⑨ 端到端：默认词库的密级词不再带「商业」排除
  {
    const e = D.DWRRules.createEngine({
      rules: D.DWRRules.DEFAULT_PRESETS.map(function (p) {
        return { text: p.word, type: 'text', enabled: true,
          notBefore: p.notBefore, notAfter: p.notAfter, whole: p.whole, group: p.group };
      }),
      scope: 'all', action: 'delete', custom: ''
    });
    check('v475-默认词库三个密级词都直接清除',
      clean('商业秘密', e) === '商业'
        && clean('商业机密', e) === '商业'
        && clean('商业绝密', e) === '商业',
      JSON.stringify([clean('商业秘密', e), clean('商业机密', e), clean('商业绝密', e)]));
    check('v454-默认词库下国家秘密仍清除',
      clean('国家秘密事项', e) === '国家事项',
      JSON.stringify(clean('国家秘密事项', e)));
  }
}
console.log('\n==== ' + (fail === 0 ? '全部通过' : '存在失败') + ' ====');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
