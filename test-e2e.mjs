// 浏览器端冒烟 + 端到端测试（手动触发 / CI 手动工作流）。
//
// 不只是「页面能打开」，而是真实跑一遍核心链路，从而能捕获仅在浏览器里才会暴露的问题
// （例如曾经出现过的 CONC 未定义导致「扫描预览」直接抛 ReferenceError）：
//   1) 页面可加载、无运行时错误
//   2) 载入默认词库
//   3) 添加 文本 + Word 两个样本文件
//   4) 点击「扫描预览」-> 断言命中统计写入界面
//   5) 点击「开始处理」-> 捕获导出的 ZIP，并校验内部文本已脱敏
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';

/** 在 Node 侧加载与浏览器端完全相同的 zip / rules / ooxml 引擎 */
function loadEngine() {
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

/** 用真实引擎构造一个 docx 样本 */
async function makeDocx() {
  const D = loadEngine();
  const blob = await D.DWRZip.pack([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:t>内部资料正文</w:t></w:p></w:body></w:document>' },
  ]);
  return Buffer.from(await blob.arrayBuffer());
}

/** 读取导出的 ZIP 中某个条目的文本 */
async function readZipEntry(buf, entryName) {
  const D = loadEngine();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const zip = await D.DWRZip.load(ab);
  return zip.getText(entryName);
}

/* 导出 ZIP 里装的是处理后的**整个文档**（sample.docx），不是解包后的 OOXML 部件，
   所以校验 Word 脱敏要先把 sample.docx 取出来当独立 ZIP 再读 word/document.xml。
   历史上这里直接读 ZIP 里的 'word/document.xml'，越过了 docx 的容器层，永远取不到。 */
async function readDocxPart(zipBuf, docxEntry, partName) {
  const D = loadEngine();
  const ab = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
  const outer = await D.DWRZip.load(ab);
  const bytes = await outer.getBytes(docxEntry);
  if (!bytes) return null;
  const inner = await D.DWRZip.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return inner.getText(partName);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-e2e-'));
const txtPath = path.join(tmp, 'sample.txt');
const docxPath = path.join(tmp, 'sample.docx');
fs.writeFileSync(txtPath, '内部资料首行\n正文内容\n机密尾行\n', 'utf8');
fs.writeFileSync(docxPath, await makeDocx());

/* 轮询辅助：不用 page.waitForFunction——Playwright 1.48 在带 CSP 的页面里
   轮询谓词走 eval，会被 script-src 挡下并抛 EvalError（v4.40 实测，
   扫描其实早已完成，只是轮询机制被挡）。改用 textContent / count 轮询。 */
const SCAN_DONE = '扫描完成';
async function waitForLog(page, needle, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await page.locator('#log').textContent();
    if (txt && txt.indexOf(needle) >= 0) return txt;
    await page.waitForTimeout(150);
  }
  throw new Error('等待日志超时: ' + needle);
}
async function waitForCount(page, sel, n, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.locator(sel).count() >= n) return;
    await page.waitForTimeout(100);
  }
  throw new Error('等待元素超时: ' + sel);
}

async function auditScrolledHeader(page, theme) {
  await page.evaluate((nextTheme) => {
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('dwr.theme', nextTheme);
    window.scrollTo(0, 420);
  }, theme);
  await page.waitForTimeout(150);

  const result = await page.evaluate(() => {
    const parse = (value) => {
      const nums = (value.match(/[\d.]+/g) || []).map(Number);
      return [nums[0] || 0, nums[1] || 0, nums[2] || 0, nums.length > 3 ? nums[3] : 1];
    };
    const blend = (fg, bg) => {
      const a = fg[3];
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
    };
    const lum = (rgb) => {
      const v = rgb.slice(0, 3).map((x) => {
        const s = x / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor);
    const head = document.querySelector('.app-header');
    const headBg = blend(parse(getComputedStyle(head).backgroundColor), bodyBg);
    const textRatio = (sel) => ratio(blend(parse(getComputedStyle(document.querySelector(sel)).color), headBg), headBg);
    const pillRatio = (sel) => {
      const el = document.querySelector(sel);
      const pillBg = blend(parse(getComputedStyle(el).backgroundColor), headBg);
      return ratio(blend(parse(getComputedStyle(el).color), pillBg), pillBg);
    };
    return {
      theme: document.documentElement.dataset.theme,
      scrolled: head.classList.contains('scrolled'),
      title: textRatio('.app-header h1'),
      subtitle: textRatio('.app-header p'),
      themeButton: pillRatio('#themeBtn'),
      badge: pillRatio('#envBadge'),
    };
  });

  const minimums = { title: 4.5, subtitle: 4.5, themeButton: 4.5, badge: 4.5 };
  for (const [name, minimum] of Object.entries(minimums)) {
    if (result[name] < minimum) {
      throw new Error(`${theme} 页头 ${name} 对比度不足: ${result[name].toFixed(2)} < ${minimum}`);
    }
  }
  if (!result.scrolled || result.theme !== theme) {
    throw new Error(`${theme} 页头滚动状态未生效: ${JSON.stringify(result)}`);
  }
  return result;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  const title = await page.title();
  if (!/Doc|文档|Word|Remover/i.test(title)) throw new Error('页面标题异常: ' + title);

  const ruleChips = await page.locator('#ruleChips .chip').evaluateAll((chips) => chips.map((chip) => ({
    text: chip.textContent.trim(),
    tip: chip.getAttribute('data-tip'),
    badgeTip: chip.querySelector('.badge')?.getAttribute('data-tip') || '',
  })));
  const groupHeads = await page.locator('#ruleChips .grp-name').allTextContents();
  if (!groupHeads.includes('密级标识（4）') || groupHeads.includes('涉密字样（2）')) {
    throw new Error('默认密级分组不正确: ' + JSON.stringify(groupHeads));
  }
  for (const word of ['内部', '秘密', '机密', '绝密']) {
    if (!ruleChips.some((item) => item.text.startsWith(word))) {
      throw new Error('默认词库缺少 ' + word + ': ' + JSON.stringify(ruleChips.map((r) => r.text)));
    }
  }
  if (ruleChips.some((item) => item.text.startsWith('涉密'))) {
    throw new Error('默认词库不应包含独立「涉密」: ' + JSON.stringify(ruleChips.map((r) => r.text)));
  }
  const commercialExclusions = ruleChips.filter((item) =>
    ['内部', '秘密', '机密', '绝密'].some((word) => item.text.startsWith(word))
      && item.text.indexOf('排除 前：商业') >= 0);
  if (commercialExclusions.length) {
    throw new Error('默认密级词不应再排除「商业」: ' + JSON.stringify(commercialExclusions));
  }
  await page.locator('#ruleChips .chip').first().scrollIntoViewIfNeeded();
  const coveredRuleText = await page.locator('#ruleChips .chip').evaluateAll((chips) => chips
    .map((chip) => {
      const label = chip.querySelector('span:not(.acts)');
      const rect = label.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + 6, rect.top + rect.height / 2);
      return { text: chip.textContent.trim(), coveredByCheckbox: top && top.classList.contains('chip-check') };
    })
    .filter((item) => item.coveredByCheckbox)
    .map((item) => item.text));
  if (coveredRuleText.length) {
    throw new Error('词条首字被勾选区遮住: ' + coveredRuleText.join('、'));
  }

  // 已保存旧词库的用户刷新后也应自动迁移，不需要手动恢复默认。
  await page.evaluate(() => {
    localStorage.setItem('dwr.settings.v2', JSON.stringify({
      rules: [
        { text: '涉密', type: 'text', enabled: true, group: '涉密字样' },
        { text: '内部', type: 'text', enabled: true, group: '涉密字样' },
        { text: '秘密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] },
        { text: '机密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] },
        { text: '绝密', type: 'text', enabled: true, group: '密级标识', notBefore: ['商业'] }
      ],
      options: {}
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  const migratedHeads = await page.locator('#ruleChips .grp-name').allTextContents();
  const migratedWords = await page.locator('#ruleChips .chip').allTextContents();
  const storedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('dwr.settings.v2')));
  const migratedTierWords = migratedWords.filter((text) =>
    ['内部', '秘密', '机密', '绝密'].some((word) => text.trim().startsWith(word)));
  if (!migratedHeads.includes('密级标识（4）')
      || migratedWords.some((text) => text.trim().startsWith('涉密'))
      || migratedTierWords.some((text) => text.indexOf('排除 前：商业') >= 0)
      || storedSettings.settingsVersion !== 3
      || storedSettings.rules.some((r) => r.group === '密级标识'
        && r.notBefore && r.notBefore.indexOf('商业') >= 0)) {
    throw new Error('旧词库刷新迁移失败: ' + JSON.stringify({ migratedHeads, migratedWords, storedSettings }));
  }

  // v4.78 设置默认收起后短页面不会有滚动区；用展开态验证固定页头仍正常。
  await page.evaluate(() => {
    document.getElementById('rulesCard').open = true;
    document.getElementById('processCard').open = true;
  });
  const lightHeader = await auditScrolledHeader(page, 'light');
  const darkHeader = await auditScrolledHeader(page, 'dark');
  await page.evaluate(() => {
    document.getElementById('rulesCard').open = false;
    document.getElementById('processCard').open = false;
    window.scrollTo(0, 0);
  });

  const fileInputCount = await page.locator('input[type=file]').count();
  if (!fileInputCount) throw new Error('未找到文件选择控件');

  // 词库引擎可初始化
  await page.click('#rulesCard > summary');
  await page.click('#loadPresetBtn');

  // 添加样本文件（文本 + Word 各一）
  await page.setInputFiles('#fileInput', [txtPath, docxPath]);
  await waitForCount(page, '#fileBody tr', 2, 15000);

  // 扫描预览：这一步在历史上会因 CONC 未定义而崩溃
  await page.click('#scanBtn');
  // 不用 waitForFunction：Playwright 1.48 在带 CSP 的页面里轮询谓词走 eval，
  // 会被 script-src 挡下（v4.40 实测：扫描其实早已完成，只是轮询被挡）。
  await waitForLog(page, SCAN_DONE, 60000);
  // 文件列表的列序是：勾选框 / 路径 / 类型 / 大小 / 命中 / 状态 / 操作 —— 命中在第 5 列。
  // 这里原先写死第 4 列，取到的是「大小」列的字节数（45 B + 192 B = 237），
  // 数值恰好为正，断言「有命中」就永远成立，等于没校验。
  const hitCells = await page.locator('#fileBody tr td:nth-child(5)').allTextContents();
  const totalHits = hitCells.reduce((a, s) => a + (parseInt(s, 10) || 0), 0);
  if (totalHits <= 0) throw new Error('扫描预览未发现命中，命中列=' + JSON.stringify(hitCells));

  // 开始处理并捕获导出的 ZIP
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#runBtn'),
  ]);
  const zipPath = path.join(tmp, 'out.zip');
  await download.saveAs(zipPath);

  const logText = await page.locator('#log').textContent();
  if (!/处理完成/.test(logText)) throw new Error('未出现处理完成日志: ' + logText.slice(-300));

  const outTxt = await readZipEntry(fs.readFileSync(zipPath), 'sample.txt');
  if (!outTxt) throw new Error('导出的 ZIP 中缺少 sample.txt');
  if (/内部|机密/.test(outTxt)) throw new Error('导出文本仍含敏感词: ' + JSON.stringify(outTxt));

 const outDoc = await readDocxPart(fs.readFileSync(zipPath), 'sample.docx', 'word/document.xml');
 if (!outDoc) throw new Error('导出的 ZIP 中缺少 sample.docx 或其内部 word/document.xml');
 if (/内部/.test(outDoc)) throw new Error('导出的 docx 仍含敏感词: ' + outDoc);

  if (errors.length) throw new Error('页面运行时错误: ' + errors.join(' | '));

  console.log('E2E OK: title=' + title + ', 命中=' + totalHits + ' 处, ZIP 已校验（文本+Word 均已脱敏）, 页头对比度 ' +
    '亮/暗=' + lightHeader.subtitle.toFixed(1) + '/' + darkHeader.subtitle.toFixed(1));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(async (e) => {
  console.error('E2E FAIL:', e.message);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
  process.exit(1);
});

// v4.19：新功能端到端覆盖（复核清单 / 文件名关键字 / 区分大小写）
// 抽成独立文件，避免主链路与新增覆盖互相阻塞（任一段失败都能各自报出）。
await import('./_e2e_new.mjs');

// v4.69：备份槽位与撤销定位，用真实 File System Access 句柄跑一遍（理由见该文件头注释）。
await import('./_e2e_fsa.mjs');
