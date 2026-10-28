/* v4.19 新增功能端到端覆盖（由 test-e2e.mjs 末尾引入）。 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080/index.html';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const done = [];
  function ok(name, cond, extra) {
    if (!cond) throw new Error(extra ? name + ' : ' + extra : name);
    done.push('PASS ' + name);
  }

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  // v4.78：低频设置默认收起，但仍用摘要说明当前方案；点「调整」后完整展开。
  {
    const folded = await page.evaluate(() => ({
      rulesOpen: document.getElementById('rulesCard').open,
      processOpen: document.getElementById('processCard').open,
      rules: document.getElementById('rulesSummaryBadge').textContent,
      process: document.getElementById('processSummaryBadge').textContent,
    }));
    ok('v478-settings-default-folded',
      folded.rulesOpen === false && folded.processOpen === false
        && /38 个词/.test(folded.rules) && /删除/.test(folded.process),
      JSON.stringify(folded));
    await page.click('#editTaskBtn');
    await page.waitForTimeout(900);
    const opened = await page.evaluate(() => {
      const card = document.getElementById('rulesCard').getBoundingClientRect();
      const header = document.querySelector('.app-header').getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        rulesOpen: document.getElementById('rulesCard').open,
        processOpen: document.getElementById('processCard').open,
        focused: document.activeElement && document.activeElement.id,
        cardTop: card.top,
        headerBottom: header.bottom,
        scrollMarginTop: getComputedStyle(document.getElementById('rulesCard')).scrollMarginTop,
        styleHref: document.querySelector('link[rel=stylesheet]')?.href || null,
        cardVisible: card.top >= header.bottom - 1,
      };
    });
    ok('v478-adjust-opens-settings',
      opened.rulesOpen && opened.processOpen && opened.focused === 'ruleInput' && opened.cardVisible,
      JSON.stringify(opened));
    await page.locator('input[name=action][value=mask]').evaluate((el) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    ok('v478-process-summary-live',
      /智能打码/.test(await page.locator('#processSummaryBadge').textContent()));
    await page.locator('input[name=action][value=delete]').evaluate((el) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate(() => {
      document.getElementById('rulesCard').open = false;
      document.getElementById('processCard').open = false;
      window.scrollTo(0, 0);
    });
  }

  // 扫描设置的折叠面板：左侧使用独立 ID，避免和扫描结果卡的「更多」冲突。
  const openScanMore = async () => {
    const diskOpen = await page.locator('#diskScanTools').evaluate((el) => el.open);
    if (!diskOpen) await page.click('#diskScanTools > summary');
    if (await page.locator('#scanSettingsBody').isHidden()) await page.click('#scanSettingsBtn');
    await page.locator('#scanSettingsBody').waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
  };
  const openProcessSettings = async () => {
    const processOpen = await page.locator('#processCard').evaluate((el) => el.open);
    if (!processOpen) await page.click('#processCard > summary');
    await page.locator('#caseSensitive').waitFor({ state: 'visible' });
  };

  // 1) 区分大小写：默认不勾（与 CLI 默认一致），勾上后可持久化
  await openProcessSettings();
  ok('cs-default-off', (await page.locator('#caseSensitive').isChecked()) === false);
  await page.locator('#caseSensitive').check();
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await openProcessSettings();
  ok('cs-persist', (await page.locator('#caseSensitive').isChecked()) === true);
  await page.locator('#caseSensitive').uncheck();

  // 1b) 大小写真的影响命中（v4.38 补）。此前只验了开关状态与持久化，
  //     没有任何一条断言跑过「勾选后命中数变化」——README 承诺
  //     「默认不敏感（Secret/SECRET/secret 都命中）」却无从验证。
  {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    // 加一条 ASCII 规则，再放一个三种大小写都有的文件
    await page.click('#rulesCard > summary');
    await page.fill('#ruleInput', 'SECRET');
    await page.click('#addRuleBtn');
    await page.waitForTimeout(400);
    await page.setInputFiles('#fileInput', [
      { name: 'cs.txt', mimeType: 'text/plain', buffer: Buffer.from('SECRET a\nsecret b\nSecret c\n') },
    ]);
    await page.waitForTimeout(500);
    const hitsNow = async () => {
      await page.click('#scanBtn');
      await page.waitForFunction(
        () => /扫描完成/.test(document.getElementById('log').textContent || ''),
        { timeout: 60000 }
      );
      const t = await page.locator('#fileBody tr td:nth-child(5)').first().textContent();
      return parseInt(t, 10) || 0;
    };
    // 默认不敏感：首行 SECRET 与尾行 Secret 都命中
    const insens = await hitsNow();
    ok('cs-default-insensitive', insens === 2, 'hits=' + insens);
    // 勾选敏感：只剩首行 SECRET
    await openProcessSettings();
    await page.locator('#caseSensitive').check();
    await page.waitForTimeout(400);
    const sens = await hitsNow();
    ok('cs-affects-hits', sens === 1 && sens < insens, 'insens=' + insens + ' sens=' + sens);
    // 取消敏感：恢复
    await openProcessSettings();
    await page.locator('#caseSensitive').uncheck();
    await page.waitForTimeout(400);
    const back = await hitsNow();
    ok('cs-restore', back === insens, 'back=' + back);
  }
  await page.waitForTimeout(300);

  // 2) 文件名关键字控件在场且可填
  await openScanMore();
  ok('namewords-input', (await page.locator('#scanNameWords').count()) === 1);
  await page.fill('#scanNameWords', 'TZ,BBI');
  ok('namemode-2-options', (await page.locator('#scanNameMode option').count()) === 2);
  await page.selectOption('#scanNameMode', 'and');
  await page.waitForTimeout(300);

  // 3) 结构化复核清单：8 项 x 3 态，勾选统计正确
  await page.evaluate(() => {
    document.getElementById('scanResultCard').style.display = 'block';
    document.getElementById('scanReviewRow').style.display = 'flex';
  });
  await page.click('#reviewListBtn');
  await page.waitForTimeout(500);
  ok('review-8-items', (await page.locator('#reviewList .rv-item').count()) === 8);
  ok('review-24-radios', (await page.locator('#reviewList input[type=radio]').count()) === 24);
  ok('review-all-labeled', (await page.locator('#reviewList input[type=radio][aria-label]').count()) === 24);
  ok('review-initial-empty', /尚未勾选/.test(await page.locator('#reviewListStat').textContent()));
  await page.locator('#reviewList input[name=rv_marked][value=ok]').evaluate((el) => el.closest('label').click());
  await page.waitForTimeout(400);
  ok('review-one-checked', /已确认 1 \/ 8 项/.test(await page.locator('#reviewListStat').textContent()));
  await page.locator('#reviewList input[name=rv_no-residue][value=bad]').evaluate((el) => el.closest('label').click());
  await page.waitForTimeout(400);
  ok('review-warn-on-bad', /其中 1 项不符合/.test(await page.locator('#reviewListStat').textContent()));
  await page.click('#reviewListReset');
  await page.waitForTimeout(300);

  // 4) 自定义替换留空必须被拦下并说明后果（v4.40 补）。
  //    此前只有一条源码字符串断言（APP.indexOf 那段文案）。
  //    这是防误删的关键交互：不拦下的话敏感词会被直接删除，
  //    而用户以为自己做了替换。
  {
    const DONE = '处理完成';
    const PENDING = '待处理';
    const LQ = String.fromCharCode(12300), RQ = String.fromCharCode(12301);
    const WARN = '选了' + LQ + '自定义' + RQ + '但没填替换文本';
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });
    await page.setInputFiles('#fileInput', [
      { name: 'c.txt', mimeType: 'text/plain', buffer: Buffer.from('SECRET a\nsecret b\nSecret c\n') },
    ]);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const r = document.querySelector('input[name=action][value=custom]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.waitForTimeout(300);
    ok('custom-empty-field', (await page.locator('#customText').inputValue()) === '');
    await page.click('#scanBtn');
    await page.waitForTimeout(800);
    await page.click('#runBtn');
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({
      log: document.getElementById('log').textContent || '',
      status: (document.querySelector('#fileBody tr td:nth-child(6)') || {}).textContent || '',
      runDisabled: document.getElementById('runBtn').disabled,
      fileCount: document.querySelectorAll('#fileBody tr').length,
    }));
    ok('custom-empty-blocked', st.log.indexOf(WARN) >= 0, st.log.slice(-160));
    ok('custom-empty-no-run', st.log.indexOf(DONE) < 0 && st.fileCount === 1, 'fc=' + st.fileCount);
    ok('custom-empty-retryable', st.runDisabled === false, 'disabled=' + st.runDisabled);
  }
  ok('review-reset', /尚未勾选/.test(await page.locator('#reviewListStat').textContent()));

  if (errs.length) throw new Error('E2E page errors: ' + errs.join(' | '));
  console.log('E2E-NEW OK: ' + done.join(' ; '));
  await browser.close();
})().catch((e) => {
  console.error('E2E-NEW FAIL:', e.message);
  process.exit(1);
});
