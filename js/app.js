/**
 * app.js —— 应用主控逻辑
 * 负责：词库管理、文件收集、扫描预览、批量处理、结果导出 / 写回
 * 通用 UI（js/ui.js）与目录记忆（js/dircache.js）为独立模块，在此只做引用
 */
(function (global) {
  'use strict';

  var Rules = global.DWRRules;
  var Report = global.DWRReport || null;
  var Doc = global.DWRDoc;
  var Zip = global.DWRZip;
  // 通用 UI 逻辑（「更多 ▾」浮层、悬停气泡）抽到 js/ui.js，与 format.js 同风格
  var DWRUi = global.DWRUi;

  // 受控并发调度（util.js 提供，缺失时退化为 Promise.all）
  var mapPool = (global.DWRUtil && global.DWRUtil.mapPool) || function (items, limit, fn) {
    return Promise.all(items.map(function (it, i) { return Promise.resolve(fn(it, i)); }));
  };

  // 并发度：优先取 UI 滑块值，缺失时回退到环境建议值
  function getConc() {
    var el = $('concurrency');
    var v = el ? (parseInt(el.value, 10) || 0) : 0;
    if (v >= 1 && v <= 32) return v;
    var sug = (global.DWRUtil && global.DWRUtil.suggestedConcurrency) ? global.DWRUtil.suggestedConcurrency() : 4;
    return sug;
  }

  

  var STORE_KEY = 'dwr.settings.v2';
  // 设置结构版本：v4.75 起四个默认密级词不再排除「商业」前缀。
  var SETTINGS_VERSION = 3;
  var MAX_FILE_BYTES = 120 * 1024 * 1024; // 单文件上限 120MB
  var MARK_START = '';
  var MARK_END = '';
  // 报告按钮高亮引导的定时器句柄
  var reportFlashTimer = null;
  // 预览区最多显示的行数（超出要提示，避免把不完整预览当成全文）
  var PREVIEW_MAX = 300;

  // 作用范围的中文标签（与 index.html 单选值一一对应，避免各处置灰不一致）
  var SCOPE_LABEL = { firstlast: '仅首行+尾行', first: '仅首行/首段', all: '全文' };
  function scopeLabel(v) { return SCOPE_LABEL[v] || '全文'; }
var ACTION_LABEL = { delete: '删除', mask: '智能打码', custom: '自定义替换' };
var OUTMODE_LABEL = { zip: '导出 ZIP', newfolder: '写入新目录', inplace: '原地覆盖' };
function actionLabel(v) { return ACTION_LABEL[v] || '删除'; }
function outmodeLabel(v) { return OUTMODE_LABEL[v] || v || ''; }

  function $(id) { return document.getElementById(id); }
  function checkedVal(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }
  /* v2.87: escapeHtml / fmtSize / stamp 抽到 js/format.js (window.DWRFormat), */
  /* DOM 无关的纯函数集中维护; 作用域内保留同名引用, 调用点零改动。 */
  var escapeHtml = DWRFormat.escapeHtml;
  var fmtSize = DWRFormat.fmtSize;
  var stamp = DWRFormat.stamp;

  var state = {
    files: [],
    rules: [],
    outDirHandle: null,
    selectedId: null,
    running: false,
    runCancel: false, // 用户点了「停止处理」：mapPool 不再启动新任务
    seq: 0,
    scanResults: [],
    // 扫描报告数据源：与 scanResults 同步增删，但「加入处理列表」只移表格不移报告
    scanArchive: [],
    // 已通过「加入处理列表」入队的扫描结果条数（用于空态提示）
    scanAddedCount: 0,
    scanLastCheckedIdx: -1,
    // 当前在预览面板中展示的扫描结果行索引（-1 表示预览来源是文件列表）
    scanPreviewIdx: -1,
    // 扫描结果表过滤：路径 / 命中词关键字 + 状态筛选 + 排序（结果上千行时靠它快速定位）
    scanFilterQ: '',
    scanFilterStatus: 'all',
    scanSort: 'default',
    // 导入检查报告后：是否在表格中隐藏「复检误报」行（复检 0 命中）
    scanHideFp: false,
    // 报告导入 / 重新甄别进行中（用于禁用重复导入、接住「停止」按钮）
    importing: false,
    importCancel: false,
    scanning: false,
    scanCancel: false,
    editingRule: -1,
    filterQ: '',
    filterStatus: 'all',
    // 多选：id -> true。与过滤条件解耦，过滤只影响「显示」不影响「已选」
    checked: {},
    // Shift 范围选择的锚点：当前可见列表中的索引
    lastCheckedIdx: -1,
    // 词库多选：选中的规则对象引用（按引用判定，词库被替换 / 编辑后自动失效）
    ruleSel: [],
    // 最近一次处理运行的元信息（供导出清除报告）
    lastRun: null,
    // 最近一次文件夹扫描的汇总信息（供导出扫描报告）
    lastScan: null
  };

  /* v4.0 人工复核轨：机器判定之外留一个给人签字的地方。
     采用自动检查与人工复核双轨设计。 */
  var reviewNote = '';
  /* v4.1 扫描阶段的复核意见：与处理阶段分开——扫描结论是「哪些文件有问题」，
     处理结论是「已清理可外发」，两者不是一回事，不能共用一个输入框。 */
  var scanReviewNote = '';


  // 清除报告构造（util.js 提供，与命令行共用同一套 CSV 转义规则）
  var buildCleanReportCsv = (global.DWRUtil && global.DWRUtil.buildCleanReportCsv)
    || function (summary, rows) { return (summary || []).join('\n') + '\n' + (rows || []).length; };
  var buildCleanReportJson = (global.DWRUtil && global.DWRUtil.buildCleanReportJson)
    || function (summary, rows) { return JSON.stringify({ meta: summary, files: rows }); };
  // 扫描报告构造（与清除报告共用同一套 BOM / CRLF / 转义规则，列定义不同）
  var buildScanReportCsv = (global.DWRUtil && global.DWRUtil.buildScanReportCsv) || buildCleanReportCsv;
  var buildScanReportJson = (global.DWRUtil && global.DWRUtil.buildScanReportJson) || buildCleanReportJson;
  /* ---------------- 日志 ---------------- */
  function log(msg, cls) {
    var el = $('log');
    if (cls === 'err') {
      var logCard = $('logCard');
      if (logCard && 'open' in logCard) logCard.open = true;
    }
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = '[' + stamp() + '] ' + msg;
    // 只在用户本来就停在底部时才跟随滚动：此前无条件 scrollTop = scrollHeight，
    // 用户往上翻看某条日志时，新日志一到就被拽回底部，想看的内容永远抓不住。
    var atBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
    el.appendChild(line);
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /* ---------------- v3.5 场景预设 ---------------- */

  /** 内置场景：一次设好范围 / 命中后 / 输出 / 备份 / 自检 */
  var PRESETS = {
    internal: {
      name: '内部资料 · 只清首尾行',
      options: { scope: 'firstlast', action: 'delete', outmode: 'zip', tidySpace: true,
        onlyChanged: true, backup: true, verifyAfter: true },
      desc: '只动首行和尾行的密级标识，误伤风险最低；结果打包成 ZIP 下载。'
    },
    secret: {
      name: '彻底清理 · 全文清除',
      options: { scope: 'all', action: 'delete', outmode: 'inplace', tidySpace: true,
        onlyChanged: true, backup: true, verifyAfter: true },
      desc: '清除全文所有命中并写回原文件（先备份 .bak），适合彻底清理后外发。'
    },
    preview: {
      name: '先预览 · 只打码不删除',
      options: { scope: 'firstlast', action: 'mask', outmode: 'zip', tidySpace: false,
        onlyChanged: true, backup: true, verifyAfter: false },
      desc: '命中处替换成 ***，先看清有哪些位置再决定怎么处理。'
    },
    handover: {
      name: '交付外发 · 写入新目录',
      options: { scope: 'firstlast', action: 'delete', outmode: 'newfolder', tidySpace: true,
        onlyChanged: true, backup: true, verifyAfter: true },
      desc: '结果写到你选的新目录并保留原目录结构，原文件不动，便于核对后交付。'
    },
    pii: {
      name: '个人信息 · 智能打码',
      options: { scope: 'all', action: 'mask', outmode: 'zip', tidySpace: false,
        onlyChanged: true, backup: true, verifyAfter: true },
      desc: '全文查找手机号 / 身份证号 / 银行卡号 / 邮箱 / IP 并保留头尾打码，结果打包 ZIP。'
    }
  };

  /** 应用一个场景预设；返回是否命中 */
  function applyPreset(key) {
    var p = PRESETS[key];
    if (!p) return false;
    var o = p.options;
    setRadio('scope', o.scope);
    setRadio('action', o.action);
    setRadio('outmode', o.outmode);
    $('tidySpace').checked = !!o.tidySpace;
    $('onlyChanged').checked = !!o.onlyChanged;
    $('backup').checked = !!o.backup;
    if ($('verifyAfter')) $('verifyAfter').checked = !!o.verifyAfter;
    saveSettings();
    setOutDirInfo();
    syncCustomWrap();
    refreshPreview();
    if (key === 'pii') {
      var missing = Rules.PII_PRESETS.filter(function (p2) {
        return !state.rules.some(function (r) { return r.type === 'regex' && r.text === p2.text; });
      });
      if (missing.length) {
        missing.forEach(function (p2) {
          state.rules.push({ text: p2.text, type: 'regex', enabled: true, label: p2.label });
        });
        renderRules();
        saveSettings();
        log('已自动加入个人信息模板 ' + missing.length + ' 条识别规则。', 'ok');
      }
    }
    log('已应用场景「' + p.name + '」：' + p.desc, 'ok');
    return true;
  }

  /* ---------------- 设置持久化 ---------------- */

  /** v4.75 一次性迁移旧默认词库：
   *  - 删除旧版内置的独立「涉密」规则；
   *  - 把旧版「内部」从「涉密字样」移到「密级标识」；
   *  - 删除默认密级词上的「商业」排除前缀；
   *  - 只改默认形态，其他自定义规则原样保留。 */
  function migrateStoredRules(rules) {
    var changed = false;
    var out = [];
    rules.forEach(function (r) {
      if (!r || typeof r !== 'object') { out.push(r); return; }
      var type = r.type || 'text';
      if (r.text === '涉密' && type === 'text' && r.group === '涉密字样') {
        changed = true;
        return;
      }
      if (r.text === '内部' && type === 'text' && r.group === '涉密字样') {
        r.group = '密级标识';
        changed = true;
      }
      if (type === 'text' && r.group === '密级标识'
          && (r.text === '秘密' || r.text === '机密' || r.text === '绝密')) {
        var notBefore = ctxList(r.notBefore);
        if (notBefore.indexOf('商业') >= 0) {
          notBefore = notBefore.filter(function (word) { return word !== '商业'; });
          if (notBefore.length) r.notBefore = notBefore;
          else delete r.notBefore;
          changed = true;
        }
      }
      out.push(r);
    });
    return { rules: out, changed: changed };
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var s = JSON.parse(raw);
      var needsUpgrade = s.settingsVersion !== SETTINGS_VERSION;
      var migrated = false;
      if (Array.isArray(s.rules)) {
        if (needsUpgrade) {
          var result = migrateStoredRules(s.rules);
          s.rules = result.rules;
          migrated = result.changed;
        }
        state.rules = s.rules;
      }
      if (s.options) {
        var o = s.options;

        if (o.scope) setRadio('scope', o.scope);
        if (o.action) setRadio('action', o.action);
        if (typeof o.customText === 'string') $('customText').value = o.customText;
        if (typeof o.tidySpace === 'boolean') $('tidySpace').checked = o.tidySpace;
        if (o.outmode) setRadio('outmode', o.outmode);
        if (typeof o.onlyChanged === 'boolean') $('onlyChanged').checked = o.onlyChanged;
        if (typeof o.backup === 'boolean') $('backup').checked = o.backup;
        if (typeof o.deleteBak === 'boolean' && $('deleteBak')) $('deleteBak').checked = o.deleteBak;
        if (typeof o.verifyAfter === 'boolean' && $('verifyAfter')) $('verifyAfter').checked = o.verifyAfter;

        // 并发度与文件夹扫描参数（缺失时保持 HTML 默认值，向后兼容旧设置）
        if (o.concurrency != null && $('concurrency')) $('concurrency').value = o.concurrency;
        if (o.scanMaxFiles != null && $('scanMaxFiles')) $('scanMaxFiles').value = o.scanMaxFiles;
        if (o.scanMaxDepth != null && $('scanMaxDepth')) $('scanMaxDepth').value = o.scanMaxDepth;
        if (typeof o.scanSkipSys === 'boolean' && $('scanSkipSys')) $('scanSkipSys').checked = o.scanSkipSys;
        if (typeof o.caseSensitive === 'boolean' && $('caseSensitive')) $('caseSensitive').checked = o.caseSensitive;
        // v4.3 格式筛选（缺失时保持 HTML 默认值 'common'）
        if (o.extPreset && $('scanExtPreset')) $('scanExtPreset').value = o.extPreset;
        if (typeof o.extCustom === 'string' && $('scanExtCustom')) $('scanExtCustom').value = o.extCustom;
        // v4.10 文件名关键字
        if (typeof o.nameWords === 'string' && $('scanNameWords')) $('scanNameWords').value = o.nameWords;
        if (o.nameMode && $('scanNameMode')) $('scanNameMode').value = o.nameMode;
      }
      if (needsUpgrade && Array.isArray(s.rules)) {
        saveSettings();
        if (migrated) log('已更新默认词库：不再默认保留「商业秘密」等商业写法。', 'info');
      }
      return true;
    } catch (e) { return false; }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        settingsVersion: SETTINGS_VERSION,
        rules: state.rules,
        options: {

          scope: checkedVal('scope'),
          action: checkedVal('action'),
          customText: $('customText').value,
          tidySpace: $('tidySpace').checked,
          outmode: checkedVal('outmode'),
          onlyChanged: $('onlyChanged').checked,
          backup: $('backup').checked,
          deleteBak: $('deleteBak') ? $('deleteBak').checked : false,
          verifyAfter: $('verifyAfter') ? $('verifyAfter').checked : true,

          concurrency: $('concurrency') ? $('concurrency').value : null,
          scanMaxFiles: $('scanMaxFiles') ? $('scanMaxFiles').value : null,
          scanMaxDepth: $('scanMaxDepth') ? $('scanMaxDepth').value : null,
          scanSkipSys: $('scanSkipSys') ? $('scanSkipSys').checked : true,
          caseSensitive: $('caseSensitive') ? $('caseSensitive').checked : false,
          extPreset: $('scanExtPreset') ? $('scanExtPreset').value : 'common',
          extCustom: $('scanExtCustom') ? $('scanExtCustom').value : '',
          nameWords: $('scanNameWords') ? $('scanNameWords').value : '',
          nameMode: ($('scanNameMode') && $('scanNameMode').value === 'and') ? 'and' : 'or'
        }
      }));
    } catch (e) { /* ignore */ }
  }

  function setRadio(name, val) {
    var el = document.querySelector('input[name="' + name + '"][value="' + val + '"]');
    if (el) el.checked = true;
  }

  /* ---------------- 词库 ---------------- */

  /** 排除上下文字段归一化：兼容字符串（逗号分隔）与数组两种写法 */
  function ctxList(v) {
    if (!v) return [];
    var arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map(function (s) { return String(s).trim(); }).filter(Boolean);
  }

  function readCtxInput(id) {
    var el = $(id);
    return el ? ctxList(el.value) : [];
  }

  function renderRules() {
    var box = $('ruleChips');
    // 清理已失效的选择引用（规则被删除 / 编辑替换 / 整体替换词库后）
    if (state.ruleSel.length) {
      state.ruleSel = state.ruleSel.filter(function (r) { return state.rules.indexOf(r) >= 0; });
    }
    box.innerHTML = '';
    if (!state.rules.length) {
      var tip = document.createElement('span');
      tip.style.cssText = 'color:var(--faint);font-size:12px;';
      tip.textContent = '暂无词库，点击下方「载入默认词库」或手动添加';
      box.appendChild(tip);
      updateRuleSelBar();
      syncTaskUi();
      return;
    }

    /* v4.0 词库分组：按 group 字段聚合渲染，组头可整组停用 / 启用。
       无 group 的规则归入「未分组」，保持既有行为。 */
    var groups = [];
    var byName = {};
    state.rules.forEach(function (r) {
      var g = r.group || '未分组';
      if (!byName[g]) { byName[g] = { name: g, items: [] }; groups.push(byName[g]); }
      byName[g].items.push(r);
    });
    groups.forEach(function (gp) { renderRuleGroup(box, gp); });
    updateRuleSelBar();
    syncTaskUi();
  }

  /** 渲染一个词组：组头（名称 + 计数 + 整组开关）+ 组内 chip */
  function renderRuleGroup(box, gp) {
    if (gp.name !== '未分组' || groups0(gp)) {
      var head = document.createElement('div');
      head.className = 'grp-head';
      var allOff = gp.items.every(function (r) { return r.enabled === false; });
      var nm = document.createElement('span');
      nm.className = 'grp-name';
      nm.textContent = gp.name + '（' + gp.items.length + '）';
      head.appendChild(nm);
      var sw = document.createElement('span');
      sw.className = 'grp-sw' + (allOff ? ' off' : '');
      sw.textContent = allOff ? '已停用' : '生效中';
      sw.setAttribute('data-tip', allOff ? '点一下启用本组全部词条' : '点一下停用本组全部词条');
      sw.addEventListener('click', function () {
        gp.items.forEach(function (r) { r.enabled = allOff; });
        renderRules(); saveSettings();
        log('已' + (allOff ? '启用' : '停用') + '词组「' + gp.name + '」的 ' + gp.items.length + ' 个词条。', 'info');
      });
      head.appendChild(sw);
      box.appendChild(head);
    }
    gp.items.forEach(function (r) { box.appendChild(buildRuleChip(r)); });
  }

  /** 是否除「未分组」外还存在其他组（只有一组时不必显示组头） */
  function groups0(gp) { return gp.name !== '未分组'; }

  /** 构建单个词条 chip（原 renderRules 内联主体，抽出来供分组复用） */
  function buildRuleChip(r) {
    var idx = state.rules.indexOf(r);
      var chip = document.createElement('span');
      chip.className = 'chip' + (r.enabled ? '' : ' off') + (r.type === 'regex' ? ' is-regex' : '') +
        (idx === state.editingRule ? ' editing' : '') + (ruleSelected(r) ? ' sel' : '');
      var cbx = document.createElement('input');
      cbx.type = 'checkbox';
      cbx.className = 'chip-check';
      cbx.checked = ruleSelected(r);
      cbx.setAttribute('data-tip', '选择该词条（可多选后批量删除）');
      cbx.setAttribute('aria-label', '选择 ' + r.text);
      cbx.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        toggleRuleSel(r);
        renderRules();
      });
      var label = document.createElement('span');
      // PII 模板等带 label 的规则显示中文名；普通词显示原文本
      label.textContent = r.label && r.type === 'regex' ? r.label + '（' + r.text + '）' : r.text;
      var nb = ctxList(r.notBefore);
      var na = ctxList(r.notAfter);
      var tips = [];
      if (r.whole) tips.push('整词匹配：英文/数字词仅整词命中');
      if (nb.length) tips.push('排除前缀：' + nb.join('、'));
      if (na.length) tips.push('排除后缀：' + na.join('、'));
      // 基础说明放最前：类型 / 启用状态，再叠加排除上下文等细节。
      // 此前只有排除上下文才设 title，禁用态（灰色 + 删除线）的词条悬停没有任何解释，
      // 用户会以为它失效或出错了，不知道是被主动停用。
      var base = (r.type === 'regex' ? '正则' : '普通词')
        + (r.enabled === false ? '，已停用（点一下重新启用）' : '，生效中（点一下停用）');
      chip.setAttribute('data-tip', tips.length ? base + '；' + tips.join('；') : base);
      var marks = [];
      if (r.whole) marks.push({ t: '整', tip: '整词匹配：英文 / 数字词仅整词命中' });
      if (nb.length || na.length) {
        var exclParts = [];
        var exclTips = [];
        if (nb.length) {
          exclParts.push('前：' + nb.join('、'));
          exclTips.push('前面紧挨「' + nb.join('」「') + '」时不处理');
        }
        if (na.length) {
          exclParts.push('后：' + na.join('、'));
          exclTips.push('后面紧挨「' + na.join('」「') + '」时不处理');
        }
        marks.push({
          t: '排除 ' + exclParts.join(' / '),
          tip: '仅排除紧邻词：' + exclTips.join('；') + '。例如「'
            + (nb.length ? nb[0] + r.text : r.text + na[0]) + '」会保留。'
        });
      }
      marks.forEach(function (m) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = m.t;
        badge.setAttribute('data-tip', m.tip);
        label.appendChild(badge);
      });
      var acts = document.createElement('span');
      acts.className = 'acts';
      var edit = document.createElement('span');
      edit.className = 'x edit';
      edit.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M11.3 2.3l2.4 2.4-7.4 7.4-3 .6.6-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
        edit.setAttribute('data-tip', '编辑该规则');
      acts.appendChild(edit);
      var x = document.createElement('span');
      x.className = 'x';
      x.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        x.setAttribute('data-tip', '删除');
      acts.appendChild(x);
      chip.appendChild(cbx);
      chip.appendChild(label);
      chip.appendChild(acts);
      chip.addEventListener('click', function (e) {
        if (e.target === x) {
          state.rules.splice(idx, 1);
          if (state.editingRule === idx) exitEditRule();
        } else if (e.target === edit) {
          startEditRule(idx);
          return;
        } else {
          r.enabled = !r.enabled;
        }
        renderRules();
        saveSettings();
      });
      return chip;
    }

  /* ---------------- 词库多选 / 批量删除 ---------------- */

  function ruleSelected(r) { return state.ruleSel.indexOf(r) >= 0; }

  function toggleRuleSel(r) {
    var i = state.ruleSel.indexOf(r);
    if (i >= 0) state.ruleSel.splice(i, 1);
    else state.ruleSel.push(r);
  }

  /** 选择条与按钮可用性同步（无选中时整条隐藏，与文件列表行为一致） */
  function updateRuleSelBar() {
    var n = state.ruleSel.length;
    var bar = $('ruleSelBar');
    if (bar) bar.style.display = n ? 'flex' : 'none';
    var c = $('ruleSelCount');
    if (c) c.textContent = '已选 ' + n + ' 个词条';
    var all = $('ruleSelAllBtn');
    if (all) all.disabled = !state.rules.length;
    var none = $('ruleSelNoneBtn');
    if (none) none.disabled = !n;
    var del = $('ruleDelSelBtn');
    if (del) del.disabled = n === 0;
  }

  /** 批量删除选中的敏感词：按引用过滤；编辑中的规则一并退出编辑态 */
  function removeSelectedRules() {
    var sel = state.ruleSel.slice();
    if (!sel.length) return;
    state.rules = state.rules.filter(function (r) { return sel.indexOf(r) < 0; });
    state.ruleSel = [];
    if (state.editingRule >= 0) exitEditRule();
    renderRules();
    saveSettings();
    log('已删除 ' + sel.length + ' 个选中的敏感词。', 'info');
  }

  function addRule(text, type) {
    text = (text || '').trim();
    if (!text) return;
    type = type || 'text';
    // 输入形如 /…/ 时按正则处理：界面上就是这么提示的（「或 /正则/」），
    // 此前即便写了斜杠、只要下拉停在「普通词」就会被当普通词存，搜索时完全匹配不上。
    if (type === 'text' && text.length > 1 && text.charAt(0) === '/' && text.charAt(text.length - 1) === '/') {
      type = 'regex';
    }
    if (type === 'regex') {
      if (text.charAt(0) === '/' && text.charAt(text.length - 1) === '/') text = text.slice(1, -1);
      try { new RegExp(text); } catch (e) {
        log('正则表达式无效：' + text, 'err');
        return;
      }
      pushRule(text, type);
      // 与普通词分支保持一致：清表单、出日志、持久化、刷新 chips。
      // 此前这里直接 return，导致加完正则词输入框不清、没有「已添加」日志、
      // 词库不写 localStorage（刷新后丢失）。
      resetRuleForm();
      renderRules();
      saveSettings();
      log('已添加 1 条正则，当前共 ' + state.rules.length + ' 条', 'ok');
      return;
    }
    // 批量粘贴：换行 / 逗号 / 分号 / 顿号 / 制表符分隔一次加入多条，自动去重
    var parts = text.split(/[\r\n,;，、\t]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    var added = 0, dup = 0;
    parts.forEach(function (w) {
      if (state.rules.some(function (r) { return r.text === w && (r.type || 'text') === type; })) { dup++; return; }
      pushRule(w, type);
      added++;
    });
    log('已添加 ' + added + ' 条敏感词' + (dup ? '（跳过重复 ' + dup + ' 条）' : '') +
      (state.rules.length ? '，当前共 ' + state.rules.length + ' 条' : ''), 'ok');
    resetRuleForm();
    renderRules();
    saveSettings();
  }

  /** 把当前表单中的选项（整词 / 排除上下文）装配到一条规则上 */
  function ruleOptionsFromForm() {
    var rule = {};
    if ($('ruleWhole') && $('ruleWhole').checked) rule.whole = true;
    var nb = readCtxInput('ruleExcludeBefore');
    if (nb.length) rule.notBefore = nb;
    var na = readCtxInput('ruleExcludeAfter');
    if (na.length) rule.notAfter = na;
    return rule;
  }

  function pushRule(text, type) {
    var rule = ruleOptionsFromForm();
    rule.text = text;
    rule.type = type;
    rule.enabled = true;
    state.rules.push(rule);
  }

  function resetRuleForm() {
    if ($('ruleInput')) $('ruleInput').value = '';
    if ($('ruleType')) $('ruleType').value = 'text';
    if ($('ruleWhole')) $('ruleWhole').checked = false;
    if ($('ruleExcludeBefore')) $('ruleExcludeBefore').value = '';
    if ($('ruleExcludeAfter')) $('ruleExcludeAfter').value = '';
  }

  /** 进入规则编辑态：把该规则回填到表单，保存时原地更新而非新增 */
  function startEditRule(idx) {
    var r = state.rules[idx];
    if (!r) return;
    state.editingRule = idx;
    resetRuleForm();
    $('ruleInput').value = r.text;
    $('ruleType').value = r.type || 'text';
    if (r.whole && $('ruleWhole')) $('ruleWhole').checked = true;
    if ($('ruleExcludeBefore')) $('ruleExcludeBefore').value = ctxList(r.notBefore).join(',');
    if ($('ruleExcludeAfter')) $('ruleExcludeAfter').value = ctxList(r.notAfter).join(',');
    if ($('addRuleBtn')) $('addRuleBtn').textContent = '保存修改';
    log('正在编辑「' + r.text + '」：点「保存修改」保存，Esc 取消。', 'info');
    renderRules();
    if ($('ruleInput') && $('ruleInput').focus) $('ruleInput').focus();
  }

  function exitEditRule() {
    if (state.editingRule < 0) return;
    state.editingRule = -1;
    resetRuleForm();
    if ($('addRuleBtn')) $('addRuleBtn').textContent = '添加';
    renderRules();
  }

  function commitEditRule() {
    var idx = state.editingRule;
    if (idx < 0 || !state.rules[idx]) { exitEditRule(); return; }
    var text = ($('ruleInput').value || '').trim();
    if (!text) { log('规则内容不能为空', 'warn'); return; }
    var updated = ruleOptionsFromForm();
    if (state.rules[idx].label) updated.label = state.rules[idx].label;
    updated.text = text;
    updated.type = $('ruleType').value || 'text';
    updated.enabled = state.rules[idx].enabled !== false;
    if (updated.type === 'regex' && text.charAt(0) === '/' && text.charAt(text.length - 1) === '/') {
      updated.text = text.slice(1, -1);
    }
    state.rules[idx] = updated;
    log('已更新规则「' + updated.text + '」', 'ok');
    state.editingRule = -1;
    resetRuleForm();
    if ($('addRuleBtn')) $('addRuleBtn').textContent = '添加';
    renderRules();
    saveSettings();
  }

  function loadPreset() {
    state.rules = Rules.DEFAULT_PRESETS.map(function (p) {
      var r = { text: p.word, type: 'text', enabled: true, group: p.group };
      if (p.notBefore) r.notBefore = p.notBefore.slice();
      if (p.notAfter) r.notAfter = p.notAfter.slice();
      if (p.whole) r.whole = true;
      return r;
    });
    renderRules();
    saveSettings();
    log('已载入默认敏感词库（' + state.rules.length + ' 条）', 'info');
  }

  /** 个人信息模板：一键加入手机号 / 身份证号 / 银行卡号 / 邮箱 / IP 识别规则。
   *  已存在同文本规则时跳过；label 存进规则对象，报告里显示「手机号」而非正则串。 */
  function loadPiiPresets() {
    var added = 0, dup = 0;
    Rules.PII_PRESETS.forEach(function (p) {
      if (state.rules.some(function (r) { return r.type === 'regex' && r.text === p.text; })) { dup++; return; }
      state.rules.push({ text: p.text, type: 'regex', enabled: true, label: p.label });
      added++;
    });
    renderRules();
    saveSettings();
    log(added
      ? '已加入个人信息模板 ' + added + ' 条（手机号 / 身份证号 / 银行卡号 / 邮箱 / IP 地址）'
      : '个人信息模板已全部在词库中', added ? 'ok' : 'info');
  }

  /* ---------------- 文件收集 ---------------- */

  function fileKind(name) {
    // 不支持的扩展名（.doc / .pdf 等）不要落进引擎 kindOf 的 'txt' 兜底——
    // 那会让表格把这些文件标成「文本」，看起来像能处理。这里单独归为 'other'。
    if (!Doc.isSupported(name)) return 'other';
    return Doc.kindOf ? Doc.kindOf(name) : (Doc.extOf(name) === 'docx' ? 'doc' : Doc.extOf(name) === 'xlsx' ? 'xls' : Doc.extOf(name) === 'pptx' ? 'ppt' : 'txt');
  }
  function kindLabel(k) { return { doc: 'Word', xls: 'Excel', ppt: 'PPT', txt: '文本', other: '不支持' }[k] || '文件'; }

  function addFiles(list) {
    var added = 0;
    Array.prototype.forEach.call(list, function (f) {
      var path = f._relPath || f.webkitRelativePath || f.name;
      var key = path + '|' + f.size;
      if (state.files.some(function (x) { return x.key === key; })) return;
      var supported = Doc.isSupported(path);
      state.files.push({
        id: ++state.seq,
        key: key,
        file: f,
        path: path,
        name: f.name,
        size: f.size,
        kind: fileKind(path),
        supported: supported,
        status: 'pending',
        hits: 0,
        matched: [],
        error: ''
      });
      added++;
    });
    renderTable();
    updateSummary();
    if (added) log('已添加 ' + added + ' 个文件（支持 ' +
      state.files.filter(function (x) { return x.supported; }).length + ' / 共 ' + state.files.length + '）', 'info');
    return added;
  }

  /** 按过滤条件（路径关键字 + 状态）筛选当前显示的文件 */
  function visibleFiles() {
    var q = state.filterQ;
    var st = state.filterStatus;
    return state.files.filter(function (it) {
      if (q && it.path.toLowerCase().indexOf(q) === -1) return false;
      if (st === 'all') return true;
      if (st === 'error') return it.status === 'error' || !it.supported;
      return it.status === st;
    });
  }

  /** 从列表移除单个文件 */
  function removeFile(id) {
    var it = state.files.filter(function (x) { return x.id === id; })[0];
    state.files = state.files.filter(function (x) { return x.id !== id; });
    delete state.checked[id];
    if (state.selectedId === id) {
      state.selectedId = null;
      $('previewOrig').textContent = '在文件列表点一行，这里显示原文与命中位置。';
      $('previewNew').textContent = '';
      var box = $('previewHits');
      if (box) box.innerHTML = '';
      var btn = $('copyResultBtn');
      if (btn) btn.disabled = true;
      setPreviewNote('');
    }
    renderTable();
    updateSummary();
    if (it) log('已移除：' + it.path, 'info');
  }

  /**
   * 表格重建节流器：命中与处理结果是逐条到达的，每条都整表重建会让代价变成
   * 1+2+…+N（文件越多扫得越慢，几千命中时主线程被重绘吃掉）。合并到每
   * RENDER_THROTTLE_MS 一次，flush() 保证批处理结束时最后的状态一定落表。
   */
  var RENDER_THROTTLE_MS = 200;

  function createRenderThrottle(render) {
    var at = 0, timer = null;
    function run() { timer = null; at = Date.now(); render(); }
    return {
      schedule: function () {
        if (timer) return;
        var wait = RENDER_THROTTLE_MS - (Date.now() - at);
        if (wait <= 0) { run(); return; }
        timer = setTimeout(run, wait);
      },
      flush: function () {
        if (timer) { clearTimeout(timer); timer = null; }
        at = Date.now();
        render();
      },
    };
  }
  var tableRender = createRenderThrottle(renderTable);
  var scanTableRender = createRenderThrottle(renderScanResults);

  /** 顶部三步条：按列表状态只高亮下一步，减少用户在一排按钮里找入口。 */
  function updateFlow() {
    var steps = [$('flowAdd'), $('flowScan'), $('flowRun')];
    if (!steps[0]) return;
    var scanned = state.files.some(function (f) {
      return f.supported && f.status !== 'pending';
    });
    var current = !state.files.length ? 1 : (scanned ? 3 : 2);
    steps.forEach(function (step, idx) {
      if (!step) return;
      var n = idx + 1;
      step.classList.toggle('is-current', n === current);
      step.classList.toggle('is-done', n < current);
      if (n === current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  /** 当前任务阶段：空列表 / 已添加待检查 / 已检查 / 已处理完成。 */
  function taskStage() {
    var supported = state.files.filter(function (f) { return f.supported; });
    if (!state.files.length) return 'empty';
    var pending = supported.some(function (f) { return f.status === 'pending'; });
    if (state.lastRun && supported.length && !pending) return 'done';
    if (supported.some(function (f) { return f.status === 'done'; })) return 'done';
    if (supported.some(function (f) { return f.status !== 'pending'; })) return 'scanned';
    return 'loaded';
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  /** 左侧折叠设置栏的一行摘要：收起后仍能看懂当前方案。 */
  function updateSettingsSummaries() {
    var enabled = (state.rules || []).filter(function (r) { return r.enabled !== false; }).length;
    var disabled = (state.rules || []).length - enabled;
    setText('rulesSummaryBadge', enabled
      ? enabled + ' 个词 · ' + (disabled ? disabled + ' 个停用' : '生效中')
      : '未启用词条');

    var scope = checkedVal('scope') || 'firstlast';
    var action = checkedVal('action') || 'delete';
    var scopeText = { firstlast: '首行 + 尾行', first: '仅首行', all: '全文' }[scope] || '首行 + 尾行';
    var actionText = { delete: '删除', mask: '智能打码', custom: '自定义替换' }[action] || '删除';
    setText('processSummaryBadge', scopeText + ' · ' + actionText);
  }

  /**
   * 「本次操作」摘要：把分散在左栏的词库、范围和输出设置翻译成三句人话。
   * 所有字段都做节点存在性判断，保持无头回归的 DOM 桩兼容。
   */
  function updateTaskSummary(stage) {
    var enabled = (state.rules || []).filter(function (r) { return r.enabled !== false; });
    var ruleNames = enabled.map(function (r) { return r.label && r.type === 'regex' ? r.label : r.text; });
    var shown = ruleNames.slice(0, 7);
    setText('summaryRules', enabled.length ? enabled.length + ' 个词' : '没有启用敏感词');
    setText('summaryRulesDetail', enabled.length
      ? shown.join('、') + (ruleNames.length > shown.length ? ' 等' : '')
      : '请先在左侧添加或启用敏感词');

    var scope = checkedVal('scope') || 'firstlast';
    var action = checkedVal('action') || 'delete';
    var scopeText = { firstlast: '首行 + 尾行', first: '首行', all: '全文' }[scope] || '首行 + 尾行';
    var actionText = action === 'mask' ? '智能打码'
      : action === 'custom' ? '替换为「' + (($('customText') && $('customText').value || '').trim() || '空文本') + '」'
        : '删除';
    setText('summaryProcess', scopeText + ' · ' + actionText);
    setText('summaryProcessDetail', $('verifyAfter') && $('verifyAfter').checked
      ? '也会检查其余位置，减少残留' : '只处理所选位置');

    var outmode = checkedVal('outmode') || 'zip';
    var backup = $('backup') ? !!$('backup').checked : true;
    var deleteBak = $('deleteBak') ? !!$('deleteBak').checked : false;
    if (outmode === 'inplace') {
      setText('summaryOutput', backup ? '覆盖原文件 · 先留备份' : '覆盖原文件 · 无备份');
      setText('summaryOutputDetail', backup && deleteBak
        ? '成功后删除 .bak，处理后不能撤销' : (backup ? '可用 .bak 撤销本次处理' : '原文件会直接改变'));
    } else if (outmode === 'newfolder') {
      setText('summaryOutput', '保存到新目录 · 原文件不变');
      setText('summaryOutputDetail', '运行时会选择或复用保存目录');
    } else {
      setText('summaryOutput', '下载 ZIP · 原文件不变');
      setText('summaryOutputDetail', '处理结果会另外打包下载');
    }

    var total = state.files.length;
    var hitFiles = state.files.filter(function (f) { return f.status === 'hit'; }).length;
    var unsupported = state.files.filter(function (f) { return !f.supported; }).length;
    if (stage === 'empty') {
      setText('summaryTitle', '先添加要处理的文档');
      setText('summaryMeta', '添加后可先检查，再决定是否清除');
    } else if (stage === 'loaded') {
      setText('summaryTitle', '将处理 ' + total + ' 个文件');
      setText('summaryMeta', '下一步先检查命中，不会改动文件');
    } else if (stage === 'scanned') {
      setText('summaryTitle', hitFiles ? '发现 ' + hitFiles + ' 个文件有敏感词' : '没有发现敏感词');
      setText('summaryMeta', hitFiles ? '可点文件行查看前后对照，再清除并导出'
        : '当前文件不需要清除，可直接更换文件' + (unsupported ? '；另有 ' + unsupported + ' 个格式不支持' : ''));
    } else {
      var run = state.lastRun;
      setText('summaryTitle', run ? '本次处理已完成' : '已有文件处理完成');
      setText('summaryMeta', run
        ? '修改 ' + run.changed + ' 个文件，清除 ' + run.hits + ' 处敏感词'
        : '可导出记录留档，或继续添加其他文件');
    }
  }

  function syncTaskUi() {
    var stage = taskStage();
    updateSettingsSummaries();
    var workspace = $('fileWorkspace');
    if (workspace) {
      workspace.setAttribute('data-task-stage', stage);
      if (workspace.classList) {
        workspace.classList.toggle('has-preview', state.selectedId != null || state.scanPreviewIdx >= 0);
      }
    }
    updateTaskSummary(stage);
  }

  /** 空列表没有可处理对象：禁用主按钮，并直接说明下一步。 */
  function updateRunAvailability() {
    var btn = $('runBtn');
    if (!btn) return;
    btn.disabled = !!state.running || !state.files.length;
    if (!state.running) btn.textContent = taskStage() === 'done' ? '再次清除' : '清除并导出';
    btn.setAttribute('data-tip', !state.files.length
      ? '请先添加文件；添加后可先检查，再清除并导出'
      : '按「本次操作」里的范围清除；勾了文件时只处理勾选项');
  }

  function renderTable() {
    updateRunAvailability();
    updateFlow();
    syncTaskUi();
    var body = $('fileBody');
    var empty = $('emptyHint');
    body.innerHTML = '';
    var list = visibleFiles();
    if (!list.length) {
      // 空态里带着插图（.empty-art）与两行文案，直接改 textContent 会把 SVG 一起清掉，
      // 所以只替换文案节点的内容，插图保持原样。
      var emptyTitle = $('emptyTitle');
      var emptySub = $('emptySub');
      // 筛「仅命中 / 已处理」卻为空，且还有文件没扫描时，先说清原因：
      // 这种空是「还没扫描」造成的，不是筛选条件写错了。
      var unscanned = state.files.filter(function (x) { return x.supported && x.status === 'pending'; }).length;
      var st = $('fileFilterStatus') ? $('fileFilterStatus').value : 'all';
      var needScan = unscanned > 0 && (st === 'hit' || st === 'done');
      if (emptyTitle && emptySub) {
        if (needScan) {
          emptyTitle.textContent = '还没有可筛选的结果';
            emptySub.textContent = '还有 ' + unscanned + ' 个文件未检查，先点上方「检查文件」';
        } else if (state.files.length) {
          emptyTitle.textContent = '没有符合条件的文件';
          emptySub.textContent = '换个筛选条件试试';
        } else {
          emptyTitle.textContent = '还没有文档';
          emptySub.textContent = '把文件拖到这里，或点上方按钮选择';
        }
      } else {
        empty.textContent = state.files.length ? '没有符合过滤条件的文件' : '请添加需要处理的文档';
      }
      empty.style.display = 'block';
      var fc0 = $('filterCount');
      if (fc0) fc0.textContent = state.files.length ? ('0 / ' + state.files.length) : '';
      updateSelBar();
      return;
    }
    empty.style.display = 'none';
    var fc = $('filterCount');
    if (fc) fc.textContent = list.length === state.files.length ? '' : ('显示 ' + list.length + ' / ' + state.files.length);

    list.forEach(function (it) {
      var tr = document.createElement('tr');
      if (it.id === state.selectedId) tr.className = 'selected';
      tr.setAttribute('data-id', it.id);

      var statusText = '待处理', statusCls = 'pending';
      // 状态列也给出解释：颜色与文案本身信息量有限，悬停时补一句现状与下一步
      var statusTip = '待处理：还没检查，点上方「检查文件」看看有无敏感词';
      // 行悬停说明：失败 / 不支持的原因必须能直接看到。
      // 此前表格只显示「错误」二字，具体原因藏在日志里，用户不知道哪个文件出了什么问题、要不要管。
      var rowHint = '';
      if (!it.supported) {
        statusText = '不支持'; statusCls = 'error';
        // 「不支持」原本只有状态两个字，用户不知道原因、也不知道下一步怎么办。
        statusTip = '此格式本工具不处理';
        // 这里按扩展名给出两种真实原因：旧版 Office 二进制格式可以另存为再处理，
        // 其它（图片 / PDF / 压缩包等）本工具一律不处理。
        var ext = (it.path.split('.').pop() || '').toLowerCase();
        var legacy = (ext === 'doc' || ext === 'xls' || ext === 'ppt');
        rowHint = legacy
          ? '旧版 ' + ext.toUpperCase() + ' 格式：用 Office / WPS 另存为 .docx / .xlsx / .pptx 后即可处理'
          : '本工具不处理此格式（支持 .docx、.xlsx、.pptx、.txt / .csv / .md 等文本文件），图片、.doc 旧版格式、PDF 无法自动清除';
      }
      else if (it.status === 'hit') { statusText = '命中 ' + it.hits; statusCls = 'hit'; }
      else if (it.status === 'clean') { statusText = '无敏感词'; statusCls = 'clean'; }
      else if (it.status === 'done') { statusText = '已处理'; statusCls = 'done'; }
      else if (it.status === 'error') {
        statusText = '错误'; statusCls = 'error';
        rowHint = it.error ? ('处理失败：' + it.error) : '处理失败';
      }
      if (it.status === 'hit') statusTip = '扫描发现 ' + it.hits + ' 处敏感词，勾选后可处理';
      else if (it.status === 'clean') statusTip = '扫描未发现敏感词';
      else if (it.status === 'done') statusTip = '已按设置处理完成';
      else if (it.status === 'error') statusTip = it.error ? ('处理失败：' + it.error) : '处理失败';
      if (!it.supported) statusTip = rowHint;
      if (rowHint) tr.setAttribute('data-tip', rowHint);
      var hitsHtml = it.supported ? (it.hits > 0 ? it.hits + ' 处' : '-') : '—';
      // 命中词徽章：直接铺在「命中」列，不用 hover 才知道命中了什么；超过 3 个折叠成「+N」。
      var matchedHtml = '';
      if (it.supported && it.matched && it.matched.length) {
        var MAXW = 3;
        var shown = it.matched.slice(0, MAXW).map(function (w) {
          return '<span class="kw">' + escapeHtml(w) + '</span>';
        }).join('');
        var rest = it.matched.length - MAXW;
        if (rest > 0) shown += '<span class="kw kw-more">+' + rest + '</span>';
        matchedHtml = '<div class="hit-words">' + shown + '</div>';
      }

      var tdSel = document.createElement('td');
      tdSel.className = 'sel-col';
      var cbx = document.createElement('input');
      cbx.type = 'checkbox';
      cbx.className = 'row-check';
      cbx.checked = !!state.checked[it.id];
      cbx.setAttribute('data-tip', '选择此文件（Shift 连选）');
      cbx.setAttribute('aria-label', '选择 ' + it.path);
      cbx.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var visIdx = visibleFiles().findIndex(function (f) { return f.id === it.id; });
        var wantChecked = cbx.checked;
        // Shift + 点击：选中 / 取消锚点到当前行之间的整段
        if (e && e.shiftKey && state.lastCheckedIdx >= 0 && visIdx >= 0) {
          var lo = Math.min(state.lastCheckedIdx, visIdx);
          var hi = Math.max(state.lastCheckedIdx, visIdx);
          var vis = visibleFiles();
          for (var k = lo; k <= hi; k++) {
            if (wantChecked) state.checked[vis[k].id] = true;
            else delete state.checked[vis[k].id];
          }
        } else if (wantChecked) {
          state.checked[it.id] = true;
        } else {
          delete state.checked[it.id];
        }
        state.lastCheckedIdx = visIdx;
        renderTable();
      });
      tdSel.appendChild(cbx);

      tr.innerHTML =
        '<td class="path" data-tip="' + escapeHtml(it.path) + '">' + escapeHtml(it.path) + '</td>' +
        '<td><span class="tag ' + it.kind + '">' + kindLabel(it.kind) + '</span></td>' +
        '<td>' + fmtSize(it.size) + '</td>' +
        '<td data-tip="' + escapeHtml(it.matched.join('、')) + '">' + hitsHtml + matchedHtml + '</td>' +
        '<td><span class="status ' + statusCls + '" data-tip="' + escapeHtml(statusTip) + '">' + statusText + '</span></td>';

      var tdOp = document.createElement('td');
      var del = document.createElement('button');
      del.className = 'row-del';
      del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      del.setAttribute('data-tip', '从列表移除');
      del.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        removeFile(it.id);
      });
      tdOp.appendChild(del);
      tr.appendChild(tdOp);

      tr.addEventListener('click', function () { selectFile(it.id); });
      tr.insertBefore(tdSel, tr.firstChild);
      body.appendChild(tr);
    });
    updateSelBar();
  }

  /* ---------------- 多选 / 批量删除 ---------------- */

  function selectedIds() {
    return state.files.filter(function (f) { return state.checked[f.id]; }).map(function (f) { return f.id; });
  }

  function syncSelAll() {
    var all = $('fileSelAll');
    if (!all) return;
    var list = visibleFiles();
    var n = list.filter(function (f) { return state.checked[f.id]; }).length;
    all.checked = list.length > 0 && n === list.length;
    all.indeterminate = n > 0 && n < list.length;
    all.disabled = !list.length;
  }

  function updateSelBar() {
    var n = selectedIds().length;
    var bar = $('selBar');
    if (bar) bar.style.display = n ? 'flex' : 'none';
    var c = $('selCount');
    if (c) c.textContent = '已选 ' + n + ' 个文件';
    // 勾选不只用于删除，它同时决定「清除并导出」的范围。选择条上只写「已选 N 个」
    // 会让人以为只是删东西用的，实测也确实有用户取消勾选后仍以为全量处理。
    var hint = $('selScopeHint');
    if (hint) hint.textContent = n ? '「清除并导出」只处理勾选的文件' : '';
    var del = $('delSelBtn');
    if (del) del.disabled = n === 0;
    var none = $('selNoneBtn');
    if (none) none.disabled = n === 0;
    var invert = $('selInvertBtn');
    if (invert) invert.disabled = !state.files.length;
    syncSelAll();
  }

  function removeSelected() {
    var ids = selectedIds();
    if (!ids.length) return;
    var n = ids.length;
    state.files = state.files.filter(function (f) { return !state.checked[f.id]; });
    ids.forEach(function (id) { delete state.checked[id]; });
    if (state.selectedId && !state.files.some(function (f) { return f.id === state.selectedId; })) {
      state.selectedId = null;
    }
    renderTable();
    updateSummary();
    log('已移除 ' + n + ' 个选中文件。', 'info');
  }

  function updateSummary() {
    var total = state.files.length;
    var sup = state.files.filter(function (x) { return x.supported; }).length;
    var hit = state.files.filter(function (x) { return x.status === 'hit'; }).length;
    $('fileSummary').innerHTML = '共 <b>' + total + '</b> 个文件，支持 <b>' + sup + '</b> 个' +
      (hit ? '，已扫描命中 <b>' + hit + '</b> 个' : '');
    updateReportBtn();
    updateRunAvailability();
    updateFlow();
    syncTaskUi();
  }

  /* ---------------- 引擎 ---------------- */

  function buildConfig() {
    var rules = state.rules.filter(function (r) { return r.enabled; })
      .map(function (r) {
        var out = { text: r.text, type: r.type, enabled: true };
        if (r.label) out.label = r.label;
        if (r.whole) out.whole = true;
        var nb = ctxList(r.notBefore);
        if (nb.length) out.notBefore = nb;
        var na = ctxList(r.notAfter);
        if (na.length) out.notAfter = na;
        return out;
      });
    return {
      rules: rules,
      scope: checkedVal('scope'),
      action: checkedVal('action'),
      custom: $('customText').value,
      // v4.11 大小写敏感：此前 buildConfig 从不传这个字段，网页端被写死成不敏感，
      // 而命令行早就有 --case-sensitive。对手机号 / IP 这类 ASCII 规则有实际影响。
      caseSensitive: !!($('caseSensitive') && $('caseSensitive').checked)
    };
  }

  function buildEngine() {
    return Rules.createEngine(buildConfig());
  }

  /* ---------------- 扫描预览 ---------------- */

  function scanAll() {
    if (!state.files.length) { log('请先添加文件', 'warn'); return; }
    if (!ensureRules()) return;
    var engine = buildEngine();
    var pending = state.files.filter(function (x) { return x.supported; });
    if (!pending.length) { log('没有支持的文件', 'warn'); return; }
    var conc = getConc();
    // 扫描预览只标注文件列表状态；先把上一轮文件夹扫描的结果卡片复位，
    // 否则卡片里残留的旧命中会和本次结果混在一起，看起来像「刚扫出来的」
    resetScanRun();
    renderScanResults();
    updateScanReportBtn();
    var scanCard = $('scanResultCard');
    if (scanCard) scanCard.style.display = 'none';
    // 有文件因格式不支持而跳过时要说出来：否则用户看到「命中 0」会以为全部干净，
    // 实际有文件根本没被检查过（最常见的坑：报告里混着 .doc / .pdf）。
    var skipped = state.files.length - pending.length;
    log('开始扫描 ' + pending.length + ' 个支持的文件（范围：' + scopeLabel(engine.scope) +
      '，并发 ' + conc + '）' + (skipped > 0 ? '，另有 ' + skipped + ' 个格式不支持未检查' : '') + '…', 'info');

    var completed = 0;
    var t0 = Date.now();
    mapPool(pending, conc, function (it) {
      return Promise.resolve().then(function () {
        // 先按大小判断，避免把超大文件整个读进内存
        if (it.size > MAX_FILE_BYTES) { it.status = 'error'; it.error = '文件过大'; return; }
        return it.file.arrayBuffer().then(function (buf) {
          if (Doc.isTextFile(it.path)) {
            var dec = Doc.decodeText(buf);
            var r = Doc.processText(dec.text, engine);
            it.hits = r.hits; it.matched = r.matched;
            it.status = r.touched ? 'hit' : 'clean';
          } else {
            return Doc.scanOffice(buf, engine).then(function (res) {
              it.hits = res.hits; it.matched = res.matched;
              it.status = res.hits > 0 ? 'hit' : 'clean';
            });
          }
        });
      }).catch(function (e) {
        it.status = 'error'; it.error = errMsg(e) || '扫描失败';
        log('扫描失败：' + it.path + ' — ' + errMsg(e), 'err');
      }).then(function () {
        completed++;
        updateProgress((completed / pending.length) * 100, completed, pending.length);
        tableRender.schedule();
        if (completed % 25 === 0 && completed < pending.length) {
          var elapsed = (Date.now() - t0) / 1000;
          var rate = completed / (elapsed || 1);
          var eta = (pending.length - completed) / rate;
          log('已扫描 ' + completed + '/' + pending.length + '，预计剩余约 ' + Math.round(eta) + ' 秒', 'info');
        }
      });
    }).then(function () {
      tableRender.flush();
      var totalHits = state.files.reduce(function (a, x) { return a + (x.hits || 0); }, 0);
      var hitFiles = state.files.filter(function (x) { return x.status === 'hit'; }).length;
      var errFiles = state.files.filter(function (x) { return x.status === 'error'; }).length;
      log('扫描完成：命中 ' + hitFiles + ' 个文档 / ' + totalHits + ' 处敏感词，耗时 ' +
        ((Date.now() - t0) / 1000).toFixed(1) + ' 秒' + (errFiles ? '（' + errFiles + ' 个文件读取失败）' : '') + '。',
        'ok');
    });
  }

  /* ---------------- 文件夹扫描 ---------------- */

  var SYS_SKIP_DIRS = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
    '$Recycle.Bin', 'System Volume Information', 'AppData', 'node_modules', '.git'];

  /** 扫描单个文件：命中则记入 state.scanResults（并发调用安全） */
  async function scanOneFile(job, opts, stats) {
    var handle = job.handle, path = job.path;
    if (state.scanCancel) return;
    try {
      var file = await handle.getFile();
      if (file.size > MAX_FILE_BYTES) return;
      var buf = await file.arrayBuffer();
      var hits = 0, matched = [], hitChars = 0, totalChars = 0;
      if (Doc.isTextFile(path)) {
        var dec = Doc.decodeText(buf);
        var r = Doc.processText(dec.text, opts.engine);
        hits = r.hits; matched = r.matched; hitChars = r.hitChars || 0; totalChars = r.totalChars || 0;
      } else {
        var s = await Doc.scanOffice(buf, opts.engine);
        hits = s.hits; matched = s.matched; hitChars = s.hitChars || 0; totalChars = s.totalChars || 0;
      }
      if (hits > 0) {
        stats.hitFiles++;
        stats.totalHits += hits;
        var row = {
          path: path, handle: handle, file: file, dir: job.dir, name: job.name,
          size: file.size, hits: hits, matched: matched.slice(), selected: true,
          hitChars: hitChars, totalChars: totalChars, ratio: totalChars > 0 ? hitChars / totalChars : 0
        };
        state.scanResults.push(row);
        state.scanArchive.push(row);
        scanTableRender.schedule();
      }
    } catch (e) {
      stats.errors++;
    }
  }

  /**
   * 递归扫描目录：先收集本层条目，再以受控并发处理本层文件，最后递归子目录。
   * 相比「逐文件串行 await」，大目录扫描可提速数倍；同时保持每层批量处理，内存可控、可随时取消。
   */
  async function scanDirHandle(dirHandle, prefix, depth, opts, stats) {
    if (state.scanCancel || depth > opts.maxDepth) return;
    var it = dirHandle.entries();
    var batch = [];    // 本层待处理文件
    var subDirs = [];  // 本层子目录（处理完本层文件后再递归）
    try {
      for (;;) {
        if (state.scanCancel) return;
        var step = await it.next();
        if (step.done) break;

        var name = step.value[0];
        var handle = step.value[1];

        if (handle.kind === 'directory') {
          var skip = (name.charAt(0) === '.') ||
            (opts.skipSys && SYS_SKIP_DIRS.indexOf(name) >= 0);
          if (!skip) subDirs.push({ handle: handle, path: prefix ? prefix + '/' + name : name });
          continue;
        }
        if (handle.kind !== 'file') continue;

        stats.scanned++;
        if (stats.scanned >= opts.maxFiles) { stats.truncated = true; break; }
        if (!Doc.isSupported(name)) continue;
        // v4.10 文件名关键字前置过滤：不读文件就判掉，省掉整块 IO
        if (!nameHit(name, opts.nameWords, opts.nameMode)) { stats.nameSkipped = (stats.nameSkipped || 0) + 1; continue; }

      batch.push({ handle: handle, name: name, dir: dirHandle, path: prefix ? prefix + '/' + name : name });
      }

      if (batch.length) {
        await mapPool(batch, getConc(), function (job) {
          return scanOneFile(job, opts, stats);
        });
        updateProgress(Math.min(100, (stats.scanned / opts.maxFiles) * 100));
        updateScanLive(stats, opts.t0 || Date.now());
        if (stats.scanned - stats.lastLog >= 100) {
          stats.lastLog = stats.scanned;
          var elapsed = (Date.now() - opts.t0) / 1000;
          var rate = stats.scanned / (elapsed || 1);
          var eta = rate > 0 ? ((opts.maxFiles - stats.scanned) / rate) : 0;
          log('已扫描 ' + stats.scanned + ' 个文件，命中 ' + stats.hitFiles +
            ' 个…（约 ' + Math.max(1, Math.round(rate)) + ' 个/秒，预计剩余约 ' + Math.round(eta) + ' 秒）', 'info');
        }
      }

      for (var k = 0; k < subDirs.length; k++) {
        if (state.scanCancel) return;
        await scanDirHandle(subDirs[k].handle, subDirs[k].path, depth + 1, opts, stats);
      }
    } catch (e) {
      stats.errors++; // 无权限或已损坏的目录，跳过
    }
  }

  /* ---------------- 多位置挑选的共同底座 ----------------
     「扫描所有存储…」与「添加所有存储…」都是「连续选 + 列表确认 + 一次执行」，
     差异只在执行动作与文案，这里抽出共用部分（错误文案 / 扫描参数 / 挑选行 UI）。 */

  /** 统一的错误取文案：Error 取 message，其余原样 */
  function errMsg(e) { return e && e.message ? e.message : e; }

  /** 词库守卫：没有启用任何敏感词时给出统一提示并返回 false */
  function ensureRules() {
    if (state.rules.some(function (r) { return r.enabled; })) return true;
    log('词库为空，请先添加敏感词', 'warn');
    return false;
  }

  /** 目录选择 API 守卫：浏览器没给 File System Access 时统一提示并返回 false */
  function dirPickerReady(what) {
    if ('showDirectoryPicker' in global) return true;
    log('当前环境不支持' + what + '：需要支持目录选择的浏览器（Chrome / Edge / UOS 上的 Chromium），http 或 https 本地服务。', 'err');
    return false;
  }

  /** v4.2 网络盘提示：浏览器的目录选择器不支持网络位置（Chrome 限制），
      * 命中时给出一条真实可用的出路——命令行扫 UNC，再把报告导回界面。
      * 判据：路径形如 \\server\share 或 //server/share。 */
  function isNetworkPath(p) {
    return /^[\/]{2}[^\/]+[\/]+[^\/]+/.test(String(p || ''));
  }

  /** 网络盘说明文案（日志与界面共用，改一处即可） */
  var NET_PATH_TIP = '浏览器的目录选择器不支持网络位置（\\server\share 这类 UNC 路径），'
    + '这是 Chrome 的限制。网络盘请用命令行扫描：'
    + 'node scan.mjs --dir "\\server\share" --json --report scan.json，'
    + '再回本界面点「导入报告…」选中 scan.json 即可。';

  /** 扫描进行中守卫：忙着的时候不允许再起一轮扫描 / 处理 */
  function notScanning() {
    if (!state.scanning) return true;
    log('扫描进行中，请先停止或等待完成。', 'warn');
    return false;
  }

  /**
   * 报告导入 / 复检进行中守卫。tail 接在「中止」后面（如「后再扫描文件夹」）；
   * again=true 换成「上次导入 / 复检仍在进行」的措辞，给导入入口自己用。
   */
  function notImporting(tail, again) {
    if (!state.importing) return true;
    log((again ? '上次导入 / 复检仍在进行' : '报告导入 / 复检进行中')
      + '，请先完成或点「停止扫描」中止' + (tail || '') + '。', 'warn');
    return false;
  }

  /** 扫描参数的唯一来源（原来扫描预览 / 文件夹扫描 / 多盘扫描各写一份） */
  /** v4.3 读取格式筛选并把扩展名过滤器装到引擎层（Doc.isSupported 据此收窄）。
      返回当前生效的扩展名数组；'all' 预设返回 null（不限制）。 */
  function applyExtFilter() {
    var preset = $('scanExtPreset');
    var mode = preset ? preset.value : 'common';
    var list = null;
    if (mode === 'custom') {
      var raw = $('scanExtCustom') ? ($('scanExtCustom').value || '') : '';
      list = raw.split(/[,，;；\s]+/).map(function (x) { return x.trim().toLowerCase().replace(/^\./, ''); }).filter(Boolean);
      if (!list.length) list = Doc.COMMON_EXT.slice();
    } else if (mode === 'common') {
      list = Doc.COMMON_EXT.slice();
    }
    if (Doc.setExtFilter) Doc.setExtFilter(list);
    return list;
  }

  /** v4.10 文件名关键字：解析界面输入，与命令行 --name-words 同口径。
      中英文逗号 / 分号 / 空白均可分隔，大小写不敏感。 */
  function parseNameWords(raw) {
    if (!raw) return null;
    var list = String(raw).split(/[,，;；\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    return list.length ? list : null;
  }

  /** 文件名是否命中。mode='and' 要求全部包含，'or' 任一包含。
      只判文件名，不含目录路径。 */
  function nameHit(name, words, mode) {
    if (!words) return true;
    var low = String(name).toLowerCase();
    var has = function (w) { return low.indexOf(String(w).toLowerCase()) >= 0; };
    return mode === 'and' ? words.every(has) : words.some(has);
  }

  function scanOpts() {
    applyExtFilter();
    return {
      engine: buildEngine(),
      maxFiles: Math.max(100, parseInt($('scanMaxFiles').value, 10) || 5000),
      maxDepth: Math.max(1, parseInt($('scanMaxDepth').value, 10) || 8),
      skipSys: $('scanSkipSys').checked,
      nameWords: parseNameWords($('scanNameWords') ? $('scanNameWords').value : ''),
      nameMode: ($('scanNameMode') && $('scanNameMode').value === 'and') ? 'and' : 'or'
    };
  }

  /** 每轮扫描开始前复位结果与筛选，避免上一轮的命中 / 关键字混进新结果 */
  function resetScanRun() {
    state.scanResults = [];
    state.scanArchive = [];
    state.scanAddedCount = 0;
    state.scanPreviewIdx = -1;
    state.lastScan = null;
    state.scanHideFp = false;
    // v4.1：复核意见按轮归零——留着会把上一轮的判断写进新一轮报告
    scanReviewNote = '';
    var srn = $('scanReviewNote');
    if (srn) srn.value = '';
    resetScanFilters();
    syncScanReviewRow();
  }

  /** 目录扫描的计数器（两个扫描入口共用，新增口径时只改这里） */
  function newScanStats() {
    return { scanned: 0, hitFiles: 0, totalHits: 0, errors: 0, truncated: false, lastLog: 0, nameSkipped: 0 };
  }

  /* v4.68 实时状态条 + 彩色合计行：
     扫描中把「已查 N · 命中 M · 速度」压进一条横幅，不用翻日志；结束后在表格上方给出
     可点的彩色合计，一眼看清命中 / 误报 / 未检查分布。 */
  var scanLiveShown = false;
  function updateScanLive(stats, t0) {
    var bar = $('scanLiveBar');
    if (!bar) return;
    if (!scanLiveShown) { bar.hidden = false; scanLiveShown = true; }
    var txt = $('scanLiveText');
    if (txt && stats) {
      var sec = (Date.now() - t0) / 1000;
      var rate = sec > 0.5 ? Math.round(stats.scanned / sec) : 0;
      txt.textContent = '已查 ' + stats.scanned + ' 个 · 命中 ' + stats.hitFiles +
        ' 个' + (rate > 0 ? ' · ' + rate + ' 个/秒' : '…');
    }
  }

  function endScanLive() {
    var bar = $('scanLiveBar');
    if (bar) bar.hidden = true;
    scanLiveShown = false;
  }

  function renderScanTally() {
    var el = $('scanTally');
    if (!el) return;
    var rows = state.scanResults || [];
    if (!rows.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    var hit = 0, fp = 0, un = 0;
    rows.forEach(function (r) {
      var s = scanRowState(r);
      if (s === 'hit') hit++; else if (s === 'fp') fp++; else un++;
    });
    var cur = state.scanFilterStatus || 'all';
    var cls = function (st) { return st === cur ? ' on' : ''; };
    el.innerHTML = '本次结果：命中 <b class="t-hit' + cls('hit') + '" data-st="hit"'
      + ' aria-pressed="' + (cur === 'hit') + '">' + hit + '</b>' +
      (fp ? ' · 误报 <b class="t-fp' + cls('fp') + '" data-st="fp"'
        + ' aria-pressed="' + (cur === 'fp') + '">' + fp + '</b>' : '') +
      (un ? ' · 未检查 <b class="t-un' + cls('unchecked') + '" data-st="unchecked"'
        + ' aria-pressed="' + (cur === 'unchecked') + '">' + un + '</b>' : '') +
      ' · 共 ' + rows.length + ' 条';
  }

  /** 进入扫描态：复位上一轮、亮出结果卡片、放开停止按钮（两个扫描入口共用） */
  function beginScanRun() {
    resetScanRun();
    state.scanning = true;
    state.scanCancel = false;
    $('scanResultCard').style.display = 'block';
    $('stopScanBtn').disabled = false;
    var bar = $('scanLiveBar');
    if (bar) bar.hidden = false;
    scanLiveShown = true;
    updateScanLive(newScanStats(), Date.now());
    renderScanResults();
  }

  /** 扫描收尾：落地 state.lastScan、刷新「导出记录」，返回耗时的秒数字符串 */
  function finishScan(opts, stats, t0, rootLabel) {
    state.lastScan = {
      time: stamp(),
      root: rootLabel,
      scanned: stats.scanned,
      hitFiles: stats.hitFiles,
      totalHits: stats.totalHits,
      maxFiles: opts.maxFiles,
      maxDepth: opts.maxDepth,
      skipSys: opts.skipSys,
      truncated: stats.truncated,
      errors: stats.errors,
      // v4.10 文件名关键字：留着供报告说明「为什么这些文件没被扫」
      nameWords: opts.nameWords ? opts.nameWords.slice() : null,
      nameMode: opts.nameMode || 'or',
      nameSkipped: stats.nameSkipped || 0,
      review: scanReviewNote
    };
    updateScanReportBtn();
    syncScanReviewRow();
    return ((Date.now() - t0) / 1000).toFixed(1);
  }

  /** 选一个位置加入列表；取消 / 未授权 / 重复都返回 null（选中即用，不落记忆） */
  function pickAddLocation(st, cfg) {
    if (!dirPickerReady(cfg.what)) return Promise.resolve(null);
    return global.showDirectoryPicker({ mode: cfg.mode }).then(function (h) {
      return h || null;
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
        if (cfg.cancelLog) log(cfg.cancelLog, 'info');
        return null;
      }
      log(cfg.failLabel + '失败：' + errMsg(e), cfg.failLevel || 'err');
      return null;
    }).then(function (h) {
      if (!h) return null;
      if (st.list.some(function (d) { return d.handle === h || d.name === h.name; })) {
        log('「' + (h.name || cfg.fallbackName) + '」已经在列表里，未重复添加。', 'info');
        return null;
      }
      st.list.push({ handle: h, name: h.name || cfg.fallbackName });
      return h;
    });
  }

  /** 挑选态下禁用「入口按钮」，退出时按扫描状态复位（多盘扫描 / 多盘加入共用） */
  function setBusy(cfg, on) {
    (cfg.busy || []).forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = on ? true : state.scanning;
    });
  }

  /** 挑选行的显隐与开始按钮联动（多盘扫描 / 多盘加入共用） */
  function pickLine(st, cfg, on) {
    st.active = !!on;
    var row = $(cfg.row);
    if (row) row.style.display = on ? 'flex' : 'none';
    // v4.2：UNC 输入行只属于「扫描所有存储」挑选态，跟随它显隐
    if (cfg.row === 'drivePickRow') {
      var ur = $('uncPickRow');
      if (ur) ur.style.display = on ? 'flex' : 'none';
    }
    setBusy(cfg, on);
    // 退出挑选态也要重绘：列表已清空，开始按钮应随之回到禁用，提示也该复位
    renderPick(st, cfg);
  }

  /** 「已选 N 个位置：…」提示与开始按钮可用性 */
  function renderPick(st, cfg) {
    var hint = $(cfg.hint);
    var start = $(cfg.start);
    if (hint) {
      hint.textContent = st.list.length
        ? ('已选 ' + st.list.length + ' 个位置：' + st.list.map(function (d) { return d.name; }).join('、'))
        : '还没有选位置：点「继续添加…」挑盘或文件夹';
    }
    if (start) start.disabled = st.list.length === 0;
  }

  /* ---------------- 多盘 / 多目录一次扫（v2.89） ----------------
     点「扫描所有存储…」进入挑选态，每选一个位置追加到待扫列表（可重复点继续添加），
     点「开始扫描」按列表顺序扫完所有位置，中途任何一个都能用「停止扫描」收手。 */
  var DRIVE_STATE = { active: false, list: [] };
  var DRIVE_PICK_UI = { row: 'drivePickRow', hint: 'drivePickHint', start: 'driveStartBtn',
    busy: ['scanFolderBtn', 'scanDrivesBtn'], mode: 'readwrite', failLabel: '选择目录',
    fallbackName: '未命名目录', what: '目录扫描' };

  function driveSetActive(on) { pickLine(DRIVE_STATE, DRIVE_PICK_UI, on); }

  function driveRenderPick() { renderPick(DRIVE_STATE, DRIVE_PICK_UI); }

  /** v4.2 网络盘：把路径型条目转成可直接粘贴的命令，并给出导入指引。
      浏览器的目录选择器与 File System Access API 都不支持 UNC，这是平台限制；
      命令行 scan.mjs 走 Node 的 fs，UNC 与映射盘都能正常扫。 */
  function emitUncCommand(items) {
    var paths = items.map(function (d) { return d.path; });
    var parts = paths.map(function (p) { return '--dir "' + p + '"'; }).join(' ');
    var cmd = 'node scan.mjs ' + parts + ' --json --report scan.json';
    log('网络盘请用命令行扫描（浏览器选不了网络位置）：', 'warn');
    log(cmd, 'info');
    log('扫完回到本界面，点「更多扫描设置… → 导入报告…」选中 scan.json，命中文档就会进表格，可直接勾选处理。', 'info');
    var uncBtn = $('uncAddBtn');
    var uncDone = function () {
      log('命令已复制到剪贴板，粘贴到命令行执行即可。', 'ok');
      if (uncBtn) {
        var old = uncBtn.textContent;
        uncBtn.textContent = '已复制';
        uncBtn.classList.add('ok');
        setTimeout(function () { uncBtn.textContent = old; uncBtn.classList.remove('ok'); }, 1600);
      }
    };
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(uncDone, function () { fallbackCopy(cmd, uncDone); });
    } else {
      fallbackCopy(cmd, uncDone);
    }
  }

  /** 把输入的 UNC / 本地路径加入扫描列表（不触碰文件系统，仅登记） */
  function uncAddFromInput() {
    var el = $('uncPathInput');
    var raw = el ? (el.value || '').trim() : '';
    if (!raw) { log('请先填写路径，如 \\\\server\\share', 'warn'); return; }
    var p = raw.replace(/^["']|["']$/g, '');
    if (DRIVE_STATE.list.some(function (d) { return d.path === p; })) {
      log('「' + p + '」已经在列表里，未重复添加。', 'info'); return;
    }
    DRIVE_STATE.list.push({ path: p, name: p });
    if (el) el.value = '';
    driveRenderPick();
    log('已加入扫描列表：' + p + '（共 ' + DRIVE_STATE.list.length + ' 个）', 'info');
  }

  function driveAddOne() {
    return pickAddLocation(DRIVE_STATE, DRIVE_PICK_UI).then(function (h) {
      if (!h) return;
      driveRenderPick();
      log('已加入扫描列表：' + (h.name || '目录') + '（共 ' + DRIVE_STATE.list.length + ' 个）', 'info');
    });
  }

  function driveStartAll() {
    if (state.scanning) return;
    if (!DRIVE_STATE.list.length) { log('请先点「继续添加…」选择要扫描的位置', 'warn'); return; }
    // v4.2：列表里混入路径型条目（UNC / 网络盘）时，浏览器选不了也读不了，转命令行通道
    var pathItems = DRIVE_STATE.list.filter(function (d) { return d.path; });
    if (pathItems.length) { emitUncCommand(pathItems); return; }
    if (!ensureRules()) return;
    var opts = scanOpts();
    beginScanRun();

    var stats = newScanStats();
    opts.t0 = Date.now();
    var labels = [];
    var total = DRIVE_STATE.list.length;
    var list = DRIVE_STATE.list.slice();
    var chain = Promise.resolve();
    list.forEach(function (d) {
      chain = chain.then(function () {
        if (state.scanCancel) return;
        labels.push(d.name);
        $('scanMeta').innerHTML = '正在扫描（' + labels.length + '/' + total + '）：<b>'
          + escapeHtml(d.name) + '</b>';
        log('开始扫描 [' + labels.length + '/' + total + ']：' + d.name, 'info');
        return scanDirHandle(d.handle, '', 1, opts, stats).then(function () {
          scanTableRender.flush();
          updateScanReportBtn();
        }).catch(function (e) {
          log('扫描 ' + d.name + ' 出错：' + errMsg(e), 'err');
          stats.errors++;
        });
      });
    });
    return chain.then(function () {
      state.scanning = false;
      state.scanCancel = false;
      $('stopScanBtn').disabled = true;
      endScanLive();
      driveSetActive(false);
      DRIVE_STATE.list = [];
      // 挑选行已收起也要复位「开始扫描」：它现在藏在折叠行里，用户下次展开时不该还亮着
      $('driveStartBtn').disabled = true;
      var sec = finishScan(opts, stats, opts.t0, labels.join(' + ') || '多个位置');
      var aborted = labels.length < total;
      if (aborted) {
        log('已停止扫描：完成 ' + labels.length + ' / ' + total + ' 个位置，共检查 ' + stats.scanned
          + ' 个文件，命中 ' + stats.hitFiles + ' 个文档 / ' + stats.totalHits + ' 处敏感词。', 'warn');
      } else {
        log('全部位置扫描完成（' + labels.length + ' 个位置）：共检查 ' + stats.scanned + ' 个文件，命中 '
          + stats.hitFiles + ' 个文档 / ' + stats.totalHits + ' 处敏感词，耗时 ' + sec + ' 秒。', 'ok');
      }
      $('scanMeta').innerHTML = (aborted ? '已停止：' : '扫描完成：') + '共检查 <b>' + stats.scanned
        + '</b> 个文件，命中 <b>' + stats.hitFiles + '</b> 个文档（<b>' + stats.totalHits + '</b> 处）。';
    });
  }

  /* ---------------- 多盘 / 多目录一次加入处理列表（v2.90） ----------------
     与 v2.89 的「扫描所有存储…」配套：那个只扫不改，这个直接把多个盘 / 目录里的
     文档加进处理列表，接着就能「开始处理」。同样受 showDirectoryPicker 无多选 API
     限制，做成连续挑选 + 列表确认 + 一次加入。 */
  var ADD_STATE = { active: false, list: [] };
  var ADD_PICK_UI = { row: 'addPickRow', hint: 'addPickHint', start: 'addPickStartBtn',
    busy: ['addDrivesBtn'], mode: 'read', failLabel: '选择目录', fallbackName: '未命名目录',
    what: '目录选择' };

  function addSetActive(on) {
    pickLine(ADD_STATE, ADD_PICK_UI, on);
  }

  function addRenderPick() {
    renderPick(ADD_STATE, ADD_PICK_UI);
  }

  /** 递归收集目录句柄下的文件（深度不限，与「添加文件夹」的 input 行为一致） */
  function collectFiles(dirHandle, prefix, out) {
    // values() 规范返回 Promise<AsyncIterator>；个别环境或旧实现直接给迭代器，两种都兼容。
    return Promise.resolve(dirHandle.values()).then(function (iter) {
      var step = function () {
        return Promise.resolve(iter.next()).then(function (r) {
          if (r.done) return out;
          var h = r.value;
          if (!h) return step();
          if (h.kind === 'file') {
            return Promise.resolve(h.getFile()).then(function (f) {
              f._relPath = prefix + h.name;
              out.push(f);
              return step();
            }).catch(function () { return step(); });
          }
          if (h.kind === 'directory') {
            return collectFiles(h, prefix + h.name + '/', out).then(step);
          }
          return step();
        });
      };
      return step();
    });
  }
  function addPickOne() {
    return pickAddLocation(ADD_STATE, ADD_PICK_UI).then(function (h) {
      if (!h) return;
      addRenderPick();
      log('已加入列表：' + (h.name || '目录') + '（共 ' + ADD_STATE.list.length + ' 个位置）', 'info');
    });
  }

  /* ---------------- 盘符快选（v2.91） ----------------
     Windows 的文件选择器不允许把 http://127.0.0.1:8080 这类站点位置
     当选取目标（会弹「无法打开此文件夹，因为其中含有系统文件」），
     所以做成：列出盘符按钮，点哪个就只选那个盘的根目录，绕开特殊位置。 */
  function driveQuickPanel() {
    var row = $('drivePickRow');
    if (!row) return;
    var panel = $('driveQuickPanel');
    if (panel) {
      panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
      return;
    }
    panel = document.createElement('div');
    panel.id = 'driveQuickPanel';
    panel.style.cssText = 'padding:6px 4px 2px;font-size:12px;color:var(--muted)';
    var tip = document.createElement('p');
    tip.className = 'hint';
    tip.style.margin = '0 0 6px';
    tip.textContent = '点盘符按钮，在弹出的选择器里进入该盘根目录后确定。不要选「此电脑 / 快速访问 / 网络」等特殊位置，Windows 会拒绝打开。';
    panel.appendChild(tip);
    var wrap = document.createElement('div');
    wrap.className = 'btn-row';
    wrap.style.flexWrap = 'wrap';
    var letters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    letters.forEach(function (L) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini';
      b.textContent = L + ':';
      b.setAttribute('data-tip', '选择 ' + L + ' 盘根目录加入扫描列表');
      b.addEventListener('click', function () { driveQuickAdd(L); });
      wrap.appendChild(b);
    });
    panel.appendChild(wrap);
    row.parentNode.insertBefore(panel, row.nextSibling);
  }

  function driveQuickAdd(letter) {
    log('请在弹窗里进入并选择 ' + letter + ': 盘的根目录（不要选此电脑 / 快速访问）。', 'info');
    return pickAddLocation(DRIVE_STATE, { mode: 'readwrite',
      failLabel: '选择 ' + letter + ' 盘', fallbackName: letter + ' 盘',
      failLevel: 'warn',
      cancelLog: '已取消或未授权选择 ' + letter + ' 盘。',
      what: DRIVE_PICK_UI.what }).then(function (h) {
      if (!h) return;
      driveRenderPick();
      log('已加入：' + (h.name || letter + ' 盘') + '（共 ' + DRIVE_STATE.list.length + ' 个位置）', 'ok');
    });
  }

  function addPickStart() {
    if (!ADD_STATE.list.length) { log('请先点「继续添加…」选择位置', 'warn'); return; }
    var list = ADD_STATE.list.slice();
    setBusy(ADD_PICK_UI, true);
    var hint = $(ADD_PICK_UI.hint);
    if (hint) hint.textContent = '正在读取 ' + list.length + ' 个位置的文件…';
    log('开始读取 ' + list.length + ' 个位置的文件…', 'info');

    var chain = Promise.resolve([]);
    list.forEach(function (d) {
      chain = chain.then(function (acc) {
        return collectFiles(d.handle, d.name + '/', []).then(function (files) {
          log('「' + d.name + '」读到 ' + files.length + ' 个文件', 'info');
          return acc.concat(files);
        }).catch(function (e) {
          log('读取「' + d.name + '」失败：' + errMsg(e), 'warn');
          return acc;
        });
      });
    });

    return chain.then(function (all) {
      setBusy(ADD_PICK_UI, false);
      if (!all.length) {
        log('这几个位置里没有文件。', 'warn');
      } else {
        addFiles(all);
      }
      ADD_STATE.list = [];
      addSetActive(false);
      renderTable();
      updateSummary();
    });
  }

async function scanFolder() {
    if (state.scanning) return;
    if (!dirPickerReady('目录扫描')) return;
    if (!ensureRules()) return;

    // 上次扫描过的文件夹会被记住：权限仍有效时直接复用，不再每次弹选择框
    var picked = await pickDir(SCAN_ROOT_KEY, { mode: 'readwrite' });
    var root = picked.handle;
    if (!root) { log('未选择文件夹，已取消', 'warn'); return; }
    if (picked.reused) {
      log('已复用上次扫描的文件夹：' + (root.name || '已记住的目录') + '（要换目录请重新选择，或点「清除目录记忆」）', 'info');
    }

    var opts = scanOpts();
    beginScanRun();
    $('scanFolderBtn').disabled = true;
    $('scanMeta').textContent = '正在扫描：' + (root.name || '所选文件夹') + ' …';

    var rootLabel = root.name || '所选文件夹';
    log('开始扫描文件夹：' + rootLabel + '（上限 ' + opts.maxFiles + ' 个文件，最大深度 ' + opts.maxDepth + '）', 'info');

    var stats = newScanStats();
    var t0 = Date.now();
    opts.t0 = t0;
    try {
      await scanDirHandle(root, '', 1, opts, stats);
    } catch (e) {
      log('扫描出错：' + errMsg(e), 'err');
    }

    var sec = finishScan(opts, stats, t0, rootLabel);
    state.scanning = false;
    $('scanFolderBtn').disabled = false;
    $('stopScanBtn').disabled = true;
    endScanLive();
    updateProgress(100);
    scanTableRender.flush();

    $('scanMeta').innerHTML = '扫描完成：共检查 <b>' + stats.scanned + '</b> 个文件，命中 <b>' +
      stats.hitFiles + '</b> 个文档（<b>' + stats.totalHits + '</b> 处敏感词），耗时 ' + sec + ' 秒' +
      (stats.truncated ? ' · 已达文件数上限，结果可能不完整' : '') +
      (stats.errors ? ' · ' + stats.errors + ' 个文件读取失败' : '');
    log('文件夹扫描完成：命中 ' + stats.hitFiles + ' 个文档 / ' + stats.totalHits + ' 处敏感词。', 'ok');
  }

  /* ---------------- 导入通用检查报告 ---------------- */

  // 报告导入时授权的盘符根目录：'D:' -> DirectoryHandle（仅本次会话有效，刷新页面需重新授权）
  var reportRoots = {};
  // 已定位成功的目录句柄缓存：'D:|工作/统计局' -> DirectoryHandle
  var reportDirCache = {};
  // 各盘符上次导入时「没找到」的文件数：用来判断该盘授权是否需要重新选择
  var reportRootMiss = {};

  /* ---------------- 目录授权记忆（IndexedDB，跨会话复用） ---------------- */
  var SCAN_ROOT_KEY = 'scan-root';
  var OUT_DIR_KEY = 'out-dir';
  // 目录缓存实现在 js/dircache.js（DWRDirCache）：纯 IndexedDB 存取，与 DOM 无关
  var dirCacheGet = global.DWRDirCache.get;
  var dirCachePut = global.DWRDirCache.put;
  var dirCacheDel = global.DWRDirCache.del;
  var dirCacheClear = global.DWRDirCache.clear;

  /**
   * 取目录句柄：优先零点击复用上次记住的（权限仍有效时），否则弹选择框并把新选择记住。
   * @returns {Promise<{handle:Object|null, reused:boolean}>} handle 为 null 表示用户取消 / 环境不支持
   */
  async function pickDir(key, opts) {
    opts = opts || {};
    var mode = opts.mode || 'read';
    var cached = await dirCacheGet(key);
    if (cached) {
      var st = 'granted';
      try {
        if (cached.queryPermission) st = await cached.queryPermission({ mode: mode });
      } catch (e) { st = 'denied'; }
      if (st === 'granted') return { handle: cached, reused: true };
    }
    if (!('showDirectoryPicker' in global)) return { handle: null, reused: false };
    var handle = null;
    try { handle = await global.showDirectoryPicker(); } catch (e) { return { handle: null, reused: false }; }
    await dirCachePut(key, handle);
    return { handle: handle, reused: false };
  }

  /** 从盘符根逐级进入子目录（带缓存：报告动辄数百个文件，避免重复 getDirectoryHandle） */
  async function locateReportDir(root, drive, dirRel) {
    var key = drive + '|' + dirRel;
    var hit = reportDirCache[key];
    if (hit) return hit;
    var dir = root;
    var parts = dirRel.split(/[\\/]+/).filter(function (s) { return s; });
    for (var i = 0; i < parts.length; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    reportDirCache[key] = dir;
    return dir;
  }

  /** 报告导入 / 复检期间切换相关按钮可用状态，避免并发导入与重复触发 */
  function setImportBusy(on) {
    var imp = $('importReportBtn');
    if (imp) imp.disabled = !!on;
    var stop = $('stopScanBtn');
    if (stop) stop.disabled = !on;
    var scan = $('scanFolderBtn');
    if (scan) scan.disabled = !!on;
    var rs = $('scanRescreenBtn');
    if (rs && on) rs.disabled = true;
  }

  /**
   * 按当前词库对「已定位 + 支持格式」的报告行做只读复检（导入与「重新甄别」共用）。
   * 复检命中 → 自动勾选；复检 0 命中 → 取消勾选并置 checked（供「误报」徽章 / 隐藏使用）；
   * 复检失败不擅自改判（保留检查软件结论并保持勾选），交由人工判断。
   * 支持 state.importCancel 中途停止：已跑完的行保留结果，未开始的行保持原判定。
   */
  async function recheckReportRows(rows, opts) {
    opts = opts || {};
    var engine = buildEngine();
    var targets = [], bigSkip = 0;
    rows.forEach(function (r) {
      if (!r.handle || !Doc.isSupported(r.path)) return;
      if (r.size > MAX_FILE_BYTES) bigSkip++;
      else targets.push(r);
    });
    var recheckErr = 0, done = 0;
    if (targets.length) {
      log((opts.label || '正在按当前词库复检') + ' ' + targets.length + ' 个已定位文件，甄别检查软件误报…'
        + '（耗时可能较长，可点左侧「停止扫描」中止）', 'info');
      var t1 = Date.now();
      // 取字节这一步必须包在 Promise.resolve().then 里：r.file 缺失 / 读取抛错时，
      // 同步异常才会变成 reject 流进下面的 .catch——直接写 r.file.arrayBuffer() 的
      // 同步 throw 会被 mapPool 的 rejection 处理器吞掉，表现为「复检 0 命中 0 误报、
      // 耗时 0 秒」却毫无报错的静默失败。
      await mapPool(targets, getConc(), function (r) {
        if (state.importCancel) return null;
        return Promise.resolve().then(function () {
          return r.file.arrayBuffer();
        }).then(function (buf) {
          var p = null;
          if (Doc.isTextFile(r.path)) {
            var dec = Doc.decodeText(buf);
            var res = Doc.processText(dec.text, engine);
            r.hits = res.hits;
            r.matched = res.matched || [];
          } else {
            p = Doc.scanOffice(buf, engine).then(function (res) {
              r.hits = res.hits;
              r.matched = res.matched || [];
            });
          }
          return p;
        }).then(function () {
          r.checked = true;
          r.selected = r.hits > 0;
        }).catch(function (e) {
          r.checked = false;
          r.selected = true;
          recheckErr++;
          log('复检失败（暂按检查软件原报告处理）：' + r.path + ' — ' + ((e && e.message) || e), 'warn');
        }).then(function () {
          done++;
          if (done % 25 === 0 || done === targets.length) {
            updateProgress((done / targets.length) * 100, done, targets.length);
            if (done < targets.length) log('复检进度 ' + done + '/' + targets.length + '…', 'info');
          }
        });
      });
      var realOk = rows.filter(function (r) { return r.checked && r.hits > 0; }).length;
      var fp = rows.filter(function (r) { return r.checked && !(r.hits > 0); }).length;
      log((state.importCancel ? '复检已中止（完成 ' + done + '/' + targets.length + '）：' : '复检完成：')
        + '确认命中 ' + realOk + ' 个、误报 ' + fp + ' 个（耗时 ' + ((Date.now() - t1) / 1000).toFixed(1) + ' 秒）。',
        state.importCancel ? 'warn' : 'ok');
    }
    return {
      // 只认「本工具真的复检过且命中」的行：未复检行（.doc/.pdf 等不支持的格式）
      // 保留的是检查软件的原始命中数，混进来会把 376 条误报也报成「复检确认命中」
      realHits: rows.filter(function (r) { return r.checked && (r.hits || 0) > 0; }).length,
      totalHits: rows.reduce(function (a, r) { return r.checked ? a + (r.hits || 0) : a; }, 0),
      falsePos: rows.filter(function (r) { return r.checked && !(r.hits > 0); }).length,
      recheckErr: recheckErr,
      bigSkip: bigSkip,
      checked: targets.length,
      done: done,
      cancelled: !!state.importCancel
    };
  }

  /** 报告行重新甄别后，按当前结果重算扫描汇总（命中 / 误报 / 检查软件条数） */
  function refreshReportSummary() {
    if (!state.lastScan || !state.lastScan.fromReport) return null;
    var hitFiles = 0, totalHits = 0, falsePos = 0;
    state.scanArchive.forEach(function (r) {
      // 与导入摘要同一口径：只有本工具复检过的行才计入命中 / 处数，
      // 未复检行（格式不支持 / 未定位）保留的检查软件命中数不计入
      if (r.checked && (r.hits || 0) > 0) hitFiles++;
      if (r.checked) totalHits += (r.hits || 0);
      if (isFalsePositiveRow(r)) falsePos++;
    });
    state.lastScan.hitFiles = hitFiles;
    state.lastScan.totalHits = totalHits;
    state.lastScan.falsePos = falsePos;
    state.lastScan.checkerHits = state.scanArchive.length;
    state.scanHideFp = falsePos > 0;
    return state.lastScan;
  }

  /**
   * 重新甄别：词库 / 作用范围改动后，对全部已定位的报告行按当前词库重新复检。
   * 刻意不按勾选筛选——勾选本身就是上次甄别的产物，改词库后原本藏起来的「误报」行
   * 也可能变成真命中；只复检勾选项会把新命中漏掉。
   */
  async function rescreenSelected() {
    if (!notImporting('', true)) return;
    if (!notScanning()) return;
    if (!ensureRules()) return;
    var targets = state.scanResults.filter(function (r) {
      return r.fromReport && r.handle && Doc.isSupported(r.path);
    });
    if (!targets.length) {
      log('没有可重新甄别的报告行。请先导入检查报告，或确认文件已定位且格式受支持。', 'warn');
      return;
    }
    state.importing = true;
    state.importCancel = false;
    setImportBusy(true);
    try {
      await recheckReportRows(targets, { label: '正在重新甄别报告文件' });
    } finally {
      endImportBusy();
    }
    refreshReportSummary();
    scanTableChanged(true);
    var st = state.lastScan;
    if (!st) { log('重新甄别完成：已更新 ' + targets.length + ' 个文件。', 'ok'); return; }
    log('重新甄别完成：' + st.hitFiles + ' 个命中，' + st.falsePos + ' 个误报。', 'ok');
  }

  /** 导入 / 重新甄别收尾：复位互斥标记并刷新全部相关按钮（含「重新甄别」的可用态）。
   *  互斥锁本体是 state.importing（importReport / rescreenSelected 入口检查并置位） */
  function endImportBusy() {
    state.importing = false;
    setImportBusy(false);
    // setImportBusy(false) 只负责解禁；「重新甄别」是否可用要看行数据，必须重算一次
    updateScanAddBtn();
  }

  // 报告导入队列：一次选多个报告文件时逐个导入（互斥锁仍在 importReport 内，不会并发跑）
  var reportQueue = [];
  var reportDraining = false;

  function enqueueReports(list) {
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i]) { reportQueue.push(list[i]); added++; }
    }
    if (!added) return;
    if (reportQueue.length > 1) log('已加入导入队列：共 ' + reportQueue.length + ' 个报告文件，将依次处理', 'info');
    if (!reportDraining) drainReports();
  }

  async function drainReports() {
    reportDraining = true;
    try {
      while (reportQueue.length) {
        var f = reportQueue.shift();
        await importReport(f);
      }
    } finally {
      reportDraining = false;
      reportQueue = [];
    }
  }

  async function importReport(file) {
    if (!file) return;
    if (!notImporting('后再导入', true)) return;
    if (!Report) { log('报告解析模块未加载（js/report.js 缺失）', 'err'); return; }
    state.importing = true;
    state.importCancel = false;
    setImportBusy(true);
    try {
      await importReportBody(file);
    } finally {
      endImportBusy();
    }
  }

  /**
   * 导入通用检查软件的 HTML 详细报告 / JSON 清单 / 纯路径清单：
   * 解析命中文件路径 → 按盘符申请目录授权 → 定位文件句柄 → 汇入扫描结果表，
   * 之后即可复用「一键处理 / 一键删除 / 加入处理列表 / 导出扫描报告」等全部批量能力。
   */
  async function importReportBody(file) {
    var text;
    try {
      text = Report.decodeBytes(await file.arrayBuffer());
    } catch (e) {
      log('报告读取失败：' + errMsg(e), 'err');
      return;
    }
    var parsed = null;
    try {
      parsed = Report.parseAny(file.name, text);
    } catch (e) {
      log('报告解析失败：' + errMsg(e), 'err');
      return;
    }
    var files = (parsed && parsed.files) || [];
    if (!files.length) {
      log('未从报告中解析出文件路径：' + file.name + '（支持保密检查软件 HTML 详细报告 / 本工具导出的 JSON / 纯路径清单）', 'err');
      return;
    }

    var drives = [];
    files.forEach(function (f) {
      var dm = /^([A-Za-z]:)[\\/]/.exec(f.file);
      if (dm && drives.indexOf(dm[1].toUpperCase()) < 0) drives.push(dm[1].toUpperCase());
    });

    log('报告解析完成：' + file.name + ' → ' + files.length + ' 个文件'
      + (drives.length ? '（' + drives.join(' / ') + '）' : '')
      + (parsed.sections && parsed.sections.length ? '，分节：' + parsed.sections.join(' / ') : ''), 'ok');

    if ('showDirectoryPicker' in global) {
      for (var di = 0; di < drives.length; di++) {
        var drive = drives[di];
        // 上次导入时该盘有文件没找到：多半是根目录选错了（或授权被浏览器撤销）。
        // 若继续复用旧句柄，日志里说的「重新导入报告再选」就成了空话，故重新导入时主动重新选择。
        if (reportRoots[drive] && reportRootMiss[drive]) {
          log('上次导入 ' + drive + ' 盘有 ' + reportRootMiss[drive] + ' 个文件未找到，请重新选择 ' + drive + ' 盘根目录…', 'info');
          delete reportRoots[drive];
          Object.keys(reportDirCache).forEach(function (k) {
            if (k.indexOf(drive + '|') === 0) delete reportDirCache[k];
          });
          await dirCacheDel('report:' + drive);
        }
        if (reportRoots[drive]) continue;
        // 本次会话还没授权过该盘：先看上次记住的句柄还能不能用（权限仍有效就零点击复用）
        var remembered = await dirCacheGet('report:' + drive);
        if (remembered) {
          var perm = 'granted';
          try {
            if (remembered.queryPermission) perm = await remembered.queryPermission({ mode: 'read' });
          } catch (e0) { perm = 'denied'; }
          if (perm === 'granted') {
            reportRoots[drive] = remembered;
            delete reportRootMiss[drive];
            log('已复用上次授权的 ' + drive + ' 盘：' + (remembered.name || drive) + '（要换目录可点「清除目录记忆」）', 'ok');
            continue;
          }
        }
        log('请选择 ' + drive + ' 盘根目录（如 ' + drive + '），用于定位报告中的文件…', 'info');
        var pk = await pickDir('report:' + drive, { mode: 'read' });
        if (pk.handle) {
          reportRoots[drive] = pk.handle;
          delete reportRootMiss[drive];
          log('已授权 ' + drive + '：' + (reportRoots[drive].name || drive), 'ok');
        } else {
          log('未授权 ' + drive + '，该盘符下的文件将保持「未定位」，无法批量处理（可重新导入报告再选）', 'warn');
        }
      }
    } else {
      log('当前环境不支持目录授权（需 Chrome/Edge 且经本地服务器访问），本次仅列出清单', 'warn');
    }

    var exist = {};
    state.scanResults.forEach(function (r) { exist[String(r.path).toLowerCase()] = true; });

    var rows = [], missing = 0, unsupported = 0, noRoot = 0, dup = 0, aborted = 0;
    var missByDrive = {};
    var missSample = [];
    log('正在定位报告中的文件（共 ' + files.length + ' 个）…', 'info');
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (exist[f.file.toLowerCase()]) { dup++; continue; }
      exist[f.file.toLowerCase()] = true;

      var row = {
        path: f.file,
        handle: null, file: null, dir: null, name: null,
        size: f.size || 0,
        hits: f.hits || 0,
        matched: f.matched || [],
        // 检查软件的原始结论留档：复检后 hits / matched 被本工具结果覆盖，便于对比与误报标注
        checkerHits: f.hits || 0,
        checkerMatched: f.matched || [],
        // 复检 0 命中的行会被自动取消勾选，避免把检查软件的误报批量处理掉
        selected: false,
        fromReport: true
      };
      var dm = /^([A-Za-z]:)[\\/](.*)$/.exec(f.file);
      var driveKey = dm ? dm[1].toUpperCase() : null;
      // 中止：定位阶段对数百条报告可能耗时数分钟，点「停止扫描」必须在这里立刻停下
      if (state.importCancel) { aborted++; rows.push(row); continue; }
      var root = dm ? reportRoots[dm[1].toUpperCase()] : null;
      if (dm && root) {
        var rest = dm[2];
        var lastSlash = Math.max(rest.lastIndexOf('\\'), rest.lastIndexOf('/'));
        var dirRel = rest.slice(0, lastSlash);
        var fileName = rest.slice(lastSlash + 1);
        try {
          var dir = await locateReportDir(root, dm[1].toUpperCase(), dirRel);
          row.dir = dir;
          row.name = fileName;
          row.handle = await dir.getFileHandle(fileName);
          // 只对格式支持的文件读内容：.doc/.pdf/.rar/.vhd 等本工具根本不解析，
          // 读全文纯属浪费——大型报告里这类文件占比很高，其中还可能包含数 GB 的
          // 虚拟磁盘镜像，逐个 getFile() 会让定位阶段白等几分钟。
          // 这些行的 size 用报告里带的大小，复检本来也会跳过它们。
          if (Doc.isSupported(f.file)) {
            row.file = await row.handle.getFile();
            if (row.file && row.file.size) row.size = row.file.size;
          }
        } catch (e) {
          missing++;
          if (missSample.length < 5) missSample.push(f.file);
          missByDrive[driveKey] = (missByDrive[driveKey] || 0) + 1;
        }
      } else if (dm) {
        // 该盘未授权（用户取消选择或上次失败）：同样记为未定位，下次导入会重新要求选择
        noRoot++;
        missByDrive[driveKey] = (missByDrive[driveKey] || 0) + 1;
      } else {
        noRoot++;
      }
      if (!Doc.isSupported(f.file)) unsupported++;
      rows.push(row);
    }
    if (aborted) log('定位已中止：剩余 ' + aborted + ' 个文件未定位（已定位的行保留结果，可再次导入继续）', 'warn');
    Object.keys(missByDrive).forEach(function (d) { reportRootMiss[d] = missByDrive[d]; });

    if (!rows.length) {
      log('报告中的文件均已在当前列表中（重复 ' + dup + ' 条），未新增', 'warn');
      return;
    }

    // 误报甄别：保密检查软件的报告里绝大多数是误报（经验值约 99%），
    // 用本工具当前词库对已定位文件做只读复检，用本工具的命中覆盖检查软件结论：
    // 复检命中 → 自动勾选；复检 0 命中 → 取消勾选并标注「误报」，不参与后续批量处理。
    var rc = await recheckReportRows(rows, { label: '正在按当前词库复检' });
    var falsePos = rc.falsePos, bigSkip = rc.bigSkip, recheckErr = rc.recheckErr;
    var realHits = rc.realHits;
    state.scanHideFp = falsePos > 0;

    rows.forEach(function (r) {
      state.scanResults.push(r);
      state.scanArchive.push(r);
    });

    state.lastScan = {
      time: stamp(),
      root: file.name,
      scanned: files.length,
      // 命中数按本工具复检结果统计：检查软件报告命中 checkerHits 条，其中 falsePos 条为误报
      hitFiles: realHits,
      checkerHits: rows.length,
      falsePos: falsePos,
      totalHits: rc.totalHits,
      maxFiles: files.length,
      maxDepth: 0,
      skipSys: false,
      truncated: false,
      errors: missing,
      fromReport: true
    };
    scanTableChanged(true);
     $('scanResultCard').style.display = 'block';
     renderScanResults();
     $('scanMeta').innerHTML = '已导入报告：<b>' + rows.length + '</b> 条，确认命中 <b>' + realHits + '</b> 个' + (falsePos ? '，误报 <b>' + falsePos + '</b> 个已隐藏' : '') + '。';
    var located = rows.length - noRoot - missing - aborted;
    log('已导入 ' + rows.length + ' 条（检查软件报告命中 ' + files.length + ' 个）：已定位 ' + located + ' 个'
      + (rc.checked ? '，其中 ' + rc.checked + ' 个格式支持已按当前词库复检' : '')
      + '——确认命中 ' + realHits + ' 个'
      + (falsePos ? '、误报 ' + falsePos + ' 个（已自动取消勾选）' : '')
      + (noRoot ? '；未授权盘符 ' + noRoot + ' 个' : '')
      + (missing ? '；磁盘上未找到 ' + missing + ' 个' : '')
      + (aborted ? '；中止时未定位 ' + aborted + ' 个' : '')
      + (dup ? '；重复跳过 ' + dup + ' 个' : '')
      + (unsupported ? '；' + unsupported + ' 个为暂不支持的格式（.doc/.pdf 等，无法复检、按检查软件原结论列出）' : '')
      + (bigSkip ? '；' + bigSkip + ' 个文件过大未复检' : '')
      + (recheckErr ? '；' + recheckErr + ' 个复检失败（暂按检查软件原报告处理）' : '') + '。', 'ok');
    if (missing) log('未找到的文件（示例）：' + missSample.join('、') + '，可能已被移动 / 删除、无读取权限，或授权目录不对', 'warn');
    if (unsupported) log(unsupported + ' 个为 .doc / .pdf 等本工具暂不支持的格式（同样无法复检、按检查软件原结论列出）：请先用 Office / WPS 另存为 .docx / .xlsx / .pptx 再导入处理。', 'info');
    if (falsePos) log('复检 0 命中的误报已默认隐藏并取消勾选（表格上方「隐藏误报」可切回），勾选的 ' + realHits
      + ' 个为按当前词库复检确认的命中。', 'info');
    log('勾选后即可「一键处理选中 / 一键删除选中 / 将选中项加入处理列表」。报告文件本身含敏感路径，处理完成后建议删除。', 'info');
  }
  /** 加入处理列表：只把行移出扫描结果表格；报告数据源仍保留本次全部命中（v2.8 的取舍） */
  function addScanRows(rows) {
    if (!rows.length) return 0;
    // 定位阶段只对格式支持的文件读内容，未复检 / 不支持的行的 file 为 null；
    // 这些行进处理列表也只会被跳过，直接加会在这行抛「Cannot read properties of null」
    var usable = rows.filter(function (r) { return r.file; });
    if (!usable.length) {
      log('选中的 ' + rows.length + ' 行没有可加入处理列表的文件（格式不支持或未定位，处理不了）。', 'warn');
      return 0;
    }
    if (usable.length < rows.length) {
      // 不止说「没加入」，还告诉用户下一步：这类行几乎都是 .doc/.pdf 等二进制格式，
      // 或报告里的路径本机不存在——这两个原因的处置方式完全不同。
      var fmt = rows.filter(function (r) { return !r.file && r.checkerHits > 0 && r.checked; }).length;
      log('其中 ' + (rows.length - usable.length) + ' 行未加入处理列表：'
        + (fmt ? fmt + ' 行格式不支持（.doc / .pdf 等），需先用 Office / WPS 另存为 docx；' : '')
        + ((rows.length - usable.length - fmt) > 0 ? (rows.length - usable.length - fmt) + ' 行未定位到文件，请检查路径是否存在。' : ''),
        'info');
    }
    usable.forEach(function (r) { r.file._relPath = r.path; });
    var added = addFiles(usable.map(function (r) { return r.file; }));
    if (!added) return 0;
    var keys = {};
    rows.forEach(function (r) { keys[r.path + '|' + r.size] = true; });
    state.scanResults = state.scanResults.filter(function (r) { return !keys[r.path + '|' + r.size]; });
    state.scanAddedCount += added;
    scanTableChanged(true);
    log('已将 ' + added + ' 个命中文档加入处理列表并移出扫描结果' +
      (state.scanResults.length ? '（剩余 ' + state.scanResults.length + ' 项）' : '') + '，可点击「清除并导出」。', 'ok');
    return added;
  }

  /** 行内删除：扫描结果与报告数据源同步移除该行，并同步修正预览行索引 */
  function removeScanRow(row, idx) {
    state.scanResults = state.scanResults.filter(function (r) { return r !== row; });
    state.scanArchive = state.scanArchive.filter(function (r) { return r !== row; });
    if (state.scanPreviewIdx === idx) state.scanPreviewIdx = -1;
    else if (state.scanPreviewIdx > idx) state.scanPreviewIdx -= 1;
    scanTableChanged(false);
    log('已从扫描结果中移除 1 项' + (row.path ? '：' + row.path : '') + '。', 'info');
  }

  /** 是否为「检查软件误报」行：导入报告后按本工具词库复检 0 命中 */
  function isFalsePositiveRow(r) {
    return !!(r && r.fromReport && r.checked && r.checkerHits > 0 && !(r.hits > 0));
  }

  /** 当前结果中复检误报的条数（仅导入检查报告时可能非 0） */
  function scanFalsePositiveCount() {
    var n = 0;
    state.scanResults.forEach(function (r) { if (isFalsePositiveRow(r)) n++; });
    return n;
  }

  /**
   * 行的处理状态：hit=本工具确认命中 / fp=复检误报 / unchecked=未复检（未定位或格式不支持）
   * 文件夹扫描出来的行本身即命中，统一算 hit。
   */
  function scanRowState(r) {
    if (!r) return 'hit';
    if (isFalsePositiveRow(r)) return 'fp';
    if (r.fromReport && (!r.handle || !r.checked)) return 'unchecked';
    return 'hit';
  }

  var SCAN_STATUS_LABEL = { all: '全部', hit: '仅看命中', fp: '仅看误报', unchecked: '未检查' };
  var SCAN_SORT_LABEL = { default: '默认顺序', hits: '命中多→少', size: '大小↓', path: '路径 A→Z' };

  /** 复位扫描表过滤条件（新一轮扫描 / 新导入报告时调用，避免上一轮的关键字把新结果全滤掉） */
  function resetScanFilters() {
    state.scanFilterQ = '';
    state.scanFilterStatus = 'all';
    state.scanSort = 'default';
    var q = $('scanFilterQ');
    if (q) q.value = '';
    var st = $('scanFilterStatus');
    if (st) st.value = 'all';
    var so = $('scanSort');
    if (so) so.value = 'default';
  }

  /**
   * 扫描表数据变了之后的统一收尾：清掉「刚复检行」的高亮，必要时复位预览指向，再重绘。
   * 分散在各处的 renderScanResults() 容易漏，统一从这里走。
   */
  function scanTableChanged(resetPreview) {
    state.scanLastCheckedIdx = -1;
    if (resetPreview) state.scanPreviewIdx = -1;
    renderScanResults();
  }

  /** 按当前过滤 / 排序条件筛出要显示的行，并更新表格上方的计数提示 */
  function applyScanFilter(rows) {
    var q = (state.scanFilterQ || '').trim().toLowerCase();
    var status = state.scanFilterStatus || 'all';
    var out = rows.filter(function (r) {
      if (status !== 'all' && scanRowState(r) !== status) return false;
      if (!q) return true;
      var hay = String(r.path || '').toLowerCase() + ' ' + (r.matched || []).join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    var sort = state.scanSort || 'default';
    if (sort === 'hits') {
      out = out.slice().sort(function (a, b) { return (b.hits || 0) - (a.hits || 0); });
    } else if (sort === 'size') {
      out = out.slice().sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    } else if (sort === 'path') {
      out = out.slice().sort(function (a, b) {
        return String(a.path || '').localeCompare(String(b.path || ''));
      });
    }
    var cnt = $('scanFilterCount');
    if (cnt) {
      cnt.textContent = '显示 ' + out.length + ' / ' + state.scanResults.length + ' 条'
        + (status !== 'all' ? ' · ' + SCAN_STATUS_LABEL[status] : '')
        + (sort !== 'default' ? ' · ' + SCAN_SORT_LABEL[sort] : '');
    }
    return out;
  }

  /** 表格实际渲染的行：隐藏误报开关 + 关键字 / 状态过滤 + 排序 */
  function scanVisibleRows() {
    var fp = scanFalsePositiveCount();
    var cb = $('scanHideFp');
    if (cb) cb.checked = !!state.scanHideFp;
    var label = $('scanHideFpLabel');
    if (label) label.textContent = fp ? '隐藏误报（' + fp + '）' : '隐藏误报';
    var wrap = $('scanHideFpWrap');
    if (wrap) wrap.style.display = fp ? '' : 'none';
    var rows = (!fp || !state.scanHideFp) ? state.scanResults.slice()
      : state.scanResults.filter(function (r) { return !isFalsePositiveRow(r); });
    return applyScanFilter(rows);
  }

  /* 三种表格空态插图，颜色走 --empty-* 令牌，深浅主题各一套 */
  var EMPTY_ART = {
    allClear: '<svg class="tn-art" viewBox="0 0 96 74" aria-hidden="true" focusable="false">' +
      '<rect x="20" y="10" width="44" height="54" rx="6" fill="var(--empty-doc)"/>' +
      '<path d="M58 10l16 16H58z" fill="var(--empty-fold)"/>' +
      '<rect x="27" y="34" width="22" height="4" rx="2" fill="var(--empty-line)"/>' +
      '<rect x="27" y="44" width="16" height="4" rx="2" fill="var(--empty-line)"/>' +
      '<circle cx="66" cy="50" r="17" fill="var(--empty-dot)"/>' +
      '<path d="m57 50 6 6 13-14" fill="none" stroke="#fff" stroke-width="4.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>',
    noHit: '<svg class="tn-art" viewBox="0 0 96 74" aria-hidden="true" focusable="false">' +
      '<rect x="18" y="8" width="60" height="42" rx="6" fill="var(--empty-doc)"/>' +
      '<path d="M64 8l14 14H64z" fill="var(--empty-fold)"/>' +
      '<rect x="25" y="30" width="30" height="4" rx="2" fill="var(--empty-line)"/>' +
      '<circle cx="48" cy="60" r="12" fill="var(--empty-dot)"/>' +
      '<path d="M43 60l4 4 8-9" fill="none" stroke="#fff" stroke-width="3.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>',
    filtered: '<svg class="tn-art" viewBox="0 0 96 74" aria-hidden="true" focusable="false">' +
      '<path d="M40 18l16 0 6 8 14 0 0 8-14 0-6-8-16 0z" fill="var(--empty-doc)"/>' +
      '<path d="M32 42h32l-5 8H37z" fill="var(--empty-fold)"/>' +
      '<circle cx="48" cy="62" r="9" fill="var(--empty-dot)"/>' +
      '<path d="M45 62l2 2 5-6" fill="none" stroke="#fff" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /** 统一的表格空态：插图 + 标题 + 说明，替代原来的一行灰字 */
  function tdEmpty(title, sub, art, colspan) {
    return '<td class="td-empty" colspan="' + (colspan || 7) + '"><div class="tn">' +
      (EMPTY_ART[art] || EMPTY_ART.allClear) +
      '<span class="tn-title">' + escapeHtml(title) + '</span>' +
      '<span class="tn-sub">' + escapeHtml(sub) + '</span>' +
      '</div></td>';
  }

  function renderScanResults() {
    var body = $('scanBody');
    if (!body) return;
    body.innerHTML = '';
    if (!state.scanResults.length) {
      body.innerHTML = '<tr>' + tdEmpty(
        state.scanAddedCount > 0 ? '命中的都已加入处理列表' : '没有发现敏感词',
        state.scanAddedCount > 0 ? '已加入的文档在右侧文件列表里' : '扫描范围内的文档都干净',
        'allClear') + '</tr>';
      var wrap0 = $('scanHideFpWrap');
      if (wrap0) wrap0.style.display = 'none';
      updateScanAddBtn();
      return;
    }
    var rows = scanVisibleRows();
    if (!rows.length) {
      body.innerHTML = '<tr>' + tdEmpty('误报都隐藏了', '取消勾选上方「隐藏误报」可查看全部 ' +
        scanFalsePositiveCount() + ' 条', 'filtered') + '</tr>';
      updateScanAddBtn();
      return;
    }
    rows.forEach(function (r, idx) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.className = 'sel-col';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'row-check';
      cb.checked = r.selected;
      cb.setAttribute('data-tip', '选择此结果（Shift 连选）');
      cb.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        var wantChecked = cb.checked;
        // Shift + 点击：以最后一次点击为锚点，选中 / 取消整段
        if (e && e.shiftKey && state.scanLastCheckedIdx >= 0) {
          var lo = Math.min(state.scanLastCheckedIdx, idx);
          var hi = Math.max(state.scanLastCheckedIdx, idx);
          for (var k = lo; k <= hi; k++) {
            state.scanResults[k].selected = wantChecked;
          }
        } else {
          r.selected = wantChecked;
        }
        state.scanLastCheckedIdx = idx;
        renderScanResults();
      });
      td.appendChild(cb);
      tr.appendChild(td);
      if (idx === state.scanPreviewIdx) tr.className = 'selected';
      if (isFalsePositiveRow(r)) tr.className = (tr.className ? tr.className + ' ' : '') + 'fp';
      var checkerNote = '';
      if (r.checkerHits > 0) {
        if (isFalsePositiveRow(r)) {
          checkerNote = ' <span class="tag bad" data-tip="保密检查软件报告命中 ' + r.checkerHits
            + ' 处（' + escapeHtml((r.checkerMatched || []).join('、')) + '），按当前词库复检 0 命中，判为误报">误报</span>';
        } else if (r.checked && r.hits !== r.checkerHits) {
          checkerNote = ' <span class="tag" data-tip="本工具复检 ' + r.hits + ' 处 / 保密检查软件报告 ' + r.checkerHits
            + ' 处（检查软件口径更宽，含本工具词库之外的词）">检查软件 ' + r.checkerHits + ' 处</span>';
        } else if (!r.checked) {
          checkerNote = ' <span class="tag" data-tip="未定位或格式不支持（.doc/.pdf 等），无法按当前词库复检；此处为保密检查软件报告的原始命中数">未复检 ' + r.checkerHits + ' 处</span>';
        }
      }
      tr.setAttribute('data-tip', '点击预览此文件的命中情况与处理结果');
      tr.addEventListener('click', function () { selectScanResult(idx); });
      tr.insertAdjacentHTML('beforeend',
        '<td class="path" data-tip="' + escapeHtml(r.path) + '">' + escapeHtml(r.path) + '</td>' +
        '<td><span class="tag ' + fileKind(r.path) + '">' + kindLabel(fileKind(r.path)) + '</span></td>' +
        '<td data-tip="' + (r.totalChars > 0 ? escapeHtml('命中 ' + (r.hitChars || 0) + ' / 全文 ' + r.totalChars + ' 字') : '全文无有效字符') + '">' + fmtRatio(r.ratio) + '</td>' +
        '<td>' + r.hits + ' 处' + checkerNote + (r.residue
          ? ' <span class="tag bad" data-tip="清除后自检仍发现的残留处数">残留 ' + r.residue + '</span>' : '') + '</td>' +

        scanWordsCell(r));
      var tdOp = document.createElement('td');
      tdOp.className = 'op-col';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'row-add';
      addBtn.textContent = '加入';
      addBtn.setAttribute('data-tip', '把该文档加入处理列表（加入后自动移出扫描结果）');
      addBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        if (!addScanRows([r])) log('该文档已在处理列表中：' + r.path, 'warn');
      });
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'row-del';
      delBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      delBtn.setAttribute('data-tip', '从扫描结果中移除（扫描报告同步减少）');
      delBtn.addEventListener('click', function (e) {
        if (e && e.stopPropagation) e.stopPropagation();
        removeScanRow(r, idx);
      });
      // v4.66 结果表右键菜单给「复制文件路径」一个出口。
      //   扫描表路径列虽有 data-tip 显示完整路径，但要拿到手里只能手动选中复制——
      //   合规用户要把路径贴进工单 / 邮件时是高频痛点。Ctrl+C 走同一函数。
      tr.addEventListener('contextmenu', function (e) {
        if (e && e.preventDefault) e.preventDefault();
        if (e && e.stopPropagation) e.stopPropagation();
        copyTextToClipboard(r.path, function () {
          log('已复制文件路径：' + r.path, 'ok');
        });
      });
      tdOp.appendChild(addBtn);
      tdOp.appendChild(delBtn);
      tr.appendChild(tdOp);
      body.appendChild(tr);
    });
    updateScanAddBtn();
    renderScanTally();
  }

  /* ---------------- v3.5 按命中词分组 ---------------- */

  /**
   * 命中词列：每个词做成可点按钮，点一下选中当前结果里所有含该词的行，
   * 配合「一键处理选中」就能「只清『机密』这个词碰过的所有文件」。
   */
  function scanWordsCell(r) {
    var words = (r && r.matched) || [];
    if (!words.length) return '<td>—</td>';
    var html = words.map(function (w) {
      var n = scanRowsWithWord(w);
      return '<button type="button" class="kw-btn" data-word="' + escapeHtml(w) + '"'
        + ' data-tip="选中所有命中「' + escapeHtml(w) + '」的 ' + n + ' 行"'
        + ' aria-label="选中所有命中 ' + escapeHtml(w) + ' 的行">' + escapeHtml(w) + '</button>';
    }).join('');
    return '<td class="words-cell">' + html + '</td>';
  }

  /** 当前可见结果里，命中词包含 w 的行数 */
  function scanRowsWithWord(w) {
    return scanVisibleRows().filter(function (x) {
      return (x.matched || []).indexOf(w) >= 0;
    }).length;
  }

  /** 选中 / 取消选中所有命中某词的行 */
  function selectScanByWord(w, on) {
    var n = 0;
    scanVisibleRows().forEach(function (x) {
      if ((x.matched || []).indexOf(w) >= 0) {
        x.selected = on;
        n++;
      }
    });
    renderScanResults();
    log((on ? '已选中 ' : '已取消 ') + n + ' 个命中「' + w + '」的文件', 'info');
  }
  function syncScanSelAll() {
    var all = $('scanSelAllBox');
    if (!all) return;
    var visible = scanVisibleRows();
    var total = visible.length;
    var n = visible.filter(function (r) { return r.selected; }).length;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
    all.disabled = !total;
  }

  function updateScanAddBtn() {
    var btn = $('addScanToFiles');
    if (!btn) return;
    updateScanReportBtn();
    var n = state.scanResults.filter(function (r) { return r.selected; }).length;
    btn.textContent = '加入处理列表（' + n + '）';
    btn.disabled = (n === 0);
    var del = $('scanDelSelBtn');
    if (del) del.disabled = (n === 0);
    var cleanBtn = $('scanCleanBtn');
    if (cleanBtn) cleanBtn.disabled = (n === 0);
    var delDiskBtn = $('scanDelDiskBtn');
    if (delDiskBtn) delDiskBtn.disabled = (n === 0);
    var verifyBtn = $('scanVerifyBtn');
    if (verifyBtn) verifyBtn.disabled = (n === 0);
    var rsBtn = $('scanRescreenBtn');
    if (rsBtn) {
      rsBtn.disabled = state.importing || !state.scanResults.some(function (r) {
        return r.fromReport && r.handle && Doc.isSupported(r.path);
      });
    }

    syncScanSelAll();
  }

  /** 扫描报告按钮只在有扫描结果时可用 */
  function updateScanReportBtn() {
    var on = !!state.lastScan && state.scanArchive.length > 0;
    var csv = $('scanReportBtn');
    if (csv) csv.disabled = !on;
    var json = $('scanReportJsonBtn');
    if (json) json.disabled = !on;
    var htmlBtn = $('scanReportHtmlBtn');
    if (htmlBtn) htmlBtn.disabled = !on;
  }

  /** 扫描报告明细行：取本次扫描的全量命中（「加入处理列表」不移除，「删除选中」才移除） */
  function scanReportRows() {
    return state.scanArchive.map(function (r) {
      return {
        path: r.path,
        kind: kindLabel(fileKind(r.path)),
        size: fmtSize(r.size),
        hits: r.hits,
        matched: (r.matched || []).join(' / '),
        ratio: fmtRatio(r.ratio)
      };
    });
  }

  /** 命中占比：0 或无分母时显示 -，其余保留一位小数的百分比 */
  function fmtRatio(v) {
    return v > 0 && isFinite(v) ? (v * 100).toFixed(1) + '%' : '-';
  }

  /** 全部命中文件的平均命中占比（按文件加权，不是按命中字数总和重新算） */
  function scanArchiveRatio() {
    var rows = state.scanArchive.filter(function (r) { return r.ratio > 0; });
    if (!rows.length) return 0;
    return rows.reduce(function (a, r) { return a + r.ratio; }, 0) / rows.length;
  }

  function scanSummary() {
    var s = state.lastScan;
    var rows = [
      ['生成时间', s.time],
      [s.fromReport ? '导入报告' : '扫描目录', s.root],
      ['已检查文件数', s.scanned, 'obs', '本次扫描实际读取的文件数'],
      ['命中文件数', s.hitFiles, 'obs', '扫描中命中规则的文件数'],
      ['命中词处数', s.totalHits, 'obs', '全部命中位置的总和'],
      ['平均命中占比', fmtRatio(scanArchiveRatio()), 'der', '全部命中文件按文件加权的平均占比，回答这批文件整体有多涉密'],
      ['文件数上限', s.maxFiles, 'obs', '本次扫描的设置值'],
      ['最大深度', s.maxDepth],
      ['跳过系统目录', s.skipSys ? '是' : '否'],
      ['结果完整', s.truncated ? '否（已达上限）' : '是', 'der', '与文件数上限比较得出'],
      ['读取失败', s.errors || 0, 'obs', '无法读取或解析的文件数'],
      ['扫描复核意见', s.review || scanReviewNote || '（未填写）', 'inf', '检查人对本次扫描结论的人工判断'],
      ['文件名未匹配', s.nameSkipped || 0, 'obs', '文件名不含指定关键字，未读取直接跳过'],
      ['结构化复核', reviewListText() || '（未填写）', 'inf', '复核清单逐项勾选的结论，v4.8']
    ];
    if (s.fromReport) {
      rows.splice(4, 0,
        ['检查软件报告命中', s.checkerHits || 0],
        ['复检误报（本工具 0 命中）', s.falsePos || 0]);
    }
    return rows;
  }

  /** 导出扫描报告 CSV（UTF-8 BOM + CRLF，Excel 可直接打开） */
  /** v3.6 导出 HTML 检查报告：A4 单页，可打印成 PDF 给合规 / 审计 */
  function exportScanReportHtml() {
    if (!state.lastScan || !state.scanArchive.length) { log('还没有可导出的扫描结果', 'warn'); return; }
    // 直接取 scanArchive 原始行：matched 是数组（scanReportRows() 已 join 成字符串，给 CSV 用）
    var rows = state.scanArchive.map(function (r) {
      return { file: r.path, hits: r.hits, matched: r.matched || [], status: r.checked ? (r.hits ? 'hit' : 'clean') : 'pending', ratio: fmtRatio(r.ratio) };
    });
    var s0 = state.lastScan;
    var concl = '本次扫描按当前词库检查了 ' + s0.scanned + ' 个文件，其中 ' + s0.hitFiles + ' 个命中、共 ' + s0.totalHits + ' 处。';
    concl += s0.hitFiles ? '建议勾选命中文件后点「一键处理选中」清理，或导出本报告留档。' : '未发现敏感词；重要文件仍建议人工复核后分发。';
    // v3.9 动态局限：只把本次真实发生的情况写进报告（参照 REA 的 truncation()）
    var extraLimits = [];
    if (s0.truncated) extraLimits.push('本次扫描已达到文件数上限（' + s0.maxFiles + '），未检查的文件不在本报告内。');
    if (s0.errors) extraLimits.push('有 ' + s0.errors + ' 个文件读取失败，其内容未纳入本次检查。');
    if (s0.skipSys) extraLimits.push('已跳过系统与依赖文件夹（如 node_modules、.git），其中的文件未检查。');
    var steps = [
      '按当前词库对文件全文做归一化匹配（剔除零宽字符、折叠全角与空格、容忍符号插字与繁体写法）。',
      'Word / Excel / PPT 直接改写内部 XML，覆盖正文、页眉页脚、脚注批注、文本框与元数据。',
      '按「' + scopeLabel(checkedVal('scope')) + '」范围处理，再按全文复查一遍范围外的残留。',
      '逐文件统计命中处数与命中词，汇总成本报告。'
    ];
    var html = DWRReportHtml.build({
      title: '文档敏感词扫描报告',
      generatedAt: tsName(),
      conclusion: concl,
      summary: scanSummary(),
      rows: rows,
      cols: [
        { k: 'file', label: '文件路径' },
        { k: 'ratio', label: '命中占比', width: '70px' },
        { k: 'hits', label: '命中处数', width: '70px' },
        { k: 'matched', label: '命中词' },
        { k: 'status', label: '状态', width: '80px' }
      ],
      steps: steps,
      extraLimits: extraLimits,
      review: s0.review || scanReviewNote,
      reviewList: reviewListText(),
      note: '本报告由本地工具生成，数据未离开本机；「命中」为按当前词库复检的结果。'
    });
    download(new Blob([html], { type: 'text/html' }), '扫描报告_' + tsName() + '.html');
    log('已导出 HTML 扫描报告（' + rows.length + ' 个命中文件，可用浏览器打印成 PDF）', 'ok');
  }

  /** v3.6 清除记录的 HTML 版 */
  function exportCleanReportHtml() {
    var run = state.lastRun;
    if (!run) { log('还没有可导出的处理记录', 'warn'); return; }
    var rows = state.files.map(function (f) {
      return { file: f.path, hits: f.status === 'done' ? (f.hits || 0) : 0, matched: f.matched || [], status: f.status };
    });
    var html = DWRReportHtml.build({
      title: '文档敏感词清除报告',
      generatedAt: run.time,
      conclusion: '本次处理 ' + run.total + ' 个文件，修改 ' + run.changed + ' 个，共清除敏感词 ' + run.hits + ' 处。' + (run.changed ? '已按所选输出方式交付，可人工复核后分发。' : '未发现需要修改的内容。'),
      summary: [
        ['文件总数', run.total, 'obs', '本次加入处理的文件数'],
        ['修改文件数', run.changed, 'obs', '内容发生变化的文件数'],
        ['清除敏感词处数', run.hits, 'obs', '全部命中位置的总和'],
        ['启用规则数', run.rules, 'obs', '本次生效的词条数（停用的不计）'],
        ['作用范围', run.scope, 'obs', '本次处理的设置值'],
        ['命中后处理', run.action, 'obs', '本次处理的设置值'],
        ['输出方式', run.out, 'obs', '本次处理的设置值']
      ],
      rows: rows,
      steps: [
        '按当前词库对文件全文做归一化匹配（剔除零宽字符、折叠全角与空格、容忍符号插字与繁体写法）。',
        'Word / Excel / PPT 直接改写内部 XML，覆盖正文、页眉页脚、脚注批注、文本框与元数据。',
        '按「' + run.scope + '」范围处理，命中后' + run.action + '，再按全文复查一遍范围外的残留。',
        '逐文件统计清除处数，汇总成本报告。'
      ],
      review: run.review || reviewNote,
      note: '本报告由本地工具生成，数据未离开本机。'
    });
    download(new Blob([html], { type: 'text/html' }), '清除报告_' + tsName() + '.html');
    log('已导出 HTML 清除报告（' + rows.length + ' 个文件，可用浏览器打印成 PDF）', 'ok');
  }

  /** v4.0 复核意见输入绑定：任何改动立即生效（导出时才读取） */
  /** v4.3 格式筛选：预设切换时显隐自定义输入，改动即生效并记住 */
  function syncExtPresetUi() {
    var preset = $('scanExtPreset');
    var wrap = $('scanExtCustomWrap');
    if (wrap) wrap.style.display = (preset && preset.value === 'custom') ? 'block' : 'none';
  }

  function bindExtFilter() {
    var preset = $('scanExtPreset');
    if (preset) {
      syncExtPresetUi();
      preset.addEventListener('change', function () {
        syncExtPresetUi();
        applyExtFilter();
        saveSettings();
        var n = Doc.getExtFilter ? Doc.getExtFilter() : null;
        log('文件格式：' + (n ? '自定义 ' + n.length + ' 种（' + n.join('、') + '）' : '全部支持格式'), 'info');
      });
    }
    var cust = $('scanExtCustom');
    if (cust) cust.addEventListener('input', function () { applyExtFilter(); saveSettings(); });
    // v4.10 文件名关键字：改动即存，不即时生效（下一轮扫描才用）
    var nw = $('scanNameWords');
    if (nw) nw.addEventListener('input', function () { saveSettings(); });
    var nm = $('scanNameMode');
    if (nm) nm.addEventListener('change', function () { saveSettings(); });
  }

  /* v4.8 结构化复核清单：把常见人工检查项改造成文档脱敏场景。
     早期只做到自由文本复核框，
     没有清单——复核人不知道该看什么，结论也没法结构化沉淀。这里补上。
     三项一态：符合 / 不符合 / 不适用。默认全不选，不猜用户的结论。 */
  var REVIEW_ITEMS = [
    { id: 'marked', text: '所有待外发文件已准确标明密级', tip: '密级标识缺失或错误的文件不应外发' },
    { id: 'no-over', text: '未发现高于本机定密级的涉密信息', tip: '发现越级存储应停止外发并上报' },
    { id: 'no-unrelated', text: '不存在与工作无关的文档与资料', tip: '私人文件混入外发包是常见泄露源' },
    { id: 'no-fp', text: '扫描结果中的误报已逐条确认', tip: '机器按词命中，是否真涉密要人看；可在左侧调整词库和排除条件' },
    { id: 'no-residue', text: '处理后已复检无敏感词残留', tip: '处理完成不等于清干净；建议用「清除后自检」或重新扫描确认' },
    { id: 'scope-ok', text: '处理范围（仅首尾 / 全文）符合本次外发要求', tip: '默认只清首行尾行；中段密级标识会留下，对外发布建议选全文' },
    { id: 'vba-ok', text: '含宏文档已单独确认处理方式', tip: '宏里的文本本工具不改；含 VBA 的文档需人工用 Office 打开处理' },
    { id: 'sign-ok', text: '外发清单已由责任人签字确认', tip: '留档需要；签字信息写进导出报告的复核结论' }
  ];
  var reviewChecks = {};   // id -> 'ok' | 'bad' | 'na'

  function renderReviewList() {
    var box = $('reviewList');
    if (!box) return;
    var html = REVIEW_ITEMS.map(function (it) {
      var cur = reviewChecks[it.id] || '';
      function opt(v, label) {
        return '<label class="rv-opt' + (cur === v ? ' on' : '') + '" data-tip="' + escapeHtml(it.tip) + '">'
          + '<input type="radio" name="rv_' + it.id + '" value="' + v + '"' + (cur === v ? ' checked' : '')
            + ' aria-label="' + escapeHtml(it.text) + '：' + label + '">'
          + '<span>' + label + '</span></label>';
      }
      return '<li class="rv-item" role="group" aria-label="' + escapeHtml(it.text) + '">'
        + '<span class="rv-text">' + escapeHtml(it.text) + '</span>'
        + '<span class="rv-opts" role="radiogroup" aria-label="' + escapeHtml(it.text) + '">'
          + opt('ok', '符合') + opt('bad', '不符合') + opt('na', '不适用') + '</span></li>';
    }).join('');
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('input[type=radio]'), function (r) {
      r.addEventListener('change', function () {
        reviewChecks[r.name.slice(3)] = r.value;
        renderReviewList();
        syncReviewStat();
      });
    });
  }

  function syncReviewStat() {
    var el = $('reviewListStat');
    if (!el) return;
    var done = Object.keys(reviewChecks).length;
    var bad = Object.keys(reviewChecks).filter(function (k) { return reviewChecks[k] === 'bad'; }).length;
    if (!done) { el.textContent = '尚未勾选'; el.className = 'hint'; return; }
    el.textContent = '已确认 ' + done + ' / ' + REVIEW_ITEMS.length + ' 项' + (bad ? '，其中 ' + bad + ' 项不符合' : '');
    el.className = 'hint' + (bad ? ' warn' : '');
  }

  /** 复核清单的结构化结论，供导出报告拼一段 */
  function reviewListText() {
    var done = Object.keys(reviewChecks);
    if (!done.length) return '';
    var LABEL = { ok: '符合', bad: '不符合', na: '不适用' };
    return REVIEW_ITEMS.filter(function (it) { return reviewChecks[it.id]; })
      .map(function (it) { return it.text + '：' + LABEL[reviewChecks[it.id]]; }).join('；');
  }

  function bindReviewList() {
    var btn = $('reviewListBtn');
    var panel = $('reviewListPanel');
    if (btn && panel) {
      btn.addEventListener('click', function () {
        var open = panel.hidden;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = open ? '复核清单 ▴' : '复核清单 ▾';
        if (open) renderReviewList();
      });
    }
    var rst = $('reviewListReset');
    if (rst) rst.addEventListener('click', function () {
      reviewChecks = {};
      renderReviewList();
      syncReviewStat();
      log('已清空复核清单勾选', 'info');
    });
  }
  function bindReviewNote() {
    var el = $('reviewNote');
    if (el) {
      reviewNote = (el.value || '').trim();
      el.addEventListener('input', function () { reviewNote = (el.value || '').trim(); });
    }
    var sel = $('scanReviewNote');
    if (sel) {
      sel.addEventListener('input', function () { scanReviewNote = (sel.value || '').trim(); });
    }
  }

  /** 扫描复核输入框的显隐：有扫描结果时才出现 */
  function syncScanReviewRow() {
    var row = $('scanReviewRow');
    if (row) row.style.display = state.lastScan ? 'flex' : 'none';
  }
  function exportScanReport() {
    if (!state.lastScan || !state.scanArchive.length) { log('还没有可导出的扫描结果', 'warn'); return; }
    var rows = scanReportRows();
    var csv = String.fromCharCode(0xfeff) + buildScanReportCsv(scanSummary(), rows);
    download(new Blob([csv], { type: 'text/csv' }), '扫描报告_' + tsName() + '.csv');
    log('已导出扫描报告（' + rows.length + ' 个命中文件，共 ' + state.lastScan.totalHits + ' 处）', 'ok');
  }

  /** 导出扫描报告 JSON（供归档 / 二次开发） */
  function exportScanReportJson() {
    if (!state.lastScan || !state.scanArchive.length) { log('还没有可导出的扫描结果', 'warn'); return; }
    var json = buildScanReportJson(scanSummary(), scanReportRows());
    download(new Blob([json], { type: 'application/json' }), '扫描报告_' + tsName() + '.json');
    log('已导出扫描报告 JSON', 'ok');
  }

  function removeSelectedScan() {
    var n = state.scanResults.filter(function (r) { return r.selected; }).length;
    if (!n) return;
    state.scanResults = state.scanResults.filter(function (r) { return !r.selected; });
    state.scanArchive = state.scanArchive.filter(function (r) { return !r.selected; });
    // 行索引已失效：预览指向复位，避免高亮错行
    scanTableChanged(true);
    // 删除后扫描记录可能已空：报告按钮必须跟着复位，否则点下去只会得到"还没有可导出的扫描结果"
    updateScanReportBtn();
    log('已从扫描结果中移除 ' + n + ' 项。', 'info');
  }

  /* ---------------- 一键批量：处理 / 删除扫描命中的文件 ---------------- */

  /** 申请目录读写权限：扫描默认只读，写回 / 删除需显式授权（File System Access API） */
  async function ensureDirWritable(dirHandle) {
    if (!dirHandle) return false;
    try {
      if (dirHandle.queryPermission) {
        var q = await dirHandle.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') return true;
      }
      if (dirHandle.requestPermission) {
        var r = await dirHandle.requestPermission({ mode: 'readwrite' });
        return r === 'granted';
      }
    } catch (e) { /* 权限被拒或 API 受限 */ }
    return false;
  }

  /** 唯一化目录句柄数组：Object 以字符串做键会把句柄都折叠成同一个 */
  function uniqueDirs(rows) {
    var out = [];
    rows.forEach(function (r) { if (r.dir && out.indexOf(r.dir) < 0) out.push(r.dir); });
    return out;
  }

  /** 当前勾选、且带目录 / 文件句柄（来自「扫描文件夹」）的命中行 */
  function selectedScanTargets() {
    return state.scanResults.filter(function (r) { return r.selected && r.handle; });
  }

  /** 一键处理选中：清理命中文档并写回原位置（默认先备份 .bak，受「输出方式 · 备份」开关控制） */
  async function batchCleanSelected() {
    if (!notScanning()) return;
    if (!ensureRules()) return;
    var targets = selectedScanTargets();
    if (!targets.length) { log('请先勾选要处理的命中文件', 'warn'); return; }

    var dirs = uniqueDirs(targets);
    var granted = 0;
    for (var i = 0; i < dirs.length; i++) {
      if (await ensureDirWritable(dirs[i])) granted++;
    }
    if (!granted) { log('未获得目标文件夹的写入权限，已取消一键处理', 'err'); return; }

    if (typeof confirm === 'function') {
      var okc = confirm('将清理并覆盖写入 ' + targets.length + ' 个命中文档。\n'
        + '\n默认会先备份为 .bak（可在「输出方式」中关闭）。原文件所在文件夹需可写。\n确定继续吗？');
      if (!okc) { log('已取消一键处理', 'warn'); return; }
    }

    var engine = buildEngine();
    var backup = $('backup') ? $('backup').checked : true;
    // 对外交付时 .bak 反而会把敏感原文留在原地，所以允许一键清理；
    // 清掉备份之后就没有可撤销的原文，这类文件不再写进撤销批次。
    var purgeBak = backup && $('deleteBak') ? $('deleteBak').checked : false;
    var verifyOn = verifyEnabled();
    var verifyEngine = verifyOn ? buildVerifyEngine() : null;
    var batchResidue = { fixed: 0, remain: 0, warned: 0 };

    var cleaned = 0, skipped = 0, failed = 0, totalHits = 0, purgedBak = 0;
    var renamedCount = 0, removedThumbCount = 0;
    var doneRows = [];
    var undoBatch = [];
    await mapPool(targets, getConc(), function (r) {
      return Promise.resolve().then(function () {
        return processOne({ file: r.file, path: r.path, size: r.size, supported: true }, engine);
      }).then(function (res) {
        if (res.error) { failed++; log('跳过（' + res.error + '）：' + r.path, 'warn'); return null; }
        if (!res.changed) { skipped++; return null; }
        return (async function () {
          if (verifyOn && res.bytes) {
            res.bytes = await selfCheckAndFix(r.path, res.bytes, verifyEngine, batchResidue);
          }
          var bakName = null;
          if (backup && r.dir && r.name) {
            try { bakName = await backupOriginal(r.dir, r.name, r.file); }
            catch (e) {
              // 备份没落地就覆盖，等于把唯一一份文档押在一次 createWritable 上：
              // 磁盘满、只读目录、权限过期都会走到这里，必须停手保留原文件。
              failed++;
              log('备份失败，已保留原文件：' + r.path + ' — ' + (e.message || e), 'err');
              return null;
            }
          }
          // 目录级 readwrite 授权应已覆盖子文件；个别浏览器仍要求 file-handle 级授权，这里尽力再授一次（失败不阻断）
          try { if (r.handle.requestPermission) await r.handle.requestPermission({ mode: 'readwrite' }); } catch (e0) { /* 目录授权已够用 */ }
          var w = await r.handle.createWritable();
          await w.write(res.bytes);
          await w.close();
          cleaned++; totalHits += (res.hits || 0);
          if (purgeBak && bakName && r.dir) {
            try {
              await r.dir.removeEntry(bakName);
              purgedBak++;
            } catch (eP) {
              // 备份删不掉时保留撤销能力，并明确告诉用户敏感原文还在
              undoBatch.push({ path: r.path, size: res.bytes.length, bak: bakName });
              log('备份未能删除（仍可用「撤销」还原）：' + r.path + ' — ' + (eP.message || eP), 'warn');
            }
          } else {
            undoBatch.push({ path: r.path, size: res.bytes.length, bak: bakName });
          }
          if (res.renamed && res.renamed.length) renamedCount += res.renamed.length;
          if (res.removed && res.removed.length) removedThumbCount += res.removed.length;
          doneRows.push(r);
          log('已清理并写回：' + r.path + '（清除 ' + (res.hits || 0) + ' 处）', 'ok');
        })().catch(function (e) {
          failed++;
          log('写回失败：' + r.path + ' — ' + (e.message || e), 'err');
        });
      });
    });

    // 只把本次真正清理成功的行移出表格（失败 / 未变化的行保留，供用户复查）。
    // 行对象不能当对象键用：会全部塌缩成 "[object Object]"，把整张表清空
    if (doneRows.length) {
      state.scanResults = state.scanResults.filter(function (r) { return doneRows.indexOf(r) < 0; });
    }
    scanTableChanged(true);
    if (batchResidue.fixed) log('自检兜底清理：共补清 ' + batchResidue.fixed + ' 处首尾范围未覆盖的残留。', 'ok');
    if (batchResidue.remain) log('自检提示：' + batchResidue.warned + ' 个文件仍有 ' + batchResidue.remain
      + ' 处疑似残留，请人工复核后再分发。', 'warn');
    if (renamedCount) log('结构清理：重命名 ' + renamedCount + ' 个含敏感词的包内条目（条目名对外部保密检查软件可见）。', 'ok');
    if (removedThumbCount) log('结构清理：移除 ' + removedThumbCount + ' 个缩略图（首页渲染图可能带出敏感内容）。', 'ok');
    if (cleaned && backup) {
      if (purgedBak) log('已删除 ' + purgedBak + ' 份 .bak 备份（备份里是含敏感词的原文，对外交付建议保持删除）。', 'ok');
      if (purgedBak < cleaned) log('注意：还有 ' + (cleaned - purgedBak) + ' 份 .bak 备份保留着清理前的原文（含敏感词），若目标是让保密检查软件完全查不到，请确认后手动删除。', 'warn');
    }
    if (undoBatch.length && global.DWRUndo) {
      DWRUndo.record(undoBatch);
      refreshUndoBtn();
    }
    log('一键处理完成：清理 ' + cleaned + ' 个、未变化 ' + skipped + ' 个、失败 ' + failed + ' 个，共清除 ' + totalHits + ' 处。', cleaned ? 'ok' : 'warn');

  }


  /* ---------------- v3.4 一键撤销（把 .bak 写回原路径） ---------------- */

  function refreshUndoBtn() {
    var btn = $('undoBtn');
    if (!btn || !global.DWRUndo) return;
    var b = DWRUndo.latest();
    if (!b) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = '\u21b6 撤销上次处理（' + b.count + ' 个文件）';
  }

  /**
   * 撤销最近一批原地覆盖：按记录的路径与备份名把内容写回原文件。
   * 记录里存的是本次实际写入的备份名（同文件重复处理时是 .bak.2 这类后续槽位），
   * 老记录没有这个字段，退回 name + '.bak'。定位不到目录的行记失败，不阻断其他行。
   */
  async function undoLastRun() {
    var U = global.DWRUndo;
    if (!U) { log('当前环境不支持撤销', 'err'); return; }
    var batch = U.latest();
    if (!batch) { log('没有可撤销的处理记录', 'warn'); return; }
    if (state.running) { log('正在处理中，请等本次处理结束后再撤销', 'warn'); return; }
    if (typeof confirm === 'function') {
      var ok = confirm('将把 ' + batch.count + ' 个文件还原到处理前（取自同目录 .bak 备份）。\n'
        + '处理时间：' + U.fmtTime(batch.at) + '\n\n确定撤销吗？');
      if (!ok) return;
    }

    var ok = 0, failed = 0, noBak = 0;
    for (var i = 0; i < batch.items.length; i++) {
      var it = batch.items[i];
      try {
        var parts = it.path.split('/');
        var name = parts.pop();
        var bakName = it.bak || (name + '.bak');
        var dir = await undoTargetDir(parts);
        if (!dir) {
          failed++;
          log('还原失败：定位不到 ' + it.path + ' 所在的目录', 'err');
          continue;
        }
        var fh;
        try {
          fh = await dir.getFileHandle(bakName);
        } catch (e0) { noBak++; log('找不到备份：' + bakName, 'warn'); continue; }
        var f = await fh.getFile();
        var bytes = await f.arrayBuffer();
        var target = await dir.getFileHandle(name, { create: true });
        var w = await target.createWritable();
        await w.write(bytes);
        await w.close();
        ok++;
      } catch (e) {
        failed++;
        log('还原失败：' + it.path + ' \u2014 ' + (e.message || e), 'err');
      }
    }
    U.dropLatest();
    refreshUndoBtn();
    log('撤销完成：还原 ' + ok + ' 个'
      + (noBak ? '、无备份 ' + noBak + ' 个' : '')
      + (failed ? '、失败 ' + failed + ' 个' : '') + '。', ok ? 'ok' : 'warn');
  }

  /**
   * 定位撤销目标所在目录：复用扫描 / 输出时记住的根句柄，取不到则请用户选一次，
   * 再按记录的路径逐级进入。层级必须走完——只在根上找会把备份读成根目录的同名文件，
   * 原地覆盖的子目录文档就还原不回自身路径（v4.69 前正是如此）。
   */
  async function undoTargetDir(parts) {
    var dir = await dirCacheGet(SCAN_ROOT_KEY) || await dirCacheGet(OUT_DIR_KEY);
    if (!dir) {
      var pk = await pickDir('', { mode: 'readwrite' });
      dir = pk && pk.handle;
    }
    if (!dir) return null;
    for (var i = 0; i < parts.length; i++) {
      try { dir = await dir.getDirectoryHandle(parts[i]); } catch (e) { return null; }
    }
    return dir;
  }
  /** 一键删除选中：从磁盘彻底删除命中文档（含关键词藏在隐藏部位的文档），不可恢复 */
  async function batchDeleteSelected() {
    if (!notScanning()) return;
    var targets = selectedScanTargets();
    if (!targets.length) { log('请先勾选要删除的命中文件', 'warn'); return; }

    var dirs = uniqueDirs(targets);
    var granted = false;
    for (var i = 0; i < dirs.length; i++) {
      if (await ensureDirWritable(dirs[i])) granted = true;
    }
    if (!granted) { log('未获得目标文件夹的写入权限，无法删除', 'err'); return; }

    var names = targets.slice(0, 8).map(function (r) { return r.name || r.path; });
    var more = targets.length > names.length ? '…等共 ' + targets.length + ' 个' : '共 ' + targets.length + ' 个';
    if (typeof confirm === 'function') {
      var okd = confirm('将从磁盘彻底删除 ' + targets.length + ' 个命中文档，不可恢复！\n'
        + '删除：' + names.join('、') + '（' + more + '）\n建议先「导出扫描报告」备份清单。确定删除吗？');
      if (!okd) { log('已取消一键删除', 'warn'); return; }
    }

    var deleted = 0, failed = 0;
    await mapPool(targets, getConc(), function (r) {
      return Promise.resolve().then(async function () {
        if (!r.dir || !r.name) { failed++; return; }
        await r.dir.removeEntry(r.name);
        deleted++; r.deleted = true;
      }).catch(function (e) {
        failed++;
        log('删除失败：' + r.path + ' — ' + (e.message || e), 'err');
      });
    });

    state.scanResults = state.scanResults.filter(function (r) { return !r.deleted; });
    state.scanArchive = state.scanArchive.filter(function (r) { return !r.deleted; });
    scanTableChanged(true);
    log('一键删除完成：已从磁盘删除 ' + deleted + ' 个，失败 ' + failed + ' 个。', deleted ? 'ok' : 'warn');
  }

  /* ---------------- 清除后自检（防外部保密检查软件检出残留） ---------------- */

  /** 自检引擎：规则与当前词库一致，范围固定「全文」——外部保密检查软件不会只查首尾行 */
  function buildVerifyEngine() {
    var cfg = buildConfig();
    cfg.scope = 'all';
    return Rules.createEngine(cfg);
  }

  /** 自检开关；元素缺失（旧页面 / 测试桩）时按开启处理 */
  function verifyEnabled() {
    var el = $('verifyAfter');
    return el ? !!el.checked : true;
  }

  /**
   * 残留自检：命中即意味着外部保密检查软件同样能查到
   * @returns {Promise<Object|null>} null 表示自检不可用
   */
  function verifyOutput(bytes, engine) {
    if (!bytes || !bytes.length || !engine || !Doc.verifyBytes) return Promise.resolve(null);
    try {
      return Doc.verifyBytes(bytes, engine).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /** 文件名本身含敏感词：外部检查工具常把文件名一并纳入检索 */
  function nameResidue(name, engine) {
    if (!name || !engine) return { hits: 0, matched: [] };
    try { return engine.scan(String(name).split(/[\\/]/).pop(), true, true); }
    catch (e) { return { hits: 0, matched: [] }; }
  }

  /** 兜底清理：按全文范围再清一次，把「首尾范围没覆盖到」的残留补掉 */
  function fallbackClean(bytes, engine) {
    return Promise.resolve().then(function () {
      if (bytes[0] === 0x50 && bytes[1] === 0x4b && Doc.processOffice) {
        var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return Doc.processOffice(ab, engine).then(function (res) {
          if (!res.touched || !res.blob) return bytes;
          return res.blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
        }, function () { return bytes; });
      }
      var dec = Doc.decodeText(bytes);
      var r = Doc.processText(dec.text, engine, dec.encoding);
      if (!r.touched) return bytes;
      return Doc.encodeText(r.text, dec.bom, dec.encoding);
    });
  }

  /** 残留明细：命中的部件名拼成一行，便于定位 */
  function partsLabel(res) {
    if (!res || !res.parts || !res.parts.length) return '';
    return res.parts.slice(0, 4).map(function (p) { return p.name + '(' + p.hits + ')'; }).join('、')
      + (res.parts.length > 4 ? ' 等 ' + res.parts.length + ' 个部件' : '');
  }

  /**
   * 自检 + 兜底清理：返回最终应写出的字节
   * @param {{fixed:number, remain:number, warned:number}} stats 累计计数
   */
  async function selfCheckAndFix(label, bytes, engine, stats) {
    if (!bytes || !bytes.length || !engine) return bytes;
    var nm = nameResidue(label, engine);
    if (nm.hits) {
      stats.remain += nm.hits; stats.warned++;
      log('文件名含敏感词：' + label + '（' + nm.matched.join('、') + '），外部检查工具可能据此命中，建议重命名后再分发。', 'warn');
    }
    var first;
    try { first = await verifyOutput(bytes, engine); } catch (e) { return bytes; }
    if (!first || !first.hits) return bytes;
    log('自检发现残留：' + label + ' 仍有 ' + first.hits + ' 处（' + (first.matched || []).join('、') + '）'
      + (partsLabel(first) ? ' → ' + partsLabel(first) : '') + '，正在按全文范围兜底清理…', 'warn');
    var fixed = await fallbackClean(bytes, engine);
    var after = null;
    if (fixed !== bytes) {
      try { after = await verifyOutput(fixed, engine); } catch (e) { after = null; }
    }
    if (after && !after.hits) {
      stats.fixed += first.hits;
      log('兜底清理完成：' + label + ' 已无残留（补清 ' + first.hits + ' 处）。', 'ok');
      return fixed;
    }
    var left = after || first;
    stats.remain += left.hits; stats.warned++;
    log('自检仍发现残留：' + label + ' ' + left.hits + ' 处'
      + (partsLabel(left) ? '（' + partsLabel(left) + '）' : '')
      + '——这些位置无法自动清除，请人工复核（常见于嵌入对象 / 宏 / 图片文字）。', 'err');
    return fixed;
  }

  /** 复检扫描结果：只读，报告哪些文件在「全文 + 全部部件」口径下仍有残留 */
  async function verifyScanSelected() {
    if (!notScanning()) return;
    if (!ensureRules()) return;
    var targets = selectedScanTargets();
    if (!targets.length) { log('请先勾选要复检的文件', 'warn'); return; }
    var engine = buildVerifyEngine();
    log('开始复检 ' + targets.length + ' 个文件（全文口径，含嵌入对象 / 文件名）…', 'info');
    var clean = 0, dirty = 0, failed = 0, remain = 0;
    await mapPool(targets, getConc(), function (r) {
      return Promise.resolve().then(async function () {
        var bytes = new Uint8Array(await r.file.arrayBuffer());
        var res = await verifyOutput(bytes, engine);
        var nm = nameResidue(r.path, engine);
        if (!res) { failed++; return; }
        if (res.hits || nm.hits) {
          dirty++;
          remain += res.hits + nm.hits;
          r.residue = res.hits + nm.hits;
          if (res.hits) log('残留 ' + res.hits + ' 处：' + r.path + '（' + (res.matched || []).join('、') + '）'
            + (partsLabel(res) ? ' → ' + partsLabel(res) : ''), 'warn');
          if (nm.hits) log('文件名含敏感词：' + r.path + '（' + nm.matched.join('、') + '），建议重命名', 'warn');
        } else {
          clean++;
          r.residue = 0;
        }
      }).catch(function (e) { failed++; log('复检失败：' + r.path + ' — ' + (e.message || e), 'err'); });
    });
    renderScanResults();
    log('复检完成：' + clean + ' 个无残留，' + dirty + ' 个仍有残留（共 ' + remain + ' 处），失败 ' + failed + ' 个。',
      dirty ? 'warn' : 'ok');
  }  /* ---------------- 预览 ---------------- */

  function highlightLines(text, engine, maxLines) {
    var all = text.split('\n');
    // 首行 / 尾行（非空白）定位，与引擎的 firstlast 范围语义保持一致
    var firstIdx = -1, lastIdx = -1;
    for (var k = 0; k < all.length; k++) {
      if (all[k].replace(/\s/g, '') !== '') {
        if (firstIdx < 0) firstIdx = k;
        lastIdx = k;
      }
    }
    return highlightWith(all, firstIdx, lastIdx, engine, maxLines);
  }

  /**
   * 把抽取出来的 Office 文本按同一口径标注首 / 尾行再高亮。
   * 首 / 尾按「逐部件、逐块组」判定（idx.marks 由 extractPreview 与 previewProcess 输出），
   * 与真实处理 processXml 一致；高亮画的位置就是处理后栏清掉的位置。
   * 兼容旧调用：没有 marks 时退回 idx.firstIdx / lastIdx 的全局口径。
   */
  function highlightOffice(text, idx, engine, maxLines) {
    var all = String(text).split('\n');
    if (idx && idx.marks) {
      var out = all.slice(0, maxLines).map(function (line, i) {
        var mk = idx.marks[i];
        var r = engine.apply(line, !!(mk && mk.first), !!(mk && mk.last),
          function (m) { return MARK_START + m + MARK_END; });
        return escapeHtml(r.text).split(MARK_START).join('<mark>').split(MARK_END).join('</mark>');
      });
      if (all.length > maxLines) {
        out.push('<span class="pv-omit">… 已省略 ' + (all.length - maxLines) +
          ' 行（预览仅显示前 ' + maxLines + ' 行，处理不受影响）</span>');
      }
      return out.join('\n');
    }
    return highlightWith(all, idx ? idx.firstIdx : -1, idx ? idx.lastIdx : -1, engine, maxLines);
  }

  function highlightWith(all, firstIdx, lastIdx, engine, maxLines) {
    var out = all.slice(0, maxLines).map(function (line, i) {
      var r = engine.apply(line, i === firstIdx, i === lastIdx, function (m) { return MARK_START + m + MARK_END; });
      return escapeHtml(r.text)
        .split(MARK_START).join('<mark>')
        .split(MARK_END).join('</mark>');
    });
    // 原文栏也要带省略提示，否则与处理后栏行数不一致，用户会以为内容被改多了
    if (all.length > maxLines) {
      out.push('<span class="pv-omit">… 已省略 ' + (all.length - maxLines) +
        ' 行（预览仅显示前 ' + maxLines + ' 行，处理不受影响）</span>');
    }
    return out.join('\n');
  }

  /** 在预览标题处展示命中词徽章 */
  function renderPreviewHits(matched) {
    var box = $('previewHits');
    if (!box) return;
    box.innerHTML = '';
    (matched || []).forEach(function (m) {
      var s = document.createElement('span');
      s.className = 'kw';
      s.textContent = m;
      s.setAttribute('data-tip', '命中的敏感词：' + m);
      box.appendChild(s);
    });
  }

  function selectFile(id) {
    state.selectedId = id;
    // 预览来源切回文件列表：清掉扫描结果行的高亮
    var wasScanPreview = state.scanPreviewIdx >= 0;
    state.scanPreviewIdx = -1;
    renderTable();
    if (wasScanPreview && state.scanResults.length) renderScanResults();
    var it = state.files.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    setPreviewName(it.path);
    it.file.arrayBuffer().then(function (buf) {
      renderPreviewSource(it.path, buf);
    }).catch(function (e) {
      previewFailed(e);
    });
  }

  /** 预览面板标题行显示当前预览的文件路径 */
  function setPreviewName(path) {
    var pn = $('previewName');
    if (pn) { pn.textContent = path; pn.setAttribute('data-tip', path); }
  }

  function previewFailed(e) {
    $('previewOrig').textContent = '预览失败：' + (e.message || e);
    $('previewNew').textContent = '';
    var cb = $('copyResultBtn'); if (cb) cb.disabled = true;
  }

  /**
   * 从文件字节渲染「原文（命中高亮）/ 处理后」双栏预览。
   * 文件列表行与扫描结果行共用此路径，保证两处预览结果完全一致。
   */
  /* 预览只取前 PREVIEW_MAX 行：截断时必须说出来，
     否则用户看到的不完整原文 / 处理后文本会被误当成全文结果 */
  function previewBody(text) {
    var lines = String(text).split('\n');
    var body = lines.slice(0, PREVIEW_MAX).join('\n');
    if (lines.length > PREVIEW_MAX) {
      body += '\n… 已省略 ' + (lines.length - PREVIEW_MAX) + ' 行（预览仅显示前 ' +
        PREVIEW_MAX + ' 行，处理不受影响）';
    }
    return body;
  }

  function renderPreviewSource(path, buf) {
    $('previewOrig').textContent = '加载中…';
    $('previewNew').textContent = '';
    setPreviewNote('');
    var engine = buildEngine();
    // 「处理后检查残留」开启时，真实处理会对首尾范围之外的残留按全文再清一遍（自检兜底）。
    // 预览必须按同一口径渲染，否则用户看到「中段保留」、写出的文件里中段却已被清掉。
    var engineAll = (verifyEnabled() && checkedVal('scope') !== 'all') ? buildVerifyEngine() : null;
    if (Doc.isTextFile(path)) {
      var dec = Doc.decodeText(buf);
      var res = Doc.processText(dec.text, engine);
      var effective = res, hlEngine = engine;
      if (engineAll) {
        var allRes = Doc.processText(dec.text, engineAll);
        if (allRes.hits > res.hits) { effective = allRes; hlEngine = engineAll; }
      }
      $('previewOrig').innerHTML = highlightLines(dec.text, hlEngine, PREVIEW_MAX);
      if ($('tidySpace').checked) effective.text = Rules.tidy(effective.text);
      var body = previewBody(effective.text);
      state.lastPreview = body;
      renderPreviewHits(effective.matched);
      previewNoteFor(effective !== res, res.hits, effective.hits);
      var cb1 = $('copyResultBtn'); if (cb1) cb1.disabled = false;
      $('previewNew').textContent = body ||
        '（已清除，无剩余内容）';
      return;
    }
    Doc.extractPreview(buf).then(function (ex) {
      var idx = Doc.previewProcess(ex.text, engine, ex.marks);
      var effective = idx, hlEngine = engine;
      if (engineAll) {
        var allIdx = Doc.previewProcess(ex.text, engineAll, ex.marks);
        if (allIdx.hits > idx.hits) { effective = allIdx; hlEngine = engineAll; }
      }
      $('previewOrig').innerHTML = highlightOffice(ex.text, effective, hlEngine, PREVIEW_MAX);
      var body = previewBody(effective.text);
      state.lastPreview = body;
      renderPreviewHits(effective.matched);
      previewNoteFor(effective !== idx, idx.hits, effective.hits);
      var cb2 = $('copyResultBtn'); if (cb2) cb2.disabled = false;
      $('previewNew').textContent = body ||
        '（已清除，无剩余内容）';
    }).catch(function (e) { previewFailed(e); });
  }

  /** 预览提示条：说明自检兜底把首尾范围之外的命中一并清了，下面的结果就是最终写出的内容 */
  function setPreviewNote(text) {
    var n = $('previewNote');
    if (!n) return;
    if (text) { n.textContent = text; n.hidden = false; }
    else { n.textContent = ''; n.hidden = true; }
  }
  function previewNoteFor(extended, scopeHits, effHits) {
    if (!extended) { setPreviewNote(''); return; }
    setPreviewNote('已开启「首尾范围外也清干净」：首尾范围外的 ' + (effHits - scopeHits) +
      ' 处命中会一并清除，下面显示的就是最终写出的内容。');
  }

  /** 范围 / 处理方式 / 自检开关变化后，按新设置重渲染当前预览，保证预览始终等于最终写出结果 */
  function refreshPreview() {
    var r = null;
    if (state.scanPreviewIdx >= 0) r = scanVisibleRows()[state.scanPreviewIdx];
    if (r && r.file) {
      r.file.arrayBuffer().then(function (b) { renderPreviewSource(r.path, b); })
        .catch(function () { /* 预览刷新失败不改动界面 */ });
      return;
    }
    if (state.selectedId != null) {
      var it = state.files.filter(function (x) { return x.id === state.selectedId; })[0];
      if (it) {
        it.file.arrayBuffer().then(function (b) { renderPreviewSource(it.path, b); })
          .catch(function () { /* 预览刷新失败不改动界面 */ });
        return;
      }
    }
    setPreviewNote('');
  }

  /**
   * 点击扫描结果行：直接用扫描时缓存的 File 渲染预览，
   * 不必先把文件加入处理列表——「看清再决定处理哪些」。
   */
  function selectScanResult(idx) {
    var r = scanVisibleRows()[idx];
    if (!r || !r.file) return;
    state.scanPreviewIdx = idx;
    renderScanResults();
    syncTaskUi();
    setPreviewName(r.path);
    // 扫描表可能很长，预览面板在表格下方：点行后把它带入视野
    var card = $('previewCard');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    r.file.arrayBuffer().then(function (buf) {
      renderPreviewSource(r.path, buf);
    }).catch(function (e) { previewFailed(e); });
  }

  /* ---------------- 处理 ---------------- */

  function processOne(item, engine, onProgress) {
    if (!item.supported) return Promise.resolve({ changed: false, bytes: null });
    if (item.size > MAX_FILE_BYTES) {
      return Promise.resolve({ changed: false, bytes: null, error: '文件过大已跳过' });
    }
    return item.file.arrayBuffer().then(function (buf) {
      if (Doc.isTextFile(item.path)) {
        var dec = Doc.decodeText(buf);
        var r = Doc.processText(dec.text, engine, dec.encoding);
        if ($('tidySpace').checked && r.touched) r.text = Rules.tidy(r.text);
        var bytes = r.touched ? Doc.encodeText(r.text, dec.bom, dec.encoding) : null;
        return { changed: r.touched, bytes: bytes, hits: r.hits, matched: r.matched, vba: false, thumb: false };
      }
      return Doc.processOffice(buf, engine, onProgress).then(function (res) {
        if (!res.touched) return { changed: false, bytes: null, hits: 0, vba: res.vba, thumb: res.thumb, renamed: [], removed: [] };
        return res.blob.arrayBuffer().then(function (ab) {
          return { changed: true, bytes: new Uint8Array(ab), hits: res.hits, matched: res.matched, vba: res.vba, thumb: res.thumb, renamed: res.renamed || [], removed: res.removed || [] };
        });
      });
    });
  }

  /* ---------------- Web Worker（避免大文件处理阻塞 UI） ---------------- */

  var _worker = null;
  var workerSeq = 0;
  var workerBroken = false;

  function getWorker() {
    if (workerBroken) return null;
    if (typeof Worker === 'undefined') return null;
    if (_worker) return _worker;
    try {
      _worker = new Worker('js/worker.js');
      _worker.onerror = function () {
        workerBroken = true;
        if (_worker) { try { _worker.terminate(); } catch (e) {} _worker = null; }
      };
      return _worker;
    } catch (e) { workerBroken = true; return null; }
  }

  /** 在 Worker 中处理单个文件；返回 null 表示不可用（由主线程兜底） */
  function processViaWorker(it, worker, config, onProgress) {
    return new Promise(function (resolve) {
      var id = ++workerSeq;
      var done = false;
      // 看门狗：并发场景下若 worker 中途异常/被终止，避免永久挂起
      var timer = setTimeout(function () { finish(null); }, 180000);
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { worker.removeEventListener('message', handler); } catch (e) {}
        resolve(v);
      }
      function handler(ev) {
        var m = ev.data;
        if (!m || m.id !== id) return;
        if (m.type === 'progress') { if (onProgress) onProgress(m.done, m.total); return; }
        if (m.type === 'error') {
          workerBroken = true;
          try { worker.terminate(); } catch (e) {}
          _worker = null;
          finish(null);
          return;
        }
        if (m.type === 'result') {
          finish({
            changed: m.changed,
            bytes: m.bytes ? new Uint8Array(m.bytes) : null,
            hits: m.hits,
            matched: m.matched || [],
            vba: !!m.vba,
            thumb: !!m.thumb,
            renamed: m.renamed || [],
            removed: m.removed || []
          });
        }
      }
      worker.addEventListener('message', handler);
      it.file.arrayBuffer().then(function (ab) {
        try {
          worker.postMessage({ type: 'process', id: id, name: it.path, buf: ab, config: config }, [ab]);
        } catch (e) {
          finish(null);
        }
      }).catch(function () { finish(null); });
    });
  }

  async function writeToFs(dirHandle, relPath, data) {
    var parts = relPath.split('/');
    var name = parts.pop();
    var d = dirHandle;
    for (var i = 0; i < parts.length; i++) {
      d = await d.getDirectoryHandle(parts[i], { create: true });
    }
    var fh = await d.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  /**
   * 备份覆盖前的原文，返回实际写入的备份名（调用方必须把它记进撤销账）。
   * 同目录已有 .bak 时不再静默跳过：跳过意味着第二批的「撤销」会把文件还原成
   * 上一批的旧内容，本批处理前的状态一份都没留下。改为往后追加序号，每批都保住自己
   * 处理前的原文，更早的备份也不被覆盖。
   */
  async function backupOriginal(dirHandle, relPath, file) {
    var parts = relPath.split('/');
    var name = parts.pop();
    var d = dirHandle;
    for (var i = 0; i < parts.length; i++) {
      d = await d.getDirectoryHandle(parts[i], { create: true });
    }
    var bakName = await freshBakName(d, name);
    var fh = await d.getFileHandle(bakName, { create: true });
    try {
      var w = await fh.createWritable();
      await w.write(file);
      await w.close();
    } catch (e) {
      // 写失败的半成品是个 0 字节的 .bak：既会占住备份槽位，也会被「撤销」当成可用备份
      try { await d.removeEntry(bakName); } catch (e2) { /* 清不掉也不能盖住原始错误 */ }
      throw e;
    }
    return bakName;
  }

  /** 取第一个空闲的备份槽：name.bak、name.bak.2、name.bak.3… */
  async function freshBakName(dirHandle, name) {
    var bakName = name + '.bak';
    for (var n = 2; n < 100; n++) {
      try { await dirHandle.getFileHandle(bakName); } catch (e) { return bakName; }
      bakName = name + '.bak.' + n;
    }
    // 前 99 个槽都被占（同一份文件被反复处理近百次）：退到时间戳，绝不复用已有备份名
    return name + '.bak.' + Date.now();
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 3000);
  }

  /** 处理完成后短暂高亮「导出报告」，把用户的注意力引到留档这一步 */
  function flashReportBtn() {
    var btn = $('reportBtn');
    if (!btn || btn.disabled) return;
    var orig = btn.className;
    btn.className = orig + ' flash';
    if (reportFlashTimer) clearTimeout(reportFlashTimer);
    reportFlashTimer = setTimeout(function () {
      btn.className = orig;
      reportFlashTimer = null;
    }, 2400);
  }

  /** 报告按钮只在有过处理记录时可用 */
  function updateReportBtn() {
    var btn = $('reportBtn');
    if (!btn) return;
    btn.disabled = !state.lastRun || !state.files.some(function (f) { return f.status === 'done'; });
    var jsonBtn = $('reportJsonBtn');
    if (jsonBtn) jsonBtn.disabled = btn.disabled;
    var htmlBtn = $('reportHtmlBtn');
    if (htmlBtn) htmlBtn.disabled = btn.disabled;
  }

  /** 导出清除报告：CSV（UTF-8 BOM + CRLF，Excel 可直接打开） */
  function exportCleanReport() {
    var run = state.lastRun;
    if (!run) { log('还没有可导出的处理记录', 'warn'); return; }
    var rows = state.files.map(function (f) {
      return {
        file: f.path,
        hits: f.status === 'done' ? (f.hits || 0) : 0,
        matched: f.matched || [],
        status: f.status,
        out: run.out
      };
    });
    var summary = [
      ['生成时间', run.time],
      ['文件总数', run.total],
      ['修改文件数', run.changed],
      ['清除敏感词处数', run.hits],
      ['启用规则数', run.rules],
      ['作用范围', run.scope],
      ['命中后处理', run.action],
      ['输出方式', run.out]
    ];
    if (run.review || reviewNote) summary.push(['复核意见', run.review || reviewNote]);
    // 带 BOM：Windows Excel 无 BOM 会乱码（与 scan.mjs 报告一致）
    var csv = String.fromCharCode(0xfeff) + buildCleanReportCsv(summary, rows);
    download(new Blob([csv], { type: 'text/csv' }), '清除报告_' + tsName() + '.csv');
    log('已导出清除报告（' + rows.length + ' 个文件，共 ' + run.hits + ' 处）', 'ok');
  }

  /** JSON 版报告（供归档 / 二次开发） */
  function exportCleanReportJson() {
    var run = state.lastRun;
    if (!run) { log('还没有可导出的处理记录', 'warn'); return; }
    var rows = state.files.map(function (f) {
      return { file: f.path, hits: f.status === 'done' ? (f.hits || 0) : 0, matched: f.matched || [], status: f.status, out: run.out };
    });
    var meta = [['生成时间', run.time], ['文件总数', run.total], ['修改文件数', run.changed], ['清除敏感词处数', run.hits], ['启用规则数', run.rules], ['作用范围', run.scope], ['命中后处理', run.action], ['输出方式', run.out]];
    if (run.review || reviewNote) meta.push(['复核意见', run.review || reviewNote]);
    var json = buildCleanReportJson(meta, rows);
    download(new Blob([json], { type: 'application/json' }), '清除报告_' + tsName() + '.json');
    log('已导出 JSON 报告', 'ok');
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) {
      log('复制失败：' + errMsg(e), 'err');
    }
  }

  /** v4.66 复制文本到剪贴板：优先异步 API，降级 execCommand。
   *   「复制结果」与「复制文件路径」共用同一出口，失败走 fallbackCopy 的日志。 */
  function copyTextToClipboard(text, done) {
    done = done || function () {};
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  /** 覆盖原文件且不备份的显式告警（原文会被不可逆改写） */
  function setOutDirInfo() {
    var mode = checkedVal('outmode');
    var warn = $('outDirWarn');
    if (!warn) return;
    var risky = mode === 'inplace' && $('backup') && !$('backup').checked;
    warn.hidden = !risky;
    warn.textContent = risky
      ? '将直接改写原文件，且不保留备份，原文无法恢复。'
      : '';
  }

  /** 页头滚动加深：滚动超过 1px 时给 .app-header 加 scrolled，回顶部撤掉。
     passive 监听不阻塞滚动；只在状态真正变化时写 class，避免无谓重排。 */
  function bindHeaderScroll() {
    var head = document.querySelector('.app-header');
    if (!head) return;
    var on = false;
    function sync() {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      var want = y > 1;
      if (want === on) return;
      on = want;
      if (head.classList && head.classList.toggle) head.classList.toggle('scrolled', want);
    }
    window.addEventListener('scroll', sync, { passive: true });
    sync();
  }

  function tsName() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  async function run() {
    if (state.running) return;
    if (!state.files.length) { log('请先添加文件', 'warn'); return; }
    if (!ensureRules()) return;
    // 选了「自定义」却没填文本：引擎会退化成直接删除。这是隐藏的行为变更，必须先说清
    if (checkedVal('action') === 'custom' && !(($('customText') && $('customText').value || '').trim())) {
      log('选了「自定义」但没填替换文本，将按直接删除处理；要替换请填写文本，要删除请选「删除」。', 'warn');
      return;
    }

    var outmode = checkedVal('outmode');
    // 「只处理命中项」：检查后只处理命中文档；若一个都没命中则提醒，避免空跑
    var onlyHit = !!($('onlyHit') && $('onlyHit').checked);
    if (onlyHit) {
      var hitCount = state.files.filter(function (x) { return x.status === 'hit' || x.status === 'done'; }).length;
      if (!hitCount) {
        log('当前没有检查到命中：请先点「检查文件」，或取消勾选「只处理命中项」。', 'warn');
        return;
      }
    }
    // 原地覆盖直接改写原文件，二次确认（自动 dialog 场景下默认放行）
    if (outmode === 'inplace' && typeof confirm === 'function') {
      var willChange = state.files.filter(function (x) { return x.supported && (!onlyHit || x.status === 'hit' || x.status === 'done'); }).length;
      if (!confirm('原地覆盖将直接修改 ' + willChange + ' 个文件（默认自动备份 .bak）。确定继续吗？')) {
        log('已取消原地覆盖处理', 'warn');
        return;
      }
    }
    if (outmode !== 'zip' && !('showDirectoryPicker' in global)) {
      log('「写入新目录 / 原地覆盖」需要支持目录选择的浏览器（Chrome / Edge / Chromium；Firefox 无此能力）。请改用「导出 ZIP」。', 'err');
      return;
    }
    // 输出目录也记住：上次用过的目录权限仍有效时零点击复用，否则才弹选择框
    if ((outmode === 'newfolder' || outmode === 'inplace') && !state.outDirHandle) {
      var pkOut = await pickDir(OUT_DIR_KEY, { mode: 'readwrite' });
      state.outDirHandle = pkOut.handle;
      if (!state.outDirHandle) {
        log('未选择输出目录，已取消', 'warn');
        return;
      }
      if (pkOut.reused) log('已复用上次的输出目录：' + (state.outDirHandle.name || '（目录）'), 'info');
      setOutDirInfo();
    }

    state.running = true;
    setButtons(true);
    var config = buildConfig();
    var engine = Rules.createEngine(config);
    var worker = getWorker();
    log('开始清除，规则引擎已就绪（' + engine.ruleCount + ' 条规则，范围：' + scopeLabel(engine.scope) +
      (worker ? '，后台线程处理中' : '，主线程处理中') + '）', 'info');
    log('提示：图片 / 截图 / 图表内文字、嵌入 OLE 对象、PDF 及旧版 Office 格式无法自动处理，请人工复核。', 'warn');

    var onlyChanged = $('onlyChanged').checked;
    // 勾选即处理范围：勾了文件只处理勾中的，一个都没勾时保持原来的全量语义。
    // 此前 checked 只影响「移出列表」，取消勾选后仍然全量处理，与选择条文案不符。
    // 必须在「未扫描提醒」之前算好——提醒要按真实处理范围统计，否则会把不处理的文件也算进来。
    var checkedCount = selectedIds().length;
    var scopeByChecked = checkedCount > 0;
    // 未扫描直接处理的提醒。默认走范围开关，靠自检兜底也能清干净，但用户看不到命中位置就
    // 动手容易漏判。只在「即将处理的文件里还有没预览过的」时提醒，不拦流程：重复处理、批量
    // 场景下拦下来反而碍事，「仅处理命中」与勾选已经能收窄范围。
    var unscannedCount = state.files.filter(function (x) {
      return x.supported && x.status === 'pending' && (!scopeByChecked || state.checked[x.id]);
    }).length;
    if (unscannedCount) {
      log('提示：本次要处理的文件里有 ' + unscannedCount + ' 个还没预览过命中位置，将直接按当前范围（' +
        scopeLabel(engine.scope) + '）清除。想先确认命中再动手，可先点「检查文件」。', 'warn');
    }
    // 清除后自检：外部保密检查软件按「全文 + 全部部件」检索，范围开关管不到它们看到的内容
    var verifyOn = verifyEnabled();
    var verifyEngine = verifyOn ? buildVerifyEngine() : null;
    var residueStats = { fixed: 0, remain: 0, warned: 0 };
    var outputs = [];

    var totalHits = 0;
    var changedCount = 0;
    // v3.5 命中词点击：事件委托（单元格是 innerHTML 渲染的，逐行绑会漏）
    var scanBodyEl = $('scanBody');
    if (scanBodyEl) scanBodyEl.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || t.className !== 'kw-btn') return;
      if (e.stopPropagation) e.stopPropagation();
      var w = t.getAttribute('data-word');
      if (!w) return;
      var allSel = scanVisibleRows().every(function (x) {
        return (x.matched || []).indexOf(w) >= 0 ? !!x.selected : true;
      });
      selectScanByWord(w, !allSel);
    });
    // v3.5 场景预设：选择即应用；手动改动任意选项时回到「自定义」
    var presetSel = $('presetSel');
    if (presetSel) {
      presetSel.addEventListener('change', function () {
        var k = presetSel.value;
        if (!k) return;
        if (!applyPreset(k)) { log('未知场景：' + k, 'err'); return; }
        syncTaskUi();
        log('提示：手动改动任意选项后，这里会显示「自定义」。', 'info');
      });
    }
    ['scope', 'action', 'outmode'].forEach(function (nm) {
      document.querySelectorAll('input[name="' + nm + '"]').forEach(function (el) {
        el.addEventListener('change', function () {
          if (presetSel) presetSel.value = '';
        });
      });
    });
    ['tidySpace', 'onlyChanged', 'backup', 'verifyAfter'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', function () {
        if (presetSel) presetSel.value = '';
      });
    });
    // v3.4 一键撤销：原地覆盖前记下写回过的路径，撤销时按这份清单把 .bak 写回
    var undoItems = [];
    var targets = state.files.filter(function (it) {
      if (scopeByChecked && !state.checked[it.id]) return false;
      if (onlyHit) return it.status === 'hit' || it.status === 'done';
      return true;
    });
    var n = targets.length;
    var warnVba = false;
    var renamedCount = 0, removedThumbCount = 0;

    log('处理概要：' + n + ' 个文件 · ' + engine.ruleCount + ' 条规则 · 范围「' + scopeLabel(engine.scope) +
      '」 · ' + ({ delete: '删除敏感词', mask: '智能打码（号码留头尾）', custom: '替换为「' + $('customText').value + '」' }[checkedVal('action')] || checkedVal('action')) +
      ' · 输出「' + ({ zip: '导出 ZIP', newfolder: '写入新目录', inplace: '原地覆盖' }[outmode] || outmode) + '」' +
      (scopeByChecked ? ' · 仅处理勾选的 ' + n + ' 个文件' : ''), 'info');

    var completed = 0;
    state.runCancel = false;
    var canceledRun = false;
    await mapPool(targets, getConc(), function (it) {
      return (async function () {
        if (state.runCancel) return; // 用户点了「停止处理」：不再启动新任务
        var onProg = function () {};
        try {
          var res;
          if (worker && !workerBroken) {
            res = await processViaWorker(it, worker, config, onProg);
          }
          if (!res || res.error) {
            res = await processOne(it, engine, onProg); // 主线程兜底
          }
          if (res.vba) warnVba = true;
          if (res.renamed && res.renamed.length) renamedCount += res.renamed.length;
          if (res.removed && res.removed.length) removedThumbCount += res.removed.length;
          if (res.error) {
            it.status = 'error';
            log('跳过（' + res.error + '）：' + it.path, 'warn');
            return;
          }
          if (!res.changed) {
            it.status = it.supported ? (it.status === 'hit' ? 'hit' : 'clean') : 'error';
            // 未命中但用户取消了「仅输出被修改的文件」：按原样输出，保持目标目录/ZIP 的完整性。
            // （原地覆盖模式下内容本就相同，无需重复写入。）
            if (!onlyChanged && outmode !== 'inplace' && it.supported) {
              try {
                var origBytes = new Uint8Array(await it.file.arrayBuffer());
                if (outmode === 'zip') outputs.push({ name: it.path, data: origBytes });
                else if (outmode === 'newfolder') await writeToFs(state.outDirHandle, it.path, origBytes);
              } catch (e) {
                log('原样输出失败：' + it.path + ' — ' + (e.message || e), 'err');
              }
            }
            return;
          }
          it.status = 'done';
          it.hits = res.hits;
          it.matched = res.matched || [];
          if (verifyOn && res.bytes) {
            res.bytes = await selfCheckAndFix(it.path, res.bytes, verifyEngine, residueStats);
          }
          if (outmode === 'zip') {
            if (!onlyChanged || res.changed) {
              outputs.push({ name: it.path, data: res.bytes });
            }
          } else if (outmode === 'newfolder') {
            if (!onlyChanged || res.changed) {
              await writeToFs(state.outDirHandle, it.path, res.bytes);
            }
          } else if (outmode === 'inplace') {
            var bakName = null;
            if ($('backup').checked) {
              try { bakName = await backupOriginal(state.outDirHandle, it.path, it.file); }
              catch (e) {
                // 同「一键处理」：备份没落地就绝不覆盖原文件
                throw new Error('备份失败，原文件未改动 — ' + (e.message || e));
              }
            }
            await writeToFs(state.outDirHandle, it.path, res.bytes);
            undoItems.push({ path: it.path, size: res.bytes.length, bak: bakName });
          }
          // 落到输出之后才计入「修改」：备份或写回失败的文件如果也算进去，
          // 汇总与导出报告会把没动过的文件说成已经处理完。
          totalHits += res.hits;
          changedCount++;
          if (changedCount % 10 === 0) {
            log('已处理 ' + changedCount + ' 个文件，累计清除 ' + totalHits + ' 处', 'info');
          }
        } catch (e) {
          it.status = 'error';
          it.error = e.message || '处理失败';
          log('处理失败：' + it.path + ' — ' + (e.message || e), 'err');
        } finally {
          completed++;
          updateProgress((completed / n) * 100, completed, n);
          tableRender.schedule();
        }
      })();
    });
    if (state.runCancel) canceledRun = true;
    tableRender.flush();

    updateProgress(100);
    // v3.4 一键撤销：本批原地覆盖的路径入账（只有真有写回才记，空批不入）
    if (undoItems.length && global.DWRUndo) {
      DWRUndo.record(undoItems);
      refreshUndoBtn();
    }
    if (residueStats.fixed) log('自检兜底清理：共补清 ' + residueStats.fixed + ' 处首尾范围未覆盖的残留。', 'ok');
    if (residueStats.remain) log('自检提示：' + residueStats.warned + ' 个文件仍有 ' + residueStats.remain
      + ' 处疑似残留，请人工复核后再分发。', 'warn');
    if (changedCount && outmode === 'inplace' && $('backup').checked) {
      log('注意：.bak 备份保留的是清理前的原文（含敏感词），若目标是让保密检查软件完全查不到，请确认后删除备份。', 'warn');
    }
    if (warnVba) log('注意：部分文档含 VBA 宏，宏内文本无法自动脱敏，请人工复核。', 'warn');
    if (renamedCount) log('结构清理：重命名 ' + renamedCount + ' 个含敏感词的包内条目（条目名对外部保密检查软件可见）。', 'ok');
    if (removedThumbCount) log('结构清理：移除 ' + removedThumbCount + ' 个缩略图（首页渲染图可能带出敏感内容）。', 'ok');

    if (outmode === 'zip' && outputs.length) {
      var blob = await Zip.pack(outputs);
      download(blob, '文档脱敏_' + tsName() + '.zip');
      log('已打包 ' + outputs.length + ' 个处理后的文件为 ZIP 并触发下载。', 'ok');
    }

    state.running = false;
    setButtons(false);
    if (canceledRun) {
    log('已停止处理：完成 ' + completed + ' / ' + n + ' 个文件，共清除 ' + totalHits + ' 处敏感词。未开始的文件保持原样。', 'warn');
    } else {
    log('处理完成：修改 ' + changedCount + ' 个文件，共清除 ' + totalHits + ' 处敏感词。',
      changedCount ? 'ok' : 'warn');
    }
    state.lastRun = {
      time: new Date().toLocaleString(),
      total: state.files.length,
      changed: changedCount,
      hits: totalHits,
      rules: engine.ruleCount,
      scope: scopeLabel(engine.scope),
      action: actionLabel(config.action),
      out: outmodeLabel(outmode)
    };
    updateReportBtn();
    syncTaskUi();
    flashReportBtn();
  }

  // 进度文案：除了百分比，还带「第几个/共几个」与预计剩余秒数。
  // 此前只有百分比，处理几百个文件时用户不知道会跑多久、是否卡住；
  // 扫描侧早就有 ETA 日志（scanAll 里每 25 个报一次），这里补上同一份信息。
  var PROG_START = 0;
  function updateProgress(pct, done, total) {
    var wrap = document.querySelector('.progress-wrap');
    if (wrap) wrap.hidden = !(pct > 0 && pct < 100);
    $('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    var pb = $('progress') || document.querySelector('.progress');
    if (pb && pb.setAttribute) pb.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round(pct)))));
    var t = $('progressText');
    if (!t) return;
    if (!(pct > 0 && pct < 100)) { t.textContent = ''; PROG_START = 0; return; }
    var label = Math.round(pct) + '%';
    if (done != null && total != null && total > 0) label += '  ' + done + '/' + total;
    if (done != null && total != null && done > 2) {
      if (!PROG_START) PROG_START = Date.now();
      var sec = (Date.now() - PROG_START) / 1000;
      var eta = Math.round((total - done) / (done / (sec || 1)));
      if (isFinite(eta) && eta >= 1) label += '  剩约 ' + eta + ' 秒';
    }
    t.textContent = label;
  }

  function setButtons(running) {
    $('scanBtn').disabled = running;
    $('scanFolderBtn').disabled = running || state.scanning;
    if (running) $('runBtn').textContent = '处理中…';
    updateRunAvailability();
    updateFlow();
    syncTaskUi();
    var stop = $('stopRunBtn');
    if (stop) stop.hidden = !running;
  }

  /* ---------------- 拖放与选择 ---------------- */

  function walkEntry(entry, prefix) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) {
          f._relPath = prefix + entry.name;
          resolve([f]);
        }, function () { resolve([]); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var readBatch = function () {
          reader.readEntries(function (batch) {
            if (!batch.length) { resolve(all); return; }
            Promise.all(batch.map(function (e) {
              return walkEntry(e, prefix + entry.name + '/');
            })).then(function (groups) {
              groups.forEach(function (g) { all = all.concat(g); });
              readBatch();
            });
          }, function () { resolve(all); });
        };
        readBatch();
      } else resolve([]);
    });
  }

  function handleDrop(dt) {
    if (!dt) return;
    if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
      var entries = [];
      for (var i = 0; i < dt.items.length; i++) {
        var e = dt.items[i].webkitGetAsEntry && dt.items[i].webkitGetAsEntry();
        if (e) entries.push(e);
      }
      if (entries.length) {
        Promise.all(entries.map(function (e) { return walkEntry(e, ''); })).then(function (groups) {
          var files = [];
          groups.forEach(function (g) { files = files.concat(g); });
          addFiles(files);
        });
        return;
      }
    }
    if (dt.files && dt.files.length) addFiles(dt.files);
  }

  /* ---------------- 环境检测与绑定 ---------------- */

  /* ---------------- 主题（浅色 / 深色） ---------------- */

  var THEME_KEY = 'dwr.theme';

  function currentTheme() {
    var root = document.documentElement;
    if (!root || !root.getAttribute) return 'light';
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    var root = document.documentElement;
    if (!root || !root.setAttribute) return;
    root.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    var btn = $('themeBtn');
    if (btn) {
      var dark = theme === 'dark';
      btn.textContent = dark ? '浅色' : '深色';
      btn.setAttribute('data-tip', dark ? '切换到浅色主题' : '切换到深色主题');
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    log('已切换为' + (next === 'dark' ? '深色' : '浅色') + '主题。', 'info');
  }

  function detectEnv() {
    var badge = $('envBadge');
    if (!Zip.isSupported()) {
      badge.textContent = '浏览器不支持原生压缩';
      badge.style.background = 'rgba(220,38,38,.25)';
      log('当前浏览器不支持 DecompressionStream / CompressionStream，请升级 Chrome / Edge / Chromium 到 80 或更高版本。', 'err');
      return;
    }
    if ('showDirectoryPicker' in global) {
      badge.textContent = '已就绪 · 支持写回';
      badge.setAttribute('data-tip', '可使用「写入新目录 / 原地覆盖」');
    } else {
      badge.textContent = '已就绪 · 仅 ZIP 导出';
      badge.setAttribute('data-tip', '如需写回需用支持目录选择的浏览器（Chrome/Edge/Chromium），或经本地服务器打开');
    }
  }

  var bindMoreMenu = DWRUi.bindMoreMenu;
  var bindTips = DWRUi.bindTips;

  function bind() {
    $('addRuleBtn').addEventListener('click', function () {
      if (state.editingRule >= 0) commitEditRule();
      else addRule($('ruleInput').value, $('ruleType').value);
    });
    $('ruleInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        // 规则输入框改成多行（textarea）后才能真批量粘贴：
        // Enter 直接提交，Shift+Enter 换行输入下一个词。
        if (e.shiftKey) return;
        e.preventDefault();
        if (state.editingRule >= 0) commitEditRule();
        else addRule($('ruleInput').value, $('ruleType').value);
      } else if (e.key === 'Escape') {
        exitEditRule();
      }
    });
    $('loadPresetBtn').addEventListener('click', loadPreset);
    $('piiPresetBtn').addEventListener('click', loadPiiPresets);
    var editTaskBtn = $('editTaskBtn');
    if (editTaskBtn) editTaskBtn.addEventListener('click', function () {
      var card = $('rulesCard') || $('processCard');
      ['rulesCard', 'processCard'].forEach(function (id) {
        var settings = $(id);
        if (settings && 'open' in settings) settings.open = true;
      });
      if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      var first = $('ruleInput') || $('presetSel');
      if (first && first.focus) setTimeout(function () { first.focus({ preventScroll: true }); }, 250);
    });
    $('clearRuleBtn').addEventListener('click', function () {
      state.rules = []; renderRules(); saveSettings();
    });
    $('ruleSelAllBtn').addEventListener('click', function () {
      state.ruleSel = state.rules.slice();
      renderRules();
    });
    $('ruleSelNoneBtn').addEventListener('click', function () {
      state.ruleSel = [];
      renderRules();
    });
    $('ruleDelSelBtn').addEventListener('click', removeSelectedRules);
    $('exportRuleBtn').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state.rules, null, 2)], { type: 'application/json' });
      download(blob, '敏感词库_' + tsName() + '.json');
    });
    $('importRuleBtn').addEventListener('click', function () { $('importRuleFile').click(); });
    $('importRuleFile').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      f.text().then(function (txt) {
        var arr = JSON.parse(txt);
        if (Array.isArray(arr)) {
          state.rules = arr.map(function (r) {
            var out = { text: String(r.text || ''), type: r.type === 'regex' ? 'regex' : 'text', enabled: r.enabled !== false };
            if (r.label) out.label = String(r.label);
            if (r.whole === true) out.whole = true;
            var nb = ctxList(r.notBefore);
            if (nb.length) out.notBefore = nb;
            var na = ctxList(r.notAfter);
            if (na.length) out.notAfter = na;
            return out;
          }).filter(function (r) { return r.text; });
          renderRules(); saveSettings();
          log('已导入 ' + state.rules.length + ' 条敏感词', 'info');
        }
      }).catch(function () { log('词库文件解析失败', 'err'); });
      e.target.value = '';
    });

    ['tidySpace', 'onlyChanged', 'backup', 'deleteBak', 'verifyAfter', 'onlyHit', 'customText', 'scanMaxFiles', 'scanMaxDepth', 'scanSkipSys', 'caseSensitive',
      'ruleWhole', 'ruleExcludeBefore', 'ruleExcludeAfter'].forEach(function (id) {
      // backup 决定「覆盖原文件且无备份」的告警是否出现，所以它变化时要重算提示条
      if ($(id)) $(id).addEventListener('change', function () {
        saveSettings();
        if (id === 'backup') setOutDirInfo();
        // 自检开关直接改变最终写出内容：预览必须跟着刷新，否则又会「预览留、实际清」
        if (id === 'verifyAfter') refreshPreview();
        syncTaskUi();
      });
    });
    document.querySelectorAll('input[name="scope"],input[name="action"],input[name="outmode"]').forEach(function (el) {
      el.addEventListener('change', function () {
        saveSettings();
        syncCustomWrap();
        // 输出方式决定「是否改写原文件」：切到「覆盖原文件」时必须重算那条
        // 不可逆改写告警，否则用户先关备份再切模式时看不到任何警告就改了原文件。
        if (el.name === 'outmode') setOutDirInfo();
        // 范围 / 处理方式直接影响预览口径，切换后立即按新设置重渲染
        if (el.name !== 'outmode') refreshPreview();
        syncTaskUi();
      });
    });

    function syncCustomWrap() {
      var w = $('customWrap');
      if (w) w.style.display = checkedVal('action') === 'custom' ? 'block' : 'none';
    }
    syncCustomWrap();

    var fq = $('fileFilterQ');
    if (fq) fq.addEventListener('input', function () {
      state.filterQ = (fq.value || '').trim().toLowerCase();
      renderTable();
    });
    var fst = $('fileFilterStatus');
    if (fst) fst.addEventListener('change', function () {
      state.filterStatus = fst.value;
      renderTable();
    });

    var clearLog = $('clearLogBtn');
    if (clearLog) clearLog.addEventListener('click', function () {
      $('log').innerHTML = '';
      log('日志已清空', 'info');
    });

    var copyBtn = $('copyResultBtn');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var text = state.lastPreview || '';
      if (!text) { log('暂无可复制的处理结果', 'warn'); return; }
      var flashBtn = function () {
        copyBtn.textContent = '已复制';
        copyBtn.classList.add('ok');
        setTimeout(function () {
          copyBtn.textContent = '复制结果';
          copyBtn.classList.remove('ok');
        }, 1600);
      };
      var done = function () { log('已复制处理后文本（' + text.length + ' 字符）', 'ok'); flashBtn(); };
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    });

    var footVer = $('footVer');
    if (footVer) {
      var fmeta = document.querySelector('meta[name="dwr-version"]');
      var fver = fmeta && fmeta.content ? fmeta.content : '';
      if (fver && fver.indexOf('__DWR_VERSION__') < 0) footVer.textContent = 'Doc-Internal-Word-Remover ' + fver;
    }
    var verEl = $('appVersion');
    if (verEl) {
      var meta = document.querySelector('meta[name="dwr-version"]');
      var ver = meta && meta.content ? meta.content : '';
      if (ver && ver.indexOf('__DWR_VERSION__') < 0) { verEl.textContent = ver; verEl.hidden = false; }
    }

    var selAll = $('fileSelAll');
    if (selAll) selAll.addEventListener('click', function () {
      var list = visibleFiles();
      list.forEach(function (f) {
        if (selAll.checked) state.checked[f.id] = true;
        else delete state.checked[f.id];
      });
      renderTable();
    });
    var selInvert = $('selInvertBtn');
    if (selInvert) selInvert.addEventListener('click', function () {
      visibleFiles().forEach(function (f) {
        if (state.checked[f.id]) delete state.checked[f.id];
        else state.checked[f.id] = true;
      });
      renderTable();
    });
    var selNone = $('selNoneBtn');
    if (selNone) selNone.addEventListener('click', function () {
      state.checked = {};
      renderTable();
    });
    var delSel = $('delSelBtn');
    if (delSel) delSel.addEventListener('click', removeSelected);

    // 快捷键：Ctrl/Cmd+A 全选可见文件；Delete 删除选中（避开输入控件）
    document.addEventListener('keydown', function (e) {
      var t = e.target || {};
      var tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (!visibleFiles().length) return;
        e.preventDefault();
        visibleFiles().forEach(function (f) { state.checked[f.id] = true; });
        renderTable();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds().length) {
        e.preventDefault();
        removeSelected();
      }
      // Ctrl/Cmd+Enter：直接开始处理（不必把鼠标移到右下角）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter')) {
        e.preventDefault();
        if (!$('runBtn').disabled) $('runBtn').click();
        return;
      }
      // Esc：退出词库编辑态；没有编辑态时收起扫描结果卡片
      if (e.key === 'Escape') {
        if (state.editingRule >= 0) { exitEditRule(); return; }
        var sc2 = $('scanResultCard');
        if (sc2 && sc2.style.display !== 'none') {
          sc2.style.display = 'none';
          state.scanPreviewIdx = -1;
        }
      }
    });

    var concEl = $('concurrency');
    if (concEl) {
      var syncConc = function () {
        var v = concEl.value;
        var lbl = $('concurrencyVal');
        if (lbl) lbl.textContent = v + ' 个';
      };
      concEl.addEventListener('input', syncConc);
      concEl.addEventListener('change', saveSettings);
      syncConc();
    }

    $('pickFilesBtn').addEventListener('click', function () { $('fileInput').click(); });
    $('pickDirBtn').addEventListener('click', function () { $('dirInput').click(); });
    // v2.90：一次挑多个盘 / 目录，把文档批量加入处理列表
    $('addDrivesBtn').addEventListener('click', function () {
      if (!dirPickerReady(ADD_PICK_UI.what)) return;
      ADD_STATE.list = [];
      addSetActive(true);
      log('已进入多位置挑选：每选一个位置加入列表，选完点「加入列表」。', 'info');
      addPickOne();
    });
    $('addPickAddBtn').addEventListener('click', function () { addPickOne(); });
    $('addPickClearBtn').addEventListener('click', function () {
      ADD_STATE.list = [];
      addRenderPick();
      log('已清空列表。', 'info');
    });
    $('addPickStartBtn').addEventListener('click', function () {
      addPickStart();
    });
    $('fileInput').addEventListener('change', function (e) {
      addFiles(e.target.files); e.target.value = '';
    });
    $('dirInput').addEventListener('change', function (e) {
      addFiles(e.target.files); e.target.value = '';
    });

    $('pickOutDir').addEventListener('click', async function () {
      if (!dirPickerReady('选择目录')) return;
      try {
        var pk2 = await pickDir(OUT_DIR_KEY, { mode: 'readwrite' });
        state.outDirHandle = pk2.handle;
        if (!state.outDirHandle) return;
        setOutDirInfo();
        log('已选择输出目录：' + (state.outDirHandle.name || '未知目录')
          + (pk2.reused ? '（沿用上次记忆，可重新选择其他目录）' : ''), 'info');
      } catch (err) { /* 用户取消 */ }
    });

    var dz = $('dropzone');
    var dropSubText = $('dropSub') ? $('dropSub').textContent : '';
    function setDropText(over) {
      var s = $('dropSub');
      if (s) s.textContent = over ? '松开鼠标即添加到列表' : dropSubText;
    }
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('over'); setDropText(true); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('over'); setDropText(false); });
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      handleDrop(e.dataTransfer);
    });
    dz.addEventListener('click', function () { $('fileInput').click(); });
    // 拖放区是页面上最大的操作目标，原来只是 div，键盘用户 Tab 不到、也按不了。
    // 补上 role=button / tabindex（写在 index.html 上）后，这里接住 Enter / Space。
    // Space 的默认行为会滚动页面，必须 preventDefault。
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        $('fileInput').click();
      }
    });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('scanBtn').addEventListener('click', scanAll);

    $('scanFolderBtn').addEventListener('click', function () {
      if (!notImporting('后再扫描文件夹')) return;
      scanFolder().catch(function (e) {
        state.scanning = false;
        $('scanFolderBtn').disabled = false;
        $('stopScanBtn').disabled = true;
        endScanLive();
        log('扫描异常：' + errMsg(e), 'err');
      });
    });
    // v2.89：多盘 / 多目录一次扫
    $('scanDrivesBtn').addEventListener('click', function () {
      if (!notImporting('')) return;
      if (!dirPickerReady(DRIVE_PICK_UI.what)) return;
      DRIVE_STATE.list = [];
      driveSetActive(true);
      log('已进入多位置挑选：每选一个位置加入列表，选完点「开始扫描」。', 'info');
      driveAddOne();
    });
    $('driveAddBtn').addEventListener('click', function () { driveAddOne(); });
    $('driveQuickBtn').addEventListener('click', function () { driveQuickPanel(); });
    // v2.92：折叠次要扫描设置，默认只露出两个高频按钮
    $('scanSettingsBtn').addEventListener('click', function () {
      var body = $('scanSettingsBody');
      var btn = $('scanSettingsBtn');
      if (!body) return;
      var open = body.hidden;
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '收起扫描设置' : '更多扫描设置…';
    });
    $('driveClearBtn').addEventListener('click', function () {
      DRIVE_STATE.list = [];
      driveRenderPick();
      log('已清空扫描列表。', 'info');
    });
    $('uncAddBtn').addEventListener('click', uncAddFromInput);
    var uncInput = $('uncPathInput');
    if (uncInput) uncInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); uncAddFromInput(); }
    });
    $('driveStartBtn').addEventListener('click', function () {
      driveStartAll().catch(function (e) {
        state.scanning = false;
        driveSetActive(false);
        endScanLive();
        log('扫描异常：' + errMsg(e), 'err');
      });
    });
    $('stopScanBtn').addEventListener('click', function () {
      if (state.importing) {
        state.importCancel = true;
        log('正在停止导入复检（已完成的文件保留结果）…', 'warn');
        return;
      }
      if (state.running) {
        state.runCancel = true;
        log('正在停止处理：已完成的文件保留结果，未开始的不会处理…', 'warn');
      }
      if (state.scanning) {
        state.scanCancel = true;
        log('正在停止扫描…', 'warn');
      }
    });
    var scanLiveStop = $('scanLiveStopBtn');
    if (scanLiveStop) scanLiveStop.addEventListener('click', function () {
      $('stopScanBtn').click();
    });
    var importReportBtn = $('importReportBtn');
    if (importReportBtn) importReportBtn.addEventListener('click', function () { $('reportFile').click(); });
    var reportFile = $('reportFile');
    if (reportFile) reportFile.addEventListener('change', function (e) {
      // 支持一次选多个报告：逐个排队导入，导入期间禁用态与中止语义不变
      var list = e.target.files ? Array.prototype.slice.call(e.target.files) : [];
      e.target.value = '';
      if (!list.length) return;
      if (list.length === 1) {
        importReport(list[0]).catch(function (err) {
          log('导入报告异常：' + (err && err.message ? err.message : err), 'err');
        });
        return;
      }
      enqueueReports(list);
    });
    $('scanReportBtn').addEventListener('click', function () { exportScanReport(); });
    $('scanReportJsonBtn').addEventListener('click', function () { exportScanReportJson(); });
    var themeBtn = $('themeBtn');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    $('scanSelInvert').addEventListener('click', function () {
      scanVisibleRows().forEach(function (r) { r.selected = !r.selected; });
      scanTableChanged(false);
    });
    var scanSelAllBox = $('scanSelAllBox');
    if (scanSelAllBox) scanSelAllBox.addEventListener('click', function () {
      var on = scanSelAllBox.checked;
      scanVisibleRows().forEach(function (r) { r.selected = on; });
      scanTableChanged(false);
    });
    var rescreenBtn = $('scanRescreenBtn');
    if (rescreenBtn) rescreenBtn.addEventListener('click', function () {
      rescreenSelected().catch(function (e) { log('重新甄别失败：' + (e.message || e), 'err'); });
    });
    // 扫描结果表过滤 / 排序：结果上千行时按路径、命中词、状态快速定位
    var scanFilterQ = $('scanFilterQ');
    if (scanFilterQ) scanFilterQ.addEventListener('input', function () {
      state.scanFilterQ = scanFilterQ.value || '';
      scanTableChanged(false);
    });
    var scanFilterStatus = $('scanFilterStatus');
    if (scanFilterStatus) scanFilterStatus.addEventListener('change', function () {
      state.scanFilterStatus = scanFilterStatus.value || 'all';
      scanTableChanged(true);
    });
    // v4.68 合计行数字点击筛选：与上方状态下拉同一套状态，两处入口双向同步
    var scanTallyEl = $('scanTally');
    if (scanTallyEl) scanTallyEl.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('b[data-st]')
        : (e.target && e.target.getAttribute && e.target.getAttribute('data-st') ? e.target : null);
      if (!b) return;
      var st = b.getAttribute('data-st');
      state.scanFilterStatus = (state.scanFilterStatus === st) ? 'all' : st;
      if (scanFilterStatus) scanFilterStatus.value = state.scanFilterStatus;
      scanTableChanged(true);
    });
    var scanSort = $('scanSort');
    if (scanSort) scanSort.addEventListener('change', function () {
      state.scanSort = scanSort.value || 'default';
      scanTableChanged(true);
    });
    // 清空记住的目录授权（扫描根 / 各盘根 / 输出目录）
    var clearDirMemBtn = $('clearDirMemBtn');
    if (clearDirMemBtn) clearDirMemBtn.addEventListener('click', async function () {
      var ok = await dirCacheClear();
      state.outDirHandle = null;
      setOutDirInfo();
      if (ok) {
        log('已清除记住的目录（扫描文件夹 / 各盘根目录 / 输出目录），下次将重新询问。', 'ok');
      } else {
        log('当前环境没有可清除的目录记忆（或浏览器不支持 IndexedDB）。', 'warn');
      }
    });
    var scanHideFpCb = $('scanHideFp');
    if (scanHideFpCb) scanHideFpCb.addEventListener('click', function () {
      state.scanHideFp = scanHideFpCb.checked;
      scanTableChanged(true);
    });
    var scanDelSelBtn = $('scanDelSelBtn');
    if (scanDelSelBtn) scanDelSelBtn.addEventListener('click', removeSelectedScan);
    if ($('scanCleanBtn')) $('scanCleanBtn').addEventListener('click', function () {
      batchCleanSelected().catch(function (e) { log('一键处理异常：' + (e.message || e), 'err'); });
    });
    if ($('scanVerifyBtn')) $('scanVerifyBtn').addEventListener('click', function () {
      verifyScanSelected().catch(function (e) { log('复检异常：' + (e.message || e), 'err'); });
    });

    if ($('scanDelDiskBtn')) $('scanDelDiskBtn').addEventListener('click', function () {
      batchDeleteSelected().catch(function (e) { log('一键删除异常：' + (e.message || e), 'err'); });
    });
    $('addScanToFiles').addEventListener('click', function () {
      var picked = state.scanResults.filter(function (r) { return r.selected; });
      if (!picked.length) return;
      if (!addScanRows(picked)) log('选中的文档已在处理列表中。', 'warn');
    });
    $('closeScanCard').addEventListener('click', function () {
      $('scanResultCard').style.display = 'none';
    });
    $('runBtn').addEventListener('click', function () {
      run().catch(function (e) {
        log('运行异常：' + e.message, 'err');
        state.running = false; setButtons(false);
      });
    });
    // v3.6 HTML 检查报告（A4 单页，可打印成 PDF）
    if ($('scanReportHtmlBtn')) $('scanReportHtmlBtn').addEventListener('click', function () { exportScanReportHtml(); });
    if ($('reportHtmlBtn')) $('reportHtmlBtn').addEventListener('click', function () { exportCleanReportHtml(); });
    $('reportBtn').addEventListener('click', function () { exportCleanReport(); });
    $('reportJsonBtn').addEventListener('click', function () { exportCleanReportJson(); });

    // 「更多」收纳：低频按钮收进浮层，点外面或再点一次就关；工具栏、扫描结果卡、词库共用
    bindMoreMenu($('moreBtn'), $('morePop'));
    // 扫描结果卡收纳 7 个次要操作，只留「一键处理选中 / 加入处理列表」两个主出口
    bindMoreMenu($('scanMoreBtn'), $('scanMorePop'));
    // 词库收纳整词匹配 / 排除前后缀 / 导入导出 / 清空，只留「输入词 → 添加」主路径
    bindMoreMenu($('ruleMoreBtn'), $('ruleMorePop'));

    // v3.4 一键撤销
    if ($("undoBtn")) $("undoBtn").addEventListener("click", function () {
      undoLastRun().catch(function (e) { log("撤销异常：" + (e.message || e), "err"); });
    });
    refreshUndoBtn();
    $('clearBtn').addEventListener('click', function () {
      state.files = []; state.selectedId = null; state.lastPreview = ''; state.checked = {};
      $('previewOrig').textContent = '在文件列表点一行，这里显示原文与命中位置。';
      $('previewNew').textContent = '';
      var box = $('previewHits');
      if (box) box.innerHTML = '';
      setPreviewNote('');
      renderTable(); updateSummary();
    });
  }

  function init() {
    var has = loadSettings();
    if (!has) loadPreset();
    // v2.82：有未处理文件时，关闭 / 刷新页面前提示一次，防止手滑丢工作现场。
    // 只在有「未处理或已扫描但未处理」文件时拦，处理完或列表为空不拦。
    window.addEventListener('beforeunload', function (e) {
      var pending = state.files.filter(function (f) {
        return f.supported && (f.status === 'pending' || f.status === 'hit');
      }).length;
      if (pending > 0 && !state.running) {
        e.preventDefault();
        e.returnValue = '还有 ' + pending + ' 个文件未处理，确定离开？';
        return e.returnValue;
      }
    });
    renderRules();
    detectEnv();
    bind();
    bindTips();
    applyTheme(currentTheme());
    renderTable();
    // 扫描结果表也要有一次初始渲染：否则用户一展开卡片只看到空 <tbody>，
    // 既没有空态插图也不知道该干什么（此卡片初始是展开的）
    renderScanResults();
    // 同步空态下的扫描区控件（加入按钮计数 / 表头复选框 / 报告按钮禁用态）
    // 覆盖且不备份的告警条开场先同步一次；输出方式 / 备份开关变化时再刷新
    setOutDirInfo();
    ['input', 'change'].forEach(function (ev) {
      document.addEventListener(ev, function (e) {
        var t = e && e.target;
        if (t && t.name === 'outmode') setOutDirInfo();
      });
    });
    // 页头吸顶后材质加深：滚动超过 1px 才切 class，回顶部再撤。
    // 少了这段，半透明页头会把下方内容透上来，标题与正文叠在一起难读。
    bindHeaderScroll();
    updateScanAddBtn();
    bindReviewNote();
    bindReviewList();
    bindExtFilter();
    log('应用已就绪，已加载 ' + state.rules.length + ' 条敏感词。', 'info');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
