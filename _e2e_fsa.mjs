/* v4.69 备份 / 撤销链路的真机端到端覆盖（由 test-e2e.mjs 末尾引入）。
 *
 * 为什么要在真实浏览器里跑：DOM 桩（test-app.mjs 6.12b）能证明代码逻辑，
 * 证明不了它假定的 File System Access 语义是否就是浏览器的那套——
 * 「getFileHandle 未命中时抛 NotFoundError」正是 backupOriginal 判断备份槽位
 * 的唯一依据，浏览器里若改成返回 null，整套槽位逻辑就反了。
 * 这里用 OPFS（navigator.storage.getDirectory()）拿真实句柄：读写、抛错、
 * createWritable 都是浏览器实现，只有「选目录」这一步和权限查询用壳替换掉
 * （原生选择框无法在自动化里点定）。 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';
const HIT = '内部 首行\n正文\n机密 尾行\n';
const STALE = 'STALE 上一批的旧备份\n';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  // 「一键处理」「撤销」都有二次确认框，自动化里一律放行
  page.on('dialog', (d) => d.accept());
  const bad = [];
  const ok = (name, cond, extra) => {
    if (!cond) bad.push(name + (extra ? ' : ' + extra : ''));
  };

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  const caps = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const out = { throws: false, errName: '', perm: 'n/a', writable: false };
    out.writable = typeof FileSystemFileHandle !== 'undefined'
      && typeof FileSystemFileHandle.prototype.createWritable === 'function';
    try { await root.getFileHandle('definitely-missing.txt'); }
    catch (e) { out.throws = true; out.errName = e.name; }
    if (typeof root.queryPermission === 'function') {
      out.perm = await root.queryPermission({ mode: 'readwrite' });
    }
    return out;
  });
  ok('fsa-getFileHandle-未命中抛错（桩契约与浏览器一致）', caps.throws === true, JSON.stringify(caps));
  ok('fsa-抛的是 NotFoundError', caps.errName === 'NotFoundError', caps.errName);
  ok('fsa-createWritable 可用', caps.writable === true, JSON.stringify(caps));
  ok('fsa-读写权限已授予', caps.perm === 'granted', caps.perm);

  const flow = await page.evaluate(async ({ HIT, STALE }) => {
    const enc = new TextEncoder();
    const root = await navigator.storage.getDirectory();
    // 只替换「选目录」与权限两个环节，文件句柄全部是浏览器真实实现
    const dir = {
      kind: 'directory', name: 'opfs-root',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: (n, o) => root.getFileHandle(n, o),
      getDirectoryHandle: (n, o) => root.getDirectoryHandle(n, o),
      removeEntry: (n, o) => root.removeEntry(n, o),
      entries: () => root.entries(),
    };
    const read = async (d, n) => {
      try {
        const fh = await d.getFileHandle(n);
        const f = await fh.getFile();
        return new TextDecoder().decode(await f.arrayBuffer());
      } catch (e) { return null; }
    };
    const seed = async (d, n, s) => {
      const fh = await d.getFileHandle(n, { create: true });
      const w = await fh.createWritable();
      await w.write(enc.encode(s));
      await w.close();
    };
    for (const n of ['a.txt', 'a.txt.bak', 'a.txt.bak.2', 'sub']) {
      try { await root.removeEntry(n, { recursive: true }); } catch (e) { /* 干净起点 */ }
    }
    const subDir = await root.getDirectoryHandle('sub', { create: true });
    await seed(root, 'a.txt', HIT);
    await seed(subDir, 'a.txt', HIT);
    await seed(root, 'a.txt.bak', STALE);   // 上一批遗留的陈旧备份
    window.showDirectoryPicker = async () => dir;

    const $ = (id) => document.getElementById(id);
    $('backup').checked = true;
    const logOf = () => $('log').textContent || '';
    const wait = async (re, ms) => {
      const t0 = Date.now();
      for (;;) {
        if (re.test(logOf())) return true;
        if (Date.now() - t0 > ms) return false;
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const pick = (re) => (logOf().match(re) || [''])[0];
    const res = { };
    $('scanFolderBtn').click();
    res.scanned = await wait(/文件夹扫描完成/, 30000);
    res.rows = document.querySelectorAll('#scanBody tr').length;
    $('scanCleanBtn').click();
    res.cleaned = await wait(/一键处理完成/, 60000);
    res.cleanLog = pick(/一键处理完成[^\n]*/);
    res.a = await read(root, 'a.txt');
    res.bakKept = await read(root, 'a.txt.bak');
    res.bak2 = await read(root, 'a.txt.bak.2');
    res.subBak = await read(subDir, 'a.txt.bak');
    res.subAfter = await read(subDir, 'a.txt');
    res.ledger = localStorage.getItem('dwr.undo.v1');
    const ub = $('undoBtn');
    if (ub && !ub.hidden) {
      ub.click();
      res.undoDone = await wait(/撤销完成/, 60000);
      res.undoLog = pick(/撤销完成[^\n]*/);
    } else {
      res.undoDone = false;
      res.undoLog = '(撤销按钮未出现)';
    }
    res.aAfterUndo = await read(root, 'a.txt');
    res.subAfterUndo = await read(subDir, 'a.txt');
    return res;
  }, { HIT, STALE });

  const cleared = (s) => !!s && !/内部|机密/.test(s);
  ok('fsa-扫描到根目录与子目录两个命中', flow.rows === 2, 'rows=' + flow.rows);
  ok('fsa-清理成功 2 个且无失败', /清理 2 个、未变化 0 个、失败 0 个/.test(flow.cleanLog || ''), flow.cleanLog);
  ok('fsa-原文件确已脱敏', cleared(flow.a), JSON.stringify(flow.a));
  ok('fsa-子目录文件确已脱敏', cleared(flow.subAfter), JSON.stringify(flow.subAfter));
  ok('fsa-子目录备份落在自身目录', flow.subBak === HIT, JSON.stringify(flow.subBak));
  ok('fsa-上一批的 .bak 不被覆盖', flow.bakKept === STALE, JSON.stringify(flow.bakKept));
  ok('fsa-本批备份另存 .bak.2 且是本批处理前原文', flow.bak2 === HIT, JSON.stringify(flow.bak2));
  const items = (JSON.parse(flow.ledger || '[]')[0] || {}).items || [];
  ok('fsa-撤销账记录本批实际用的备份名',
    items.length === 2 && items.every((x) => typeof x.bak === 'string' && x.bak.length > 0),
    JSON.stringify(items));
  ok('fsa-撤销完成', /撤销完成：还原 2 个/.test(flow.undoLog || ''), flow.undoLog);
  ok('fsa-撤销还原根文件到本批处理前', flow.aAfterUndo === HIT, JSON.stringify(flow.aAfterUndo));
  ok('fsa-撤销还原子目录文件到本批处理前', flow.subAfterUndo === HIT, JSON.stringify(flow.subAfterUndo));

  if (errs.length) bad.push('页面运行时错误: ' + errs.join(' | '));
  if (bad.length) throw new Error(bad.join(' ; '));
  console.log('E2E-FSA OK: 备份槽位 / 撤销定位在真实 File System Access 下逐条对上（'
    + (flow.undoLog || '') + '）');
  await browser.close();
})().catch((e) => {
  console.error('E2E-FSA FAIL:', e.message);
  process.exit(1);
});
