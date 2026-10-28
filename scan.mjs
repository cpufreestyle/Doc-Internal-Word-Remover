#!/usr/bin/env node
/**
 * scan.mjs —— Doc-Internal-Word-Remover 命令行扫描器
 *
 * 复用浏览器端的 zip / rules / ooxml 引擎，在 Node 下递归扫描磁盘上的
 * 文档（docx / xlsx / pptx / txt / md / csv ...），统计含中文敏感词的文档。
 *
 * 用法：
 *   node scan.mjs --drive D:                扫描整个 D 盘（只读报告）
 *   node scan.mjs --dir "D:\工作文档"       扫描指定目录（--dir 可重复，一次扫多个目录）
 *   node scan.mjs --drive D: --scope firstlast|first|all   匹配范围（默认 firstlast：仅首行+尾行）
 *   node scan.mjs --drive D: --html scan-report.html       额外生成可点击 HTML 索引（打开文件/所在目录）
 *   node scan.mjs --dir "D:\资料" --move-to "D:\待处理"    命中文件剪切到指定目录（镜像原目录结构）
 *   node scan.mjs --dir "D:\资料" --move-to "D:\待处理" --move-dry-run   仅演练，不实际移动
 *   node scan.mjs --drive D: --json        生成 scan-report.json
 *   node scan.mjs --drive D: --limit 200   只扫描前 200 个文件（快速测试）
 *   node scan.mjs --drive D: --depth 3     最大递归 3 层
 *   node scan.mjs --drive D: --clean --out "D:\cleaned"   扫描并边清理边输出到新目录
 *   node scan.mjs --from-report scan-report.json --authorized-root "D:\资料" --out "D:\cleaned"
 *       按命中清单生成脱敏副本（不重扫）。报告路径必须位于显式授权目录内。
 *   node scan.mjs --from-report "检查报告.html" --authorized-root "D:\资料" --out "D:\cleaned"
 *       清单支持三种：本工具 JSON 报告 / 检查软件 HTML 详细报告 / 纯路径清单（每行一个路径）
 *       可选 --action delete|mask|custom（默认 delete）与 --custom "替换文本"
 *       可选 --concurrency N 控制并发（默认 8）；CSV 报告为 UTF-8 带 BOM，Excel 直接打开不乱码
 *   node scan.mjs --from-report scan-report.json --out "D:\cleaned" --action mask   打码为 ***
 *   node scan.mjs --words "机密,内部,商业泄密"                自定义词库（/正则/ 视为正则规则）
 *   node scan.mjs --dir "D:\资料" --whole                    全部规则按整词匹配（英文/数字词防误伤）
 *   node scan.mjs --dir "D:\资料" --exclude-ctx "商业"       命中紧邻这些词时跳过（防「商业秘密」误删）
 *   node scan.mjs --dir "D:\资料" --case-sensitive           大小写敏感
 *
 *  node scan.mjs --dir <目录> --delete-dry-run    预演：只列出将删除的命中文档（不实际删除）
 *  node scan.mjs --dir "D:\资料" --clean --out cleaned --verify   清理后按「全文 + 全部部件」复查输出（有残留时退出码 2）
 *  node scan.mjs --dir <目录> --delete            扫描后从磁盘删除命中文档（实时扫描命中时生效，不可恢复！）
 *  node scan.mjs --from-report report.json --authorized-root "D:\资料" --pick-word 机密 --delete-dry-run   只挑出指定文件
 *       --pick 文件路径（可多次，含通配符 * ?）/ --pick-word 命中词 / --pick-dir 目录（可多次）
 *       --pick-list 纯路径清单（每行一个，与 --pick 同义，便于先挑好再执行）
 *  node scan.mjs --from-report report.json --authorized-root "D:\资料" --pick-word 机密 --in-place --no-backup
 *       --in-place 直接改写原文件（默认先备份 .bak；--no-backup 关闭；--delete-bak 清理后删备份）
 *  node scan.mjs --from-report report.json --authorized-root "D:\资料" --pick 路径 --delete --confirm-delete
 *       --delete 默认只演练；实际删除必须同时提供 --confirm-delete。
 *
 * 说明：纯报告模式只读不写；--clean 会把命中文档的脱敏版本写入 --out（镜像目录结构）。
 *       支持 Office OOXML 全部变体：docx/docm/dotx/dotm、xlsx/xlsm/xltx/xltm、pptx/pptm/potx/potm/ppsx/ppsm。
 *       默认跳过 Windows / Program Files / node_modules 等系统/依赖目录以提速减噪。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows 系统目录
const SYS_SKIP_WIN = new Set([
  'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  '$Recycle.Bin', 'System Volume Information', 'AppData', 'node_modules', '.git'
]);
// Linux / UOS 系统目录
const SYS_SKIP_LINUX = new Set([
  'bin', 'boot', 'cdrom', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32',
  'lost+found', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'snap',
  'srv', 'swapfile', 'sys', 'tmp', 'usr', 'var', 'node_modules', '.git'
]);
// 根据平台自动选择
const SYS_SKIP = process.platform === 'win32' ? SYS_SKIP_WIN : SYS_SKIP_LINUX;

/** --docs-only 时只扫描这些「真文档」类型，过滤 js/json/css/yml 等代码与配置噪音 */
const DOC_EXT = [
  'docx', 'docm', 'dotx', 'dotm',
  'xlsx', 'xlsm', 'xltx', 'xltm',
  'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm',
  'txt', 'text', 'md', 'markdown', 'rst', 'csv', 'tsv'
];
function isDocFile(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return DOC_EXT.indexOf(ext) >= 0;
}

/** 计算一组文件路径的最长公共目录，用作输出镜像的基准 */
function commonRoot(files) {
  if (!files.length) return '';
  let parts = files[0].split(/[\\/]/);
  parts.pop(); // 去掉文件名
  for (let k = 1; k < files.length; k++) {
    const p = files[k].split(/[\\/]/);
    p.pop();
    let i = 0;
    while (i < parts.length && i < p.length && parts[i] === p[i]) i++;
    parts = parts.slice(0, i);
    if (!parts.length) break;
  }
  const sep = process.platform === 'win32' ? '\\' : '/';
  let root = parts.join(sep);
  if (process.platform === 'win32') {
    if (/^[A-Za-z]:$/.test(root)) root += '\\';
  } else {
    if (root === '') root = '/';
  }
  return root;
}

/** 多盘符清单（如保密检查报告横跨 C:/D:/E:）没有公共根目录时，按「盘符\路径」镜像，避免不同盘同名文件互相覆盖。
    Windows 上还把路径里的正斜杠一并归一成反斜杠——保密检查报告的 HTML / JSON 清单
    不受作者习惯约束，混用两种分隔符会产出「C\a/b.docx」这种怪异的镜像目录名。
    POSIX 路径原样返回：那里的分隔符本来就是 /，且单盘不会走到这个分支。 */
function mirrorRel(file) {
  const s = String(file);
  if (process.platform !== 'win32') return s;
  const BS = String.fromCharCode(92);
  return s
    .replace(/^[A-Za-z]:[\\/]/, function (m) { return m.charAt(0) + BS; })
    .split('/').join(BS)
    .replace(/^\\+/, '');
}

/**
 * 把「镜像相对路径」夹在输出目录之内，返回 { dest, clamped }。
 * `path.relative(root, file)` 在 root 与实际层级不符时会给出 `..\x.txt` 这种越界相对路径
 * （跨盘时更直接给回绝对路径），而 `path.join(outDir, rel)` 是纯拼接，不净化 `..`，
 * 副本于是写到 --out 之外——实测 --out 目录压根没建起来，日志仍报「生成副本 1 个」、退出码 0。
 * 报告（尤其是保密检查软件导出的 HTML / 清单）属于外来数据，写出位置不能由它决定。
 * 夹回时用源文件的镜像路径（去掉盘符与 . / .. 段），既不越界也保留层级、不同来源不互相覆盖。
 */
function clampInside(outDir, rel, file) {
  const absOut = path.resolve(outDir);
  const cand = path.resolve(absOut, rel);
  if (pathInside(absOut, cand)) return { dest: cand, clamped: false };
  const segs = String(mirrorRel(file)).split(/[\\/]/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[:*?"<>|]/g, '_'));
  return { dest: path.join(absOut, ...segs), clamped: true };
}

/** 取第一个空闲的备份槽：name.bak、name.bak.2、name.bak.3…（与网页端同一命名规则，
    多轮处理时不会用本轮内容覆盖上一轮的原文备份） */
async function freshBakFor(file) {
  let bak = file + '.bak';
  for (let n = 2; n < 100; n++) {
    try { await fsp.access(bak); } catch (e) { return bak; }
    bak = file + '.bak.' + n;
  }
  return file + '.bak.' + Date.now();
}

/* ---------------- --pick 子集筛选（把「扫出来的指定文件」单独挑出来） ----------------
   报告动辄上千条，逐行抄路径不可行。--pick-word / --pick-dir 按命中词与所在目录筛，
   --pick / --pick-list 用显式路径（含 * ? 通配符）精确圈定。多个条件之间取「交集」：
   每加一个条件都只能让结果更少，不会因为多写一个参数就把范围放宽。 */

/** 同一文件的路径写法不统一（分隔符 / 大小写 / 尾部斜杠）：比对前一律归一化 */
function normPathKey(p) {
  return String(p == null ? '' : p)
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 路径是否落在某个目录之内（含目录自身）；目录未归一化时按字符串前缀兜底 */
function inDir(file, dir) {
  const f = normPathKey(file);
  const d = normPathKey(dir);
  if (!f || !d) return false;
  return f === d || f.indexOf(d + '/') === 0;
}

/** 通配符转正则：只支持 * 与 ?，其余字符按字面量处理（路径里 . ( ) 等极常见）。
    星号与问号都跨目录匹配：写成「任意上级目录 斜杠 财务 斜杠 任意文件」时，
    想表达的是「任意位置下的财务目录」；按 shell 语义只匹配一级会把整批文件漏掉，
    而且失败的方式很难自己看出来。 */
function wildToRe(pat) {
  const BS = String.fromCharCode(92);
  const src = String(pat == null ? '' : pat).replace(/[\\/]+/g, '/');
  let re = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]]/g, BS + '$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * 按 --pick 系列条件从报告清单里挑出目标文件。
 * 返回 { list, picked, why }：list 为筛后的条目，picked 为命中条件的条数，
 * why 为没有任何条件生效时的说明（供调用方报错）。
 */
function pickReportFiles(list, o) {
  const words = (o.pickWord || []).filter(Boolean);
  const dirs = (o.pickDir || []).filter(Boolean);
  const pats = (o.pick || []).filter(Boolean).map(wildToRe);
  if (!words.length && !dirs.length && !pats.length) return { list: list, picked: 0, why: '' };
  const out = list.filter(function (it) {
    const key = normPathKey(it.file);
    if (pats.length && !pats.some(function (re) { return re.test(key); })) return false;
    if (dirs.length && !dirs.some(function (d) { return inDir(it.file, d); })) return false;
    if (words.length) {
      const m = it.matched || [];
      // 词条件按「包含」而非全等：matched 里可能带上下文后缀，全等会把真命中漏掉
      if (!words.some(function (w) { return m.some(function (x) { return String(x).indexOf(w) >= 0; }); })) return false;
    }
    return true;
  });
  const why = '当前筛选条件（'
    + (words.length ? '命中词 ' + words.join('、') + '；' : '')
    + (dirs.length ? '目录 ' + dirs.join('、') + '；' : '')
    + (pats.length ? '路径 ' + pats.length + ' 条' : '')
    + '）未匹配到任何文件';
  return { list: out, picked: out.length, why: why };
}

async function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js', 'js/util.js', 'js/report.js'];
  const code = files
    .map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8'))
    .join('\n');
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

function parseArgs(argv) {
  const o = { drive: null, dirs: [], out: null, clean: false, json: false, limit: Infinity, depth: Infinity, concurrency: 8, maxFileMb: 0, ext: null, shard: null, skipSystem: true, docsOnly: false, exclude: [], fromReport: null, root: null, authorizedRoots: [], allowNetworkPaths: false, confirmNetworkPaths: false, confirmDelete: false, action: 'delete', custom: '', report: null, scope: 'firstlast', html: false, htmlFile: null, moveTo: null, moveDryRun: false, delete: false, deleteDryRun: false, words: null, nameWords: null, nameMode: 'or', whole: false, excludeCtx: [], caseSensitive: false, verify: false, pick: [], pickWord: [], pickDir: [], pickList: null, inPlace: false, backup: true, deleteBak: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--drive') o.drive = argv[++i];
    else if (a === '--dir') o.dirs.push(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--clean') o.clean = true;
    else if (a === '--json') o.json = true;
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || Infinity;
    else if (a === '--depth') o.depth = parseInt(argv[++i], 10) || Infinity;
    else if (a === '--no-skip-system') o.skipSystem = false;
    else if (a === '--docs-only') o.docsOnly = true;
    else if (a === '--concurrency') o.concurrency = parseInt(argv[++i], 10) || 8;
    else if (a === '--max-file-mb') o.maxFileMb = parseInt(argv[++i], 10) || 0;
    else if (a === '--ext') o.ext = argv[++i];
    else if (a === '--shard') o.shard = argv[++i];
    else if (a === '--all-ext') o.ext = 'all';
    else if (a === '--from-report') o.fromReport = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--authorized-root') o.authorizedRoots.push(argv[++i]);
    else if (a === '--allow-network-paths') o.allowNetworkPaths = true;
    else if (a === '--confirm-network-paths') o.confirmNetworkPaths = true;
    else if (a === '--action') o.action = argv[++i];
    else if (a === '--custom') o.custom = argv[++i];
    else if (a === '--scope') o.scope = String(argv[++i] || '').toLowerCase();
    else if (a === '--html') { o.html = true; const nv = argv[i + 1]; if (nv && !nv.startsWith('--')) o.htmlFile = argv[++i]; }
    else if (a === '--move-to') o.moveTo = argv[++i];
    else if (a === '--move-dry-run') o.moveDryRun = true;
    else if (a === '--delete') o.delete = true;
    else if (a === '--confirm-delete') o.confirmDelete = true;
    else if (a === '--delete-dry-run') { o.delete = true; o.deleteDryRun = true; }
    else if (a === '--exclude') o.exclude = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--words') o.words = String(argv[++i] || '');
    else if (a === '--name-words') o.nameWords = String(argv[++i] || '');
    else if (a === '--name-mode') o.nameMode = String(argv[++i] || '').toLowerCase() === 'and' ? 'and' : 'or';
    else if (a === '--whole') o.whole = true;
    else if (a === '--exclude-ctx') o.excludeCtx = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--case-sensitive') o.caseSensitive = true;
    else if (a === '--verify') o.verify = true;
    else if (a === '--pick') o.pick.push(argv[++i]);
    else if (a === '--pick-word') o.pickWord.push(argv[++i]);
    else if (a === '--pick-dir') o.pickDir.push(argv[++i]);
    else if (a === '--pick-list') o.pickList = argv[++i];
    else if (a === '--in-place') o.inPlace = true;
    else if (a === '--no-backup') o.backup = false;
    else if (a === '--delete-bak') o.deleteBak = true;
    else if (!a.startsWith('--') && !o.dirs.length && !o.drive) {
      if (/^[A-Za-z]:$/.test(a)) o.drive = a; else o.dirs.push(a);
    }
  }
  if (['firstlast', 'first', 'all'].indexOf(o.scope) === -1) o.scope = 'firstlast';
  o.nameWords = parseNameWords(o.nameWords);
  if (o.nameMode !== 'and') o.nameMode = 'or';
  if (o.html && !o.htmlFile) o.htmlFile = 'scan-report.html';
  return o;
}

/** 解析文件名关键字列表：中英文逗号 / 分号 / 空白均可分隔 */
function parseNameWords(raw) {
  if (raw == null) return null;
  const list = String(raw).split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
  return list.length ? list : null;
}

/** 文件名是否命中关键字。mode='and' 要求全部包含，'or' 任一包含。
 *  只判文件名，不含目录路径：目录名含目标词不该让整棵子树的文件都算命中。 */
function nameHit(fullPath, words, mode) {
  if (!words) return true;
  const base = String(fullPath).replace(/\\/g, '/').split('/').pop();
  const low = base.toLowerCase();
  const has = (w) => low.indexOf(String(w).toLowerCase()) >= 0;
  return mode === 'and' ? words.every(has) : words.some(has);
}
async function pathExists(p) { try { await fsp.stat(p); return true; } catch (e) { return false; } }

function isNetworkPath(p) {
  const s = String(p || '');
  return /^[\\/]{2}[^\\/]/.test(s) || /^\\\\\?\\UNC\\/i.test(s);
}

function pathInside(root, target) {
  const fold = (s) => process.platform === 'win32' ? String(s).toLowerCase() : String(s);
  const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(target)));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** 对尚不存在的路径也做 canonical 化：解析最近的已存在父目录，再接回剩余段。 */
async function canonicalForCheck(p) {
  const abs = path.resolve(p);
  try {
    return await fsp.realpath(abs);
  } catch (e) {
    if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
  }
  let cursor = abs;
  const tail = [];
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return abs;
    tail.unshift(path.basename(cursor));
    cursor = parent;
    try {
      const realParent = await fsp.realpath(cursor);
      return path.join(realParent, ...tail);
    } catch (e) {
      if (!e || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
    }
  }
}

/**
 * 报告文件属于外部输入。所有将要读取、覆盖、备份或删除的源路径，
 * 都必须先解析真实路径并夹在用户显式授权目录内；网络路径还要双重开关。
 */
async function authorizeReportFiles(items, options) {
  if (!options.authorizedRoots.length) {
    throw new Error('报告模式缺少 --authorized-root。请显式指定报告路径允许触碰的目录（可重复）。');
  }
  const networkRequested = isNetworkPath(options.fromReport) ||
    options.authorizedRoots.some(isNetworkPath) || items.some((x) => isNetworkPath(x.file));
  if (networkRequested && (!options.allowNetworkPaths || !options.confirmNetworkPaths)) {
    throw new Error('报告包含网络路径。确需访问时必须同时提供 --allow-network-paths --confirm-network-paths。');
  }
  const roots = [];
  for (const raw of options.authorizedRoots) {
    const real = await canonicalForCheck(raw);
    const st = await fsp.stat(real);
    if (!st.isDirectory()) throw new Error('授权根不是目录: ' + raw);
    roots.push(real);
  }
  const offenders = [];
  for (const item of items) {
    const real = await canonicalForCheck(item.file);
    if (!roots.some((root) => pathInside(root, real))) offenders.push(item.file);
    else item.file = real;
  }
  if (offenders.length) {
    throw new Error('报告中有 ' + offenders.length + ' 个路径不在授权根内，已拒绝全部操作。示例: '
      + offenders.slice(0, 3).join(' | '));
  }
  return roots;
}

async function uniqueDest(p) {
  if (!(await pathExists(p))) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const bn = path.basename(p, ext);
  for (let i = 2; i < 100; i++) {
    const q = path.join(dir, bn + ' (' + i + ')' + ext);
    if (!(await pathExists(q))) return q;
  }
  throw new Error('同名文件过多，无法生成不冲突的目标路径: ' + p);
}

// 剪切(移动)：优先 rename；跨盘时回退为「复制 → 校验 → 删除源文件」，任一步失败则保留源文件
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
    return;
  } catch (e) {
    if (!e || e.code !== 'EXDEV') throw e;
  }
  await fsp.copyFile(from, to);
  try {
    const stFrom = await fsp.stat(from);
    const stTo = await fsp.stat(to);
    if (stFrom.size !== stTo.size) throw new Error('跨盘复制后大小不一致');
  } catch (e2) {
    try { await fsp.unlink(to); } catch (e3) {}
    throw e2;
  }
  try { await fsp.unlink(from); }
  catch (e3) { try { await fsp.unlink(to); } catch (e4) {} throw e3; }
}

function posLabel(firstHit, lastHit) {
  if (firstHit && lastHit) return '首行+尾行';
  if (firstHit) return '首行';
  if (lastHit) return '尾行';
  return '其他位置';
}

/**
 * 生成 CSV 正文（行尾 CRLF，便于 Excel 直接打开）。
 * 单元格转义必须用 js/util.js 那一份（`csvFn` 由调用方传入 DWRUtil.csvCell）：
 * 此前这里另写了一份只做 RFC 4180 转义的 csvCell，util.js 注释却声称「网页端与 scan.mjs
 * 共用同一份实现」——命令行报告因此拿不到公式注入防护，只有网页端有。
 */
function toCsv(results, csvFn) {
  const lines = ['file,hits,matched,pos,ratio'];
  results.forEach((r) => lines.push([
    r.file, r.hits, (r.matched || []).join(' / '), posLabel(!!r.firstHit, !!r.lastHit), r.ratio ? (r.ratio * 100).toFixed(2) + '%' : ''
  ].map(csvFn).join(',')));
  return lines.join('\r\n') + '\r\n';
}

function fmtTime(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fileUrl(p) {
  const s = String(p).replace(/\\/g, '/');
  const out = s.split('/').map((seg, i) => {
    if (i === 0 && /^[A-Za-z]:$/.test(seg)) return seg;
    if (seg === '') return '';
    return encodeURIComponent(seg);
  }).join('/');
  return (out.charAt(0) === '/' ? 'file://' : 'file:///') + out;
}

function typeLabel(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  const map = {
    docx: 'Word', docm: 'Word(宏)', dotx: 'Word模板', dotm: 'Word模板(宏)', doc: 'Word',
    xlsx: 'Excel', xlsm: 'Excel(宏)', xltx: 'Excel模板', xltm: 'Excel模板(宏)', xls: 'Excel',
    pptx: 'PPT', pptm: 'PPT(宏)', potx: 'PPT模板', potm: 'PPT模板(宏)', ppsx: 'PPT放映', ppsm: 'PPT放映(宏)', ppt: 'PPT',
    txt: '文本', text: '文本', rst: '文本', md: 'Markdown', markdown: 'Markdown',
    csv: 'CSV', tsv: 'TSV'
  };
  return map[ext] || (ext ? ext.toUpperCase() : '文件');
}

/** 组装生效规则：默认词库（自带排除上下文）或 --words 覆盖；
 *  --whole 为所有规则开启整词匹配；--exclude-ctx 为所有规则追加排除上下文 */
function buildRules(D, o) {
  let rules;
  if (o.words != null && String(o.words).trim() !== '') {
    rules = String(o.words).split(',').map((s) => s.trim()).filter(Boolean).map((w) => {
      if (w.length > 2 && w.charAt(0) === '/' && w.charAt(w.length - 1) === '/') {
        return { text: w.slice(1, -1), type: 'regex', enabled: true };
      }
      return { text: w, type: 'text', enabled: true };
    });
  } else {
    rules = D.DWRRules.DEFAULT_PRESETS.map((p) => ({
      text: p.word, type: 'text', enabled: true,
      notBefore: p.notBefore, notAfter: p.notAfter, whole: p.whole, group: p.group
    }));
  }
  if (o.whole) rules.forEach((r) => { r.whole = true; });
  if (o.excludeCtx.length) rules.forEach((r) => {
    r.notBefore = (r.notBefore || []).concat(o.excludeCtx);
    r.notAfter = (r.notAfter || []).concat(o.excludeCtx);
  });
  return rules;
}

/** 按组汇总词库：返回 [{name, count}]，供 HTML 报告的「目标字样」按组展示。
 *  v4.6 起默认词库分 4 组 23 词，平铺成一长串既读不清也看不出哪些能整组停用。 */
function groupSummary(rules) {
  var by = {};
  var order = [];
  rules.forEach(function (r) {
    var g = r.group || '未分组';
    if (!by[g]) { by[g] = 0; order.push(g); }
    by[g]++;
  });
  return order.map(function (g) { return { name: g, count: by[g] }; });
}

/** HTML 报告的「目标字样」单元格：按组分段，组名加粗并带词数。 */
function wordListHtml(opts) {
  var words = opts.words || [];
  var groups = opts.groups || [];
  var plain = words.map(escapeHtml).join(' / ');
  if (groups.length <= 1) return plain;
  var segs = groups.map(function (g) {
    return '<b>' + escapeHtml(g.name) + '</b>（' + g.count + '）';
  });
  return segs.join(' · ') + '<br><span style="color:var(--ink3)">' + plain + '</span>';
}
function renderHtmlReport(opts) {
  const rows = opts.results.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const nFiles = rows.length;
  const nHits = rows.reduce((acc, r) => acc + (r.hits || 0), 0);
  const scopeLabel = { firstlast: '仅首行 + 尾行', first: '仅首行 / 首段', all: '全文' }[opts.scope] || opts.scope;
  const typeCount = {};
  rows.forEach((r) => { const t = typeLabel(r.file); typeCount[t] = (typeCount[t] || 0) + 1; });
  const typeText = Object.keys(typeCount).map((k) => k + ' ' + typeCount[k]).join(' · ');

  const tableRows = rows.map((r, i) => {
    const dir = path.dirname(r.file);
    const name = path.basename(r.file);
    const dirUrl = fileUrl(dir) + (fileUrl(dir).endsWith('/') ? '' : '/');
    return '<tr>' +
      '<td class="c-no">' + (i + 1) + '</td>' +
      '<td class="c-file"><a class="fname" href="' + escapeHtml(fileUrl(r.file)) + '" title="点击打开文件">' + escapeHtml(name) + '</a>' +
      '<div class="fpath">' + escapeHtml(r.file) + '</div></td>' +
      '<td class="c-type">' + escapeHtml(typeLabel(r.file)) + '</td>' +
      '<td class="c-pos">' + posLabel(!!r.firstHit, !!r.lastHit) + '</td>' +'<td class="c-ratio">' + (r.ratio ? (r.ratio * 100).toFixed(1) + '%' : '-') + '</td>' +
      '<td class="c-words">' + escapeHtml((r.matched || []).join('、')) + '</td>' +
      '<td class="c-dir"><a href="' + escapeHtml(dirUrl) + '" title="打开所在目录">目录</a></td>' +
      '</tr>';
  }).join('');

  const body = nFiles
    ? '<table><thead><tr><th class="c-no">#</th><th>文件</th><th class="c-type">类型</th><th class="c-pos">位置</th><th class="c-ratio">命中占比</th><th class="c-words">命中字样</th><th class="c-dir">目录</th></tr></thead><tbody>' + tableRows + '</tbody></table>'
    : '<p class="empty">未发现「首行 / 尾行」含目标字样的文档。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>涉密标识文档清单</title>
<style>
  :root{
    --paper:#f6f6f7; --ink:#17171a; --ink2:#55555e; --ink3:#8b8b94;
    --hair:#dedee1; --hair2:#c7c7cc; --accent:#1e4e79;
    --mono:"Cascadia Mono",Consolas,"SFMono-Regular",Menlo,monospace;
    --sans:"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 var(--sans)}
  .wrap{max-width:1180px;margin:0 auto;padding:64px clamp(20px,4vw,48px) 80px}
  .kicker{font:500 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 18px}
  h1{margin:0 0 14px;font-size:clamp(24px,3vw,32px);font-weight:600;letter-spacing:-.01em;line-height:1.25}
  .lede{margin:0 0 8px;color:var(--ink2);font-size:14.5px;max-width:76ch}
  .hint{color:var(--ink3);font-size:12.5px;margin:0 0 30px}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px 28px;padding:16px 0;border-top:1px solid var(--hair2);border-bottom:1px solid var(--hair2);margin:0 0 40px}
  .meta dt{font:500 10.5px/1.5 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);margin:0 0 3px}
  .meta dd{margin:0;font-size:13.5px;color:var(--ink);word-break:break-all}
  .meta .num{font-family:var(--mono)}
  table{width:100%;border-collapse:collapse;table-layout:fixed}
  thead th{font:500 10.5px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);text-align:left;padding:0 12px 10px 0;border-bottom:1.5px solid var(--ink);white-space:nowrap}
  tbody td{padding:12px 12px 12px 0;border-bottom:1px solid var(--hair);font-size:13.5px;vertical-align:top}
  .c-no{width:38px;color:var(--ink3);font:12px/1.6 var(--mono)}
  .c-type{width:64px;color:var(--ink2);font-size:12.5px}
  .c-pos{width:92px;color:var(--ink2);font-size:12.5px;white-space:nowrap}
  .c-ratio{width:76px;color:var(--ink2);font-size:12.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
  .c-words{width:150px}
  .c-dir{width:56px;text-align:right}
  .fname{color:var(--ink);font-weight:550;text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--hair2);text-underline-offset:3px}
  .fpath{display:block;font:11.5px/1.55 var(--mono);color:var(--ink3);margin-top:4px;word-break:break-all}
  .c-dir a{color:var(--ink2);text-decoration:underline;text-decoration-thickness:1px;text-decoration-color:var(--hair2);text-underline-offset:3px;font-size:12.5px}
  .empty{padding:44px 0;color:var(--ink2);border-bottom:1px solid var(--hair);margin:0}
  footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--hair2);color:var(--ink3);font-size:12.5px;line-height:1.9}
  .foot-meta{font:11.5px/1.9 var(--mono);color:var(--ink3)}
  @media (max-width:760px){
    .c-type,.c-words{display:none}
    .wrap{padding-left:20px;padding-right:20px}
  }
</style>
</head>
<body>
<main class="wrap">
  <p class="kicker">Doc-Internal-Word-Remover · 扫描清单</p>
  <h1>涉密标识文档清单</h1>
  <p class="lede">仅列出「首行 / 尾行」含目标字样的文档（Office 文档为首个 / 末个文本段落）。</p>
  <p class="hint">点击文件名可打开文件；点击「目录」可查看其所在文件夹。建议使用 Chrome / Edge 打开本页。</p>
  <dl class="meta">
    <div><dt>生成时间</dt><dd class="num">${escapeHtml(opts.timeStr)}</dd></div>
    <div><dt>扫描范围</dt><dd>${opts.targets.map((t) => escapeHtml(t)).join('<br>')}</dd></div>
    <div><dt>目标字样</dt><dd>${wordListHtml(opts)}</dd></div>
    <div><dt>匹配范围</dt><dd>${escapeHtml(scopeLabel)}</dd></div>
    <div><dt>结果</dt><dd><span class="num">${nFiles}</span> 个文件 · <span class="num">${nHits}</span> 处命中<br>扫描 <span class="num">${opts.scanned}</span> 个文件 · ${escapeHtml(opts.sec)} 秒</dd></div>
  </dl>
  ${body}
  <footer>
    <p>本清单为只读扫描结果，未修改任何原始文件。文件链接为本地路径（file:///），在浏览器中点击即可打开或下载；点击「目录」可在浏览器中查看该文件夹内容。</p>
    <p class="foot-meta">${typeText ? '类型分布：' + escapeHtml(typeText) : ''}<br>Doc-Internal-Word-Remover · scan.mjs · 与 JSON / CSV 报告同源，可复核</p>
  </footer>
</main>
</body>
</html>`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const D = await loadEngine();
  const MAX_FILE_BYTES = (o.maxFileMb > 0 ? o.maxFileMb : 32) * 1024 * 1024;
  const MAX_REPORT_BYTES = 64 * 1024 * 1024;

  if (!o.fromReport && (o.pick.length || o.pickWord.length || o.pickDir.length || o.pickList)) {
    console.log('[提示] --pick / --pick-word / --pick-dir / --pick-list 只在 --from-report 报告模式下生效，本次实时扫描会忽略它们');
  }

  // 清除后自检：外部保密检查软件按「解包 + 全文检索」工作，引擎的部件策略与范围限定管不到它们
  const verifyState = { files: 0, dirty: 0, remain: 0, fail: 0 };
  // v4.3 因超过大小上限而跳过的文件数（--from-report 路径也汇总它，声明必须在 main 顶部）
  let skippedBig = 0;
  let skippedEmpty = 0;  // 读到 0 字节而跳过的文件（网络盘一致性）
  let verifyEngine = null;
  // 自检引擎：与清理用同一套词库，范围固定全文（惰性创建，此处 rules 尚未生成）
  function getVerifyEngine() {
    if (!o.verify) return null;
    if (!verifyEngine) {
      verifyEngine = D.DWRRules.createEngine({
        rules, scope: 'all', action: o.action, custom: o.custom, caseSensitive: o.caseSensitive,
      });
    }
    return verifyEngine;
  }
  async function verifyOut(full, buf) {
    const eng = getVerifyEngine();
    if (!eng || !buf || !buf.length) return;
    try {
      const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      let r;
      if (D.DWRDoc.isOfficeFile(full)) {
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        r = await D.DWRDoc.verifyOffice(ab, eng);
      } else {
        r = await D.DWRDoc.verifyBytes(u8, eng);
      }
      verifyState.files++;
      if (r && r.hits > 0) {
        verifyState.dirty++;
        verifyState.remain += r.hits;
        const where = r.parts && r.parts.length
          ? '；位置: ' + r.parts.map((pp) => pp.name + '(' + pp.hits + ')').join('、')
          : '';
        console.log('[残留 ' + r.hits + '] ' + full + ' => ' + (r.matched || []).join('、') + where);
      }
    } catch (e) { verifyState.fail++; }
  }
  function verifySummary() {
    if (!o.verify) return;
    console.log('清除后自检  : 复检 ' + verifyState.files + ' 个输出，仍有残留 ' + verifyState.dirty + ' 个 / ' + verifyState.remain + ' 处'
      + (verifyState.fail ? '，复检失败 ' + verifyState.fail + ' 个' : ''));
    if (verifyState.dirty) process.exitCode = 2;
  }


  // v4.4 分片扫描：--shard k/n 只扫第 k 片（按文件完整路径哈希分片，稳定可复现）。
  // 大盘（网络盘 / 数百万文件）单进程扫会 OOM，切 n 段分别扫再合并报告即可。
  // 改为按每个文件的完整路径哈希，文件数会更均匀地分摊到各片；
  // n 片合并后的墙钟时间更接近单进程扫描的 1/n。
  let shardK = 0, shardN = 1;
  if (o.shard) {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(o.shard));
    if (!m || +m[2] < 1 || +m[1] < 1 || +m[1] > +m[2]) {
      console.error('错误: --shard 格式为 k/n（1 <= k <= n），如 --shard 1/4');
      process.exit(1);
    }
    shardK = +m[1]; shardN = +m[2];
    console.log('分片扫描    : 第 ' + shardK + ' / ' + shardN + ' 片（按文件路径哈希均衡切分）');
  }
  function inShard(fullPath) {
    if (shardN <= 1) return true;
    // 归一化分隔符：同一文件在 Windows / POSIX 下要落进同一片
    const BACKSLASH = String.fromCharCode(92), SLASH = String.fromCharCode(47);
    const key = String(fullPath).split(BACKSLASH).join(SLASH);
    // 必须用 Math.imul：h * 16777619 从第二轮起就超过 2^53，浮点乘法丢精度后
    // 哈希值分布严重倾斜（实测 1000 个文件切 4 片得到 907/1/49/43，分片形同虚设）。
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return (h % shardN) === (shardK - 1);
  }

  const rules = buildRules(D, o);
  const engine = D.DWRRules.createEngine({
    rules: rules,
    scope: o.scope, action: o.action, custom: o.custom,
    caseSensitive: o.caseSensitive,
  });

  // 报告模式：按已有命中清单处理指定文件。三种去处：
  //   默认   → 生成脱敏副本到 --out（原文件不动）
  //   --in-place → 就地脱敏，直接改写原文件（默认先备份 .bak）
  //   --delete   → 默认只演练；实际删除还需 --confirm-delete
  if (o.fromReport) {
    if (!o.out && !o.inPlace && !o.delete) {
      console.error('错误: --from-report 需要指定去处：--out 输出目录 / --in-place 就地脱敏 / --delete 删除原文件');
      process.exit(1);
    }
    if (o.inPlace && o.delete) {
      console.error('错误: --in-place 与 --delete 不能同时使用（就地脱敏后原文件已是干净版本，再删除就没有任何留存了）');
      process.exit(1);
    }
    if (o.deleteBak && (!o.inPlace || !o.backup)) {
      console.error('错误: --delete-bak 只在 --in-place 且开启了备份时才有意义');
      process.exit(1);
    }
    if (isNetworkPath(o.fromReport) && (!o.allowNetworkPaths || !o.confirmNetworkPaths)) {
      console.error('错误: 报告位于网络路径。确需访问时必须同时提供 --allow-network-paths --confirm-network-paths。');
      process.exit(1);
    }
    const reportStat = await fsp.stat(o.fromReport);
    if (reportStat.size > MAX_REPORT_BYTES) {
      console.error('错误: 报告超过 ' + Math.round(MAX_REPORT_BYTES / 1048576) + ' MB 安全上限');
      process.exit(1);
    }
    const reportBuf = await fsp.readFile(o.fromReport);
    const parsed = D.DWRReport.parseAny(path.basename(o.fromReport), D.DWRReport.decodeBytes(reportBuf));
    const all = parsed.files;
    if (!all.length) {
      console.error('错误: 报告未解析出任何文件路径: ' + o.fromReport);
      console.error('      支持：JSON 清单 / 通用检查报告 HTML / 纯路径清单（每行一个路径）');
      process.exit(1);
    }
    // --pick-list：先给人把要处理的文件列成清单，再让机器照着做
    if (o.pickList) {
      let txt = '';
      if (isNetworkPath(o.pickList) && (!o.allowNetworkPaths || !o.confirmNetworkPaths)) {
        console.error('错误: --pick-list 位于网络路径。确需访问时必须同时提供 --allow-network-paths --confirm-network-paths。');
        process.exit(1);
      }
      try { txt = await fsp.readFile(o.pickList, 'utf8'); } catch (e) {
        console.error('错误: 读不到 --pick-list 清单文件 ' + o.pickList + '（' + ((e && e.code) || (e && e.message) || e) + '）');
        process.exit(1);
      }
      txt.replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function (line) {
        const s = line.trim();
        if (s && s.charAt(0) !== '#') o.pick.push(s);
      });
    }
    const picked = pickReportFiles(all, o);
    const list = picked.list;
    if (!list.length) {
      console.error('错误: ' + picked.why);
      console.error('      报告共 ' + all.length + ' 条；去掉 --pick / --pick-word / --pick-dir / --pick-list 即处理全部。');
      process.exit(1);
    }
    await authorizeReportFiles(list, o);
    if (o.delete && !o.confirmDelete) {
      o.deleteDryRun = true;
      console.log('[安全模式] --delete 默认只演练；确认无误后加 --confirm-delete 才会实际删除。');
    }
    const root = o.root || commonRoot(list.map((x) => x.file));
    if (parsed.sections && parsed.sections.length) console.log('报告分节: ' + parsed.sections.join(' / '));
    console.log('==== 报告处理模式 ====');
    console.log('命中清单: ' + o.fromReport + '（' + all.length + ' 条'
      + (list.length !== all.length ? '，按条件挑出 ' + list.length + ' 条' : '') + '）');
    if (list.length !== all.length) {
      console.log('挑选条件: '
        + [].concat(o.pickWord.length ? ['命中词 ' + o.pickWord.join('、')] : [],
          o.pickDir.length ? ['目录 ' + o.pickDir.join('、')] : [],
          o.pick.length ? ['路径 ' + o.pick.length + ' 条'] : [],
          o.pickList ? ['清单 ' + o.pickList] : []).join('；'));
    }
    const modeLabel = o.delete
      ? (o.deleteDryRun ? '删除演练（不实际删除）'
        : o.out ? '脱敏副本写入输出目录后删除原件'
          : '删除原文件（不可恢复）')
      : o.inPlace ? '就地脱敏（' + (o.backup ? '先备份 .bak' : '不备份') + '）'
        : '生成脱敏副本';
    console.log('处理方式: ' + modeLabel);
    if (!o.delete || o.out) {
      console.log('用词处理: ' + ({ delete: '删除敏感词', mask: '打码为 ***', custom: '替换为「' + o.custom + '」' }[o.action] || o.action));
    }
    if (o.out) console.log('输出目录: ' + o.out + (o.delete ? '（删除前先留一份副本）' : ''));
    if (o.out && !o.delete) console.log('镜像基准: ' + (root || '各盘符根目录（报告横跨多个盘符，按盘符分子目录）'));
    console.log('并发路数: ' + (o.concurrency > 0 ? o.concurrency : 8));
    if (o.moveTo) console.log('注意    : --from-report 模式不执行文件剪切（--move-to 仅在实时扫描命中时生效）');
    console.log('----------------------------------------');

    const conc = o.concurrency > 0 ? o.concurrency : 8;
    const mapPool = (D.DWRUtil && D.DWRUtil.mapPool) ? D.DWRUtil.mapPool
      : (items, limit, fn) => Promise.all(items.map((it, i) => fn(it, i)));

    let done = 0, totalHits = 0, fail = 0, skip = 0, finished = 0, unsupported = 0, clamped = 0;
    let deleted = 0, deleteFail = 0, deleteBlocked = 0, missing = 0, bakCount = 0, bakFail = 0, planned = 0;

    await mapPool(list, conc, async (item) => {
      try {
        if (!D.DWRDoc.isSupported(item.file)) { unsupported++; return; }
        let st;
        try { st = await fsp.stat(item.file); } catch (eS) {
          missing++;
          console.log('[不存在] ' + item.file);
          return;
        }
        if (!st.isFile()) { unsupported++; return; }
        if (st.size > MAX_FILE_BYTES) {
          skippedBig++;
          console.log('[超大已跳过] ' + item.file);
          return;
        }
        // 演练零副作用：不读内容、不写副本、不删文件，只报告计划
        if (o.delete && o.deleteDryRun) {
          planned++;
          console.log('[将删除] ' + item.file + (o.out ? '（会先脱敏出一份副本）' : ''));
          return;
        }
        // 纯删除（未给 --out）：不读内容，直接按清单删。
        // 给了 --out 时必须先脱敏出一份副本再删，走下面的副本分支。
        if (o.delete && !o.out) {
          try {
            await fsp.unlink(item.file);
            deleted++;
            console.log('[已删除] ' + item.file);
          } catch (eD) {
            deleteFail++;
            console.log('[删除失败] ' + item.file + ' => ' + String((eD && eD.code) || (eD && eD.message) || eD));
          }
          return;
        }

        const buf = await fsp.readFile(item.file);
        if (!buf.length) { skippedEmpty++; return; }
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        let outBuf = null, h = 0;
        if (D.DWRDoc.isOfficeFile(item.file)) {
          const res = await D.DWRDoc.processOffice(ab, engine);
          if (res.touched && res.blob) {
            outBuf = Buffer.from(await res.blob.arrayBuffer());
            h = res.hits;
          }
        } else {
          const dec = D.DWRDoc.decodeText(buf);
          const r = D.DWRDoc.processText(dec.text, engine, dec.encoding);
          if (r.touched) {
            outBuf = D.DWRDoc.encodeText(r.text, dec.bom, dec.encoding);
            h = r.hits;
          }
        }
        if (!outBuf) { skip++; return; }

        if (o.inPlace) {
          // 先备份、再写临时文件、最后原子替换。任何一步失败都不能动原文件。
          let bak = null;
          if (o.backup) {
            try {
              bak = await freshBakFor(item.file);
              await fsp.copyFile(item.file, bak);
              bakCount++;
            } catch (eB) {
              // 备份没落地就覆盖，等于把唯一一份原件押在一次写入上
              fail++;
              console.log('[备份失败，已保留原文件] ' + item.file + ' => ' + String((eB && eB.code) || (eB && eB.message) || eB));
              return;
            }
          }
          const tmp = item.file + '.dwr-tmp-' + process.pid;
          try {
            await fsp.writeFile(tmp, outBuf);
            await fsp.rename(tmp, item.file);
          } catch (eW) {
            try { await fsp.unlink(tmp); } catch (eT) { /* 清理临时文件失败不应盖住原始错误 */ }
            fail++;
            console.log('[写回失败，原文件未替换] ' + item.file + ' => ' + String((eW && eW.code) || (eW && eW.message) || eW));
            return;
          }
          done++; totalHits += h;
          await verifyOut(item.file, outBuf);
          console.log('[已脱敏] ' + item.file + '（' + h + ' 处' + (bak ? '，备份 ' + path.basename(bak) : '') + '）');
          if (o.deleteBak && bak) {
            try { await fsp.unlink(bak); }
            catch (eB2) {
              bakFail++;
              console.log('[备份未删除] ' + bak + ' => ' + String((eB2 && eB2.code) || (eB2 && eB2.message) || eB2));
            }
          }
          return;
        }

        // 副本模式（含 --delete 时的「先留副本再删除」）：必须先写成功，才允许删源文件
        const rel = root ? path.relative(root, item.file) : mirrorRel(item.file);
        const destOf = clampInside(o.out, rel, item.file);
        if (destOf.clamped) {
          clamped++;
          console.log('[路径越界] ' + item.file + ' 按镜像基准 ' + (root || '（无）') + ' 会写到 --out 之外，已夹到输出目录内：' + destOf.dest);
        }
        await fsp.mkdir(path.dirname(destOf.dest), { recursive: true });
        await fsp.writeFile(destOf.dest, outBuf);
        done++; totalHits += h;
        await verifyOut(item.file, outBuf);
        if (o.delete) {
          try {
            await fsp.unlink(item.file);
            deleted++;
            console.log('[已脱敏并删除原件] ' + item.file + ' → 副本 ' + destOf.dest);
          } catch (eD) {
            deleteBlocked++;
            console.log('[删除失败，原文件保留] ' + item.file + ' => ' + String((eD && eD.code) || (eD && eD.message) || eD));
          }
        }
      } catch (e) {
        fail++;
        console.log('[失败] ' + item.file + ' => ' + String((e && e.code) || (e && e.message) || e));
      } finally {
        finished++;
        if (finished % 20 === 0 || finished === list.length) {
          process.stdout.write('\r已处理 ' + finished + '/' + list.length + '，完成 ' + done + ' 个...');
        }
      }
    });

    console.log('\n==== 处理完成 ====');
    if (o.inPlace) {
      console.log('就地脱敏    : ' + done + ' 个');
      console.log('生成备份    : ' + bakCount + ' 个' + (o.deleteBak ? '（已按 --delete-bak 清理）' : ''));
    } else if (o.delete) {
      if (o.deleteDryRun) console.log('删除演练    : 计划删除 ' + planned + ' 个文件，均未实际删除');
      else console.log('已删除原文件: ' + deleted + ' 个' + (deleteFail ? '（失败 ' + deleteFail + ' 个）' : ''));
      if (done && !o.deleteDryRun) console.log('删除前副本  : ' + done + ' 个（已写入输出目录）');
    } else {
      console.log('生成脱敏副本: ' + done + ' 个');
    }
    console.log('清除敏感词  : ' + totalHits + ' 处');
    console.log('无需处理    : ' + skip + ' 个（按当前词库复检未命中，即检查软件误报）');
    if (fail) console.log('处理失败    : ' + fail + ' 个');
    if (deleteBlocked) console.log('删除受阻    : ' + deleteBlocked + ' 个（副本写成功后仍删不掉，原文件已保留）');
    if (missing) console.log('文件不存在  : ' + missing + ' 个（报告里列出但磁盘上已没有）');
    if (bakFail) console.log('备份未清理  : ' + bakFail + ' 个（含敏感原文，请手工删除）');
    if (skippedBig) console.log('超大已跳过  : ' + skippedBig + ' 个（超过 ' + Math.round(MAX_FILE_BYTES / 1048576) + 'MB，可用 --max-file-mb 调整）');
    if (skippedEmpty) console.log('空文件跳过  : ' + skippedEmpty + ' 个（网络盘读到 0 字节，多为同步中或被占用）');
    if (unsupported) console.log('不支持格式  : ' + unsupported + ' 个（.doc/.pdf 等二进制格式，需先用 Office/WPS 另存为 docx 再处理）');
    if (clamped) console.log('路径越界    : ' + clamped + ' 个（镜像基准与报告层级不符，副本已改写到 --out 之内）');
    if (o.out) console.log('输出目录    : ' + o.out);
    if (!o.inPlace && !o.delete) console.log('（原始文件未被修改）');
    verifySummary();
    return;
  }

  let targets = [];
  if (o.drive) {
    // Windows --drive D: 或 Linux --drive /home
    if (process.platform === 'win32') {
      targets.push(o.drive.endsWith('\\') ? o.drive : o.drive + '\\');
    } else {
      targets.push(o.drive);
    }
  } else if (o.dirs.length) {
    targets = o.dirs.map((d) => path.resolve(d));
  } else {
    console.error('用法: node scan.mjs --drive <盘符或路径> 或 --dir <目录>（可多次） [--clean --out 输出目录] [--json] [--html 索引.html] [--scope firstlast|first|all] [--move-to 剪切目录] [--limit N] [--depth N] [--concurrency N]');
  console.error('准确性选项: [--words 词1,词2,/正则/] [--whole] [--exclude-ctx 前缀词,后缀词] [--case-sensitive]');
    console.error('  Windows: node scan.mjs --drive D:');
    console.error('  多目录  : node scan.mjs --dir "D:\\工作文档" --dir "D:\\资料"');
    console.error('  Linux  : node scan.mjs --drive /home  或  node scan.mjs --dir /home/user/文档');
    console.error('  按报告脱敏: node scan.mjs --from-report scan-report.json --authorized-root "D:\\资料" --out cleaned');
    console.error('  就地脱敏  : node scan.mjs --from-report scan-report.json --authorized-root "D:\\资料" --in-place [--no-backup] [--delete-bak]');
    console.error('  按报告删除: node scan.mjs --from-report scan-report.json --authorized-root "D:\\资料" --delete [--confirm-delete]');
    console.error('  安全说明  : 报告路径必须位于 --authorized-root 内；--delete 默认只演练。');
    console.error('  网络路径  : 需同时提供 --allow-network-paths --confirm-network-paths');
    console.error('  只挑指定文件: [--pick 路径/通配符] [--pick-word 命中词] [--pick-dir 目录] [--pick-list 清单.txt]');
    console.error('  报告可为  : 本工具 JSON / 通用检查报告 HTML / 纯路径清单（每行一个路径）');
    process.exit(1);
  }
  if (o.clean && !o.out) {
    console.error('错误: --clean 需要配合 --out 指定输出目录');
    process.exit(1);
  }

  if (o.moveTo) {
    o.moveTo = path.resolve(o.moveTo);
    // v4.16 演练模式零副作用：--move-dry-run 只列计划不动文件，
    // 此前无条件 mkdir 会在磁盘上留一个空目录，「演练」名不副实。
    if (!o.moveDryRun) {
      try {
        await fsp.mkdir(o.moveTo, { recursive: true });
      } catch (e) {
        console.error('错误: 无法创建剪切目标目录 ' + o.moveTo + '（' + (e && e.message ? e.message : e) + '）');
        process.exit(1);
      }
    }
    for (const t of targets) {
      const rel = path.relative(path.resolve(t), o.moveTo);
      if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) {
        console.log('[警告] 剪切目标位于扫描范围（' + t + '）内，移动后的文件可能被再次扫描命中');
        break;
      }
    }
  }

  // v4.69：目标必须真实存在且是目录。此前 --dir <文件> 或拼错的路径被 readdir 抛错后
  // continue 掉，最后报「扫描文件数 0 / 命中 0」还写出报告——对保密检查而言，
  // 这是把「根本没扫」伪装成「扫过且干净」，比漏删更危险。
  for (const t of targets) {
    let st = null, why = '';
    try {
      st = await fsp.stat(t);
    } catch (e) {
      why = String((e && e.code) || (e && e.message) || e);
    }
    if (!st) {
      console.error('错误: 目标目录不存在或不可访问 ' + t + (why ? '（' + why + '）' : ''));
      process.exit(1);
    }
    if (!st.isDirectory()) {
      console.error('错误: 目标不是目录 ' + t + '（--dir 只接受目录；单文件请指向其所在目录，或用 --ext 过滤）');
      process.exit(1);
    }
  }

  console.log('==== Doc-Internal-Word-Remover 扫描器 ====');
  console.log('目标    : ' + targets.join('  ;  '));
  console.log('词库    : ' + groupSummary(rules).map((g) => g.name + ' ' + g.count + ' 词').join('；')
    + '（共 ' + rules.length + ' 条）');
  console.log('生效词条: ' + rules.map((r) => r.text).join('、'));
  if (o.whole) console.log('整词匹配: 是（英文 / 数字词仅整词命中，防误伤）');
  if (o.excludeCtx.length) console.log('排除上下文: 命中紧邻 ' + o.excludeCtx.join('、') + ' 时跳过');
  if (o.caseSensitive) console.log('大小写  : 敏感');
  console.log('范围    : ' + ({ firstlast: '仅首行+尾行', first: '仅首行/首段', all: '全文' }[o.scope] || o.scope));
  console.log('模式    : ' + (o.clean ? '清理（写入 ' + o.out + '）' : '仅报告（只读）'));
  if (o.moveTo) console.log('剪切目标: ' + o.moveTo + (o.moveDryRun ? '（演练：只列出，不实际移动）' : ''));
  if (o.delete) console.log('删除模式   : ' + (o.deleteDryRun ? '演练（只列出，不实际删除）' : '删除命中文档（不可恢复！）'));
  if (o.delete && (o.moveTo || o.clean)) console.log('[警告] --delete 与 --move-to/--clean 同时使用：命中文档将被删除，请谨慎确认');
  console.log('跳过系统目录: ' + (o.skipSystem ? '是' : '否'));
  if (o.exclude.length) console.log('额外排除目录: ' + o.exclude.join('、'));
  if (o.verify) console.log('清除后自检: 是（全文 + 全部部件复查输出，发现残留时退出码 2）');
  if (o.verify && !o.clean && !o.fromReport) console.log('[提示] --verify 只在生成输出（--clean / --from-report）时复检，纯报告模式请用 --scope all 全量扫描');
  if (o.docsOnly) console.log('仅文档类型  : 是（docx / xlsx / pptx / txt / md，过滤代码与配置）');
  if (o.nameWords) console.log('文件名关键字: ' + o.nameWords.join('、') + '（' + (o.nameMode === 'and' ? '全部包含' : '任一包含') + '）');
  // v4.3 格式筛选：默认主流格式，--ext 自定义，--all-ext 放开
  if (o.ext === 'all') { D.DWRDoc.setExtFilter(null); console.log('文件格式    : 全部支持格式'); }
  else if (o.ext) {
    const list = String(o.ext).split(/[,，;；\s]+/).map((x) => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    D.DWRDoc.setExtFilter(list);
    console.log('文件格式    : 自定义 ' + list.length + ' 种（' + list.join('、') + '）');
  } else { D.DWRDoc.setExtFilter(D.DWRDoc.COMMON_EXT.slice()); console.log('文件格式    : 主流格式（' + D.DWRDoc.COMMON_EXT.join('、') + '）'); }
  if (o.limit !== Infinity) console.log('文件上限: ' + o.limit);
  if (o.depth !== Infinity) console.log('递归深度: ' + o.depth);
  if (o.concurrency !== 8) console.log('并发路数: ' + o.concurrency);
  console.log('----------------------------------------');

  const results = [];
  // v4.3 中间落盘：大盘扫描动辄十几分钟，中途 OOM 或 Ctrl+C 会丢掉全部成果。
  // 每处理满 checkpointEvery 个文件就把当前 results 写一遍（原子替换），最坏只丢最后一个区间。
  const checkpointEvery = 500;
  let lastCheckpoint = 0;
  async function checkpoint() {
    if (!o.report && !o.json) return;
    const p = o.report || (o.json ? 'scan-report.json' : 'scan-report.csv');
    try {
      const body = o.json ? JSON.stringify(results, null, 2) : '\uFEFF' + toCsv(results, D.DWRUtil.csvCell);
      await fsp.writeFile(p + '.part', body, 'utf8');
      await fsp.rename(p + '.part', p);
    } catch (e) { /* 落盘失败不影响扫描 */ }
  }
  let scanned = 0, hitFiles = 0, totalHits = 0, fail = 0, movedCount = 0, moveFailCount = 0, deleteCount = 0, deleteFailCount = 0, cleanFailCount = 0, cleanClampCount = 0;
  let dirFailCount = 0, statFailCount = 0;
  let nameSkipped = 0;  // v4.7 因文件名不匹配而跳过的文件数
  let extSkipped = 0;   // v4.67 因格式不在支持清单而跳过的文件数（图片/.doc/.pdf 等）

  async function processOne(full) {
    // v4.3 零复制：直接用 Buffer 底层 ArrayBuffer。此前 slice 一份等于双倍占用，
    // 8 路并发扫网络盘时峰值内存直接翻倍，是 Z 盘 OOM 的主因之一。
    const buf = await fsp.readFile(full);
    // 网络盘一致性：readdir 有记录但 readFile 拿到 0 字节（文件在同步 / 被占用）是常态，
    // 直接跳过而不是送进 ZIP 解析刷噪音。
    if (!buf || !buf.length) { skippedEmpty++; return { hits: 0, hitChars: 0, totalChars: 0, ratio: 0, matched: [], firstHit: false, lastHit: false, touched: false, outAb: null, outBuf: null }; }
    const ab = buf.buffer;

    if (D.DWRDoc.isOfficeFile(full)) {
      if (o.clean) {
        const res = await D.DWRDoc.processOffice(ab, engine);
        const outAb = res.touched && res.blob ? await res.blob.arrayBuffer() : null;
        return { hits: res.hits, hitChars: res.hitChars || 0, totalChars: res.totalChars || 0, ratio: res.ratio || 0, matched: res.matched, firstHit: res.firstHit, lastHit: res.lastHit, touched: res.touched, outAb, outBuf: null };
      }
      const scan = await D.DWRDoc.scanOffice(ab, engine);
      return { hits: scan.hits, hitChars: scan.hitChars || 0, totalChars: scan.totalChars || 0, ratio: scan.ratio || 0, matched: scan.matched, firstHit: scan.firstHit, lastHit: scan.lastHit, touched: scan.hits > 0, outAb: null, outBuf: null };
    }

    const dec = D.DWRDoc.decodeText(buf);
    const r = D.DWRDoc.processText(dec.text, engine, dec.encoding);
    const outBuf = o.clean && r.touched ? D.DWRDoc.encodeText(r.text, dec.bom, dec.encoding) : null;
    return { hits: r.hits, hitChars: r.hitChars || 0, totalChars: r.totalChars || 0, ratio: r.ratio || 0, matched: r.matched, firstHit: r.firstHit, lastHit: r.lastHit, touched: r.touched, outAb: null, outBuf };
  }

  // 有界队列流式扫描：目录遍历与文档处理并发进行，内存占用恒定、不随文件总数增长
  const CONC = o.concurrency > 0 ? o.concurrency : 8;
  const QCAP = CONC * 32;

  // 有界异步队列：队列满时 put 阻塞，空时 take 阻塞（背压，防止整盘百万文件撑爆内存）
  // 生产者/消费者互相唤醒，避免死锁（消费者空等时会被 put 直接唤醒）。
  class BQueue {
    constructor(cap) { this.cap = cap; this.q = []; this.putters = []; this.takers = []; }
    put(v) {
      return new Promise((resolvePut) => {
        if (this.takers.length) {            // 有消费者在等，直接递交
          const t = this.takers.shift();
          t(v); resolvePut();
          while (this.putters.length && this.q.length < this.cap) {
            const p = this.putters.shift();
            this.q.push(p.v);
            p.resolvePut();
          }
          return;
        }
        if (this.q.length < this.cap) { this.q.push(v); resolvePut(); return; }
        this.putters.push({ v, resolvePut }); // 队列满，排队等待
      });
    }
    tryTake() {
      if (!this.q.length) return undefined;
      const v = this.q.shift();
      while (this.putters.length && this.q.length < this.cap) {
        const p = this.putters.shift();
        this.q.push(p.v);
        p.resolvePut();
      }
      return v;
    }
    take() {
      return new Promise((resolveTake) => {
        if (this.q.length) {
          const v = this.q.shift();
          resolveTake(v);
          // v4.2.1：一次把队列能容纳的等待者全部搬入。此前只搬一个，
          // 剩下的 putter 连同各自的 job 对象滞留在 putters 里，整盘扫描时无限堆积。
          while (this.putters.length && this.q.length < this.cap) {
            const p = this.putters.shift();
            this.q.push(p.v);
            p.resolvePut();
          }
          return;
        }
        this.takers.push(resolveTake);
      });
    }
  }

  const fileQ = new BQueue(QCAP);
  // v4.3 目录栈用普通数组：目录条目只有路径字符串（几十字节），百万级也才几十 MB，
  // 远小于文档解压峰值。多 walker 抢有界队列会互锁（Z 盘实测只扫 7 个文件就退出），
  // 故用单遍历器 + 数组栈，把协调问题彻底消除。
  const dirQ = [];
  // v4.2.1 单文件大小上限：超过就不读（默认 64MB，可用 --max-file-mb 调整）
  let matched = 0;     // 命中过滤条件、已投入处理队列的文件数
  let processed = 0;   // 已完成处理的文件数
  let limitReached = false;

  // 消费者：并发处理文档（扫描 / 清理），结果汇总到 results
  async function consumer() {
    while (true) {
      const job = await fileQ.take();
      if (job === null) break; // 毒丸：遍历者已全部结束
      const full = job.full;
      const fileRoot = job.root;
      let info;
      try {
        info = await processOne(full);
      } catch (e) {
        fail++;
        console.log('[错误] ' + full + ' => ' + (e && e.message ? e.message : e));
        continue;
      }
      // v4.69：脱敏副本必须先写成功，才允许删除源文件。原先写回包在 `catch (e2) {}` 里
      // 且排在删除之后，--clean --out <不可写目录> --delete 会删掉源文件却不留下副本，
      // 日志与退出码全正常 —— 唯一一份文档就此消失。
      let cleanErr = null;
      if (o.clean && (info.outAb || info.outBuf)) {
        const rel = path.relative(fileRoot, full);
        const destOf = clampInside(o.out, rel, full);
        if (destOf.clamped) {
          cleanClampCount++;
          console.log('[路径越界] ' + full + ' 按扫描根 ' + fileRoot + ' 会写到 --out 之外，已夹到输出目录内：' + destOf.dest);
        }
        const dest = destOf.dest;
        const buf = info.outAb ? Buffer.from(info.outAb) : info.outBuf;
        try {
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, buf);
        } catch (e2) {
          cleanErr = String((e2 && e2.message) || e2);
          cleanFailCount++;
          console.log('[写回失败] ' + full + ' → ' + dest + '：' + cleanErr);
        }
        await verifyOut(full, buf);
      }
      if (info.hits > 0) {
        hitFiles++;
        totalHits += info.hits;
        const entry = { file: full, hits: info.hits, hitChars: info.hitChars || 0, totalChars: info.totalChars || 0, ratio: info.ratio || 0, matched: info.matched, firstHit: !!info.firstHit, lastHit: !!info.lastHit };
        if (cleanErr) entry.cleanError = cleanErr;
        console.log('[命中 ' + info.hits + '][' + posLabel(!!info.firstHit, !!info.lastHit) + '] ' + full + '\n       词: ' + info.matched.join('、') + (info.totalChars ? '\n       命中占比: ' + (info.ratio * 100).toFixed(1) + '%（' + info.hitChars + ' / ' + info.totalChars + ' 字）' : ''));
        if (o.moveTo) {
          const rel = path.relative(fileRoot, full);
          const destPlan = path.join(o.moveTo, rel);
          if (o.moveDryRun) {
            entry.moveTo = destPlan;
            console.log('       ↳ 将剪切至 ' + destPlan);
          } else {
            try {
              await fsp.mkdir(path.dirname(destPlan), { recursive: true });
              const dest = await uniqueDest(destPlan);
              await moveFile(full, dest);
              entry.movedTo = dest;
              movedCount++;
              console.log('       ↳ 已剪切至 ' + dest);
            } catch (e2) {
              entry.moveError = String((e2 && e2.message) || e2);
              moveFailCount++;
              console.log('       ↳ 剪切失败: ' + entry.moveError);
            }
          }
        }
        if (o.delete) {
          if (o.deleteDryRun) {
            entry.delete = full;
            console.log('       ↳ 将删除 ' + full);
          } else if (cleanErr) {
            entry.deleteBlocked = true;
            console.log('       ↳ 因写回失败，未删除 ' + full);
          } else {
            try {
              await fsp.unlink(full);
              entry.deleted = true; deleteCount++;
              console.log('       ↳ 已删除 ' + full);
            } catch (e3) {
              entry.deleteError = String((e3 && e3.message) || e3);
              deleteFailCount++;
              console.log('       ↳ 删除失败: ' + entry.deleteError);
            }
          }
        }
        results.push(entry);
      }
      processed++;
      if (processed - lastCheckpoint >= checkpointEvery) { lastCheckpoint = processed; await checkpoint(); }
      if (processed % 100 === 0 || processed === matched) {
        process.stdout.write('\r已检查 ' + processed + ' / 发现 ' + matched + '，命中 ' + hitFiles + ' 个...');
      }
    }
  }

  // 遍历者：并发读取目录，待处理文件投入有界队列，子目录入队交他人遍历
  async function walker() {
    // v4.3：单遍历器语义。目录栈是普通数组，取空即说明真的遍历完了
    // （多遍历器抢有界队列会互锁，见 dirQ 注释）。
    while (dirQ.length && !limitReached) {
      const job = dirQ.shift();
      const dir = job.dir, depth = job.depth, root = job.root;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        // v4.69：权限不足 / 网络盘断连的子目录整棵消失过（原来只是 continue），
        // 用户看到的「命中 0」其实漏了一大片——必须报出来并计入概要。
        dirFailCount++;
        console.log('\n[目录不可读] ' + dir + '：' + String((e && e.code) || (e && e.message) || e) + '（该目录内容未检查）');
        continue;
      }
      for (const e of entries) {
        if (limitReached) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth + 1 > o.depth) continue;
          if (o.skipSystem && SYS_SKIP.has(e.name)) continue;
          if (o.exclude.length && o.exclude.some((x) => e.name.toLowerCase() === x.toLowerCase())) continue;
          if (e.name.startsWith('.')) continue;
          dirQ.push({ dir: full, depth: depth + 1, root: root });
        } else if (e.isFile()) {
          // v4.4：逐文件分片。目录一律全跟，否则看不到片内的文件
          if (!inShard(full)) continue;
          scanned++;
          // v4.67 格式跳过要计数：图片 / .doc / .pdf 被静默略过时，用户会误以为扫过但没命中。
          if (!(o.docsOnly ? isDocFile(e.name) : D.DWRDoc.isSupported(e.name))) { extSkipped++; continue; }
          // Office 所有者锁文件：~$ 开头，Word/Excel 打开文档时生成，非有效 ZIP
          if (e.name.charAt(0) === '~' && e.name.charAt(1) === '$') continue;
          // v4.2.1 超大文件预筛：整盘扫描常遇到几百 MB 的压缩包 / 安装包，
          // processOne 会 readFile 整个文件，CONC 路并发直接把 V8 堆撑爆（Z 盘实测 OOM）。
          // 这里按目录项大小先挡掉，统计为「已跳过」，不静默丢弃。
          let sz = 0;
          try { sz = fs.statSync(full).size; } catch (e2) { statFailCount++; continue; }
          if (sz > MAX_FILE_BYTES) { skippedBig++; continue; }
          // v4.7 文件名关键字前置过滤：不读文件就能判掉，省掉整块 IO
          if (!nameHit(full, o.nameWords, o.nameMode)) { nameSkipped++; continue; }
          matched++;
          await fileQ.put({ full: full, root: root });
          if (scanned >= o.limit) { limitReached = true; break; }
        }
      }
    }
  }

  const t0 = Date.now();
  for (const t of targets) dirQ.push({ dir: t, depth: 0, root: t });
  const consumers = [];
  for (let k = 0; k < CONC; k++) consumers.push(consumer());
  // v4.3：只起一个遍历器。目录遍历是 IO 密集，多起只会互相抢同一个目录栈；
  // 处理并发由 consumer 承担（那才是吃 CPU 的部分）。
  await walker();
  for (let k = 0; k < CONC; k++) await fileQ.put(null); // 每消费者一枚毒丸
  await Promise.all(consumers);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);

  if (o.nameWords) console.log('文件名未匹配: ' + nameSkipped + ' 个（未读取，直接跳过）');
  if (extSkipped) console.log('格式未匹配  : ' + extSkipped + ' 个（图片/.doc/.pdf 等不支持格式，未读取；图片内文字需人工复核或另存为文本格式）');
  console.log('\n==== 扫描完成 ====');
  if (shardN > 1) console.log('分片结果    : 第 ' + shardK + ' / ' + shardN + ' 片扫到 ' + scanned + ' 个文件' + (scanned < shardN * 50 ? '（本片偏少，可减小 n）' : ''));
  console.log('扫描文件数 : ' + scanned);
  console.log('命中文档数 : ' + hitFiles);
  console.log('命中词次数 : ' + totalHits);
  console.log('耗时       : ' + sec + ' 秒');
  // 跳过计数必须放在所有模式都能走到的地方：此前只在 --clean / --from-report 分支里输出，
  // 纯报告扫描（--dir 不带 --clean）下超大文件被静默跳过，用户看不到跳过了多少。
  if (skippedBig) console.log('超大已跳过  : ' + skippedBig + ' 个（超过 ' + Math.round(MAX_FILE_BYTES / 1048576) + 'MB，可用 --max-file-mb 调整）');
  if (skippedEmpty) console.log('空文件跳过  : ' + skippedEmpty + ' 个（网络盘读到 0 字节，多为同步中或被占用）');
  if (fail) console.log('处理失败    : ' + fail + ' 个');
  if (cleanFailCount) {
    console.log('写回失败    : ' + cleanFailCount + ' 个（输出目录不可写？源文件已保留未删除）');
    process.exitCode = 1;
  }
  if (cleanClampCount) console.log('路径越界    : ' + cleanClampCount + ' 个（副本已改写到 --out 之内）');
  if (dirFailCount) {
    console.log('目录未检查  : ' + dirFailCount + ' 个（权限不足或网络盘断连，「命中 0」不代表这些目录已扫过）');
    process.exitCode = 1;
  }
  if (statFailCount) console.log('无法读取大小: ' + statFailCount + ' 个文件（已跳过）');
  if (o.moveTo) {
    if (o.moveDryRun) console.log('剪切演练    : 计划移动 ' + results.filter((r) => r.moveTo).length + ' 个文件（未实际执行）');
    else console.log('已剪切文件  : ' + movedCount + ' 个' + (moveFailCount ? '（失败 ' + moveFailCount + ' 个）' : '') + ' → ' + o.moveTo);
  }

  if (o.delete) {
    if (o.deleteDryRun) console.log('删除演练    : 计划删除 ' + results.filter((r) => r.delete).length + ' 个文件（未实际执行）');
    else console.log('已删除文件  : ' + deleteCount + ' 个' + (deleteFailCount ? '（失败 ' + deleteFailCount + ' 个）' : ''));
  }

  const reportPath = o.report || (o.json ? 'scan-report.json' : 'scan-report.csv');
  if (o.json) {
    await fsp.writeFile(reportPath, JSON.stringify(results, null, 2));
    console.log('报告已写入 ' + reportPath);
  } else {
    // CSV 带 UTF-8 BOM + CRLF：中文 Windows 下 Excel / 记事本双击打开不乱码；
    // 单元格按 RFC 4180 转义（含逗号/引号/换行时加引号，内部引号翻倍），避免路径含逗号时串列。
    await fsp.writeFile(reportPath, '\uFEFF' + toCsv(results, D.DWRUtil.csvCell), 'utf8');
    console.log('报告已写入 ' + reportPath + '（UTF-8 带 BOM，Excel 可直接打开）');
  }

  if (o.html) {
    const htmlPath = path.resolve(o.htmlFile);
    await fsp.writeFile(htmlPath, renderHtmlReport({
      results: results, targets: targets, scope: o.scope,
      words: rules.map((r) => r.text),
      groups: groupSummary(rules),
      scanned: scanned, sec: sec, timeStr: fmtTime(new Date())
    }), 'utf8');
    console.log('HTML 索引已写入 ' + htmlPath);
  }

  verifySummary();
}

main().catch((e) => { console.error(e); process.exit(1); });
