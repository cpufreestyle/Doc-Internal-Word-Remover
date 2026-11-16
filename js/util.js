/**
 * util.js —— 通用工具：受控并发调度、清除报告构造（网页与命令行复用）
 * 为 scanAll / run 提供带并发上限的 map，避免大批量文件串行处理拖慢整体速度。
 */
(function (global) {
  'use strict';

  /**
   * 受控并发 map：最多 limit 个 fn(item, index) 同时执行，
   * 返回与输入顺序一致的 Promise<结果数组>。单个任务失败会被捕获并填入
   * 对应位置（{__error: Error}），不影响其余任务完成。
   *
   * @param {Array} items   输入数组
   * @param {number} limit  最大并发数（自动约束在 [1, items.length]）
   * @param {Function} fn    async/返回 Promise 的任务函数
   * @returns {Promise<Array>}
   */
  function mapPool(items, limit, fn, shouldStop) {
    var n = items.length;
    if (n === 0) return Promise.resolve([]);
    limit = Math.max(1, Math.min(limit | 0 || 1, n));
    // shouldStop：可选的取消探针。返回 true 时不再启动新任务，
    // 已启动的跑完为止（结果按 items 长度返回，未启动的位置留 undefined，
    // 调用方按 undefined 判断「未处理」）。保持 4 参签名向后兼容。
    var stopped = shouldStop && typeof shouldStop === 'function';
    if (stopped && shouldStop()) return Promise.resolve(new Array(n));

    var results = new Array(n);
    var cursor = 0;
    var active = 0;
    var done = 0;

    return new Promise(function (resolve /* , reject */) {
      function settle(i, err, val) {
        results[i] = err ? { __error: err } : val;
        done++;
        if (done === n) resolve(results);
        else pump();
      }

      function pump() {
        while (cursor < n && active < limit) {
          if (stopped && shouldStop()) return; // 已排队的任务跑完即结束，不再补位
          // 用 IIFE 锁定本次迭代的索引，避免 var 在循环中被共享导致的闭包错乱
          (function (i) {
            active++;
            Promise.resolve().then(function () {
              return fn(items[i], i);
            }).then(
              function (v) { active--; settle(i, null, v); },
              function (e) { active--; settle(i, e || new Error('mapPool task failed')); }
            );
          })(cursor++);
        }
      }

      pump();
    });
  }

  /** 当前环境的建议并发度（保守区间 [2,8]） */
  function suggestedConcurrency() {
    var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(2, Math.min(8, hc | 0));
  }

  /**
   * CSV 单元格转义（RFC 4180）：含逗号 / 引号 / 换行时加引号，内部引号翻倍。
   * 网页端与 scan.mjs 共用同一份实现，避免两处行为偏差。
   */
  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // 报告里的文件名与命中词都是外来内容，Excel / WPS 会把以 = + - @ 或制表符开头的单元格
    // 当公式求值（CSV 公式注入）。前缀一个单引号让它按文本处理；
    // 单个 `-` 是「无占比」占位符，不是公式，不加倍。
    if (s.charCodeAt(0) === 61 || s.charCodeAt(0) === 43 || s.charCodeAt(0) === 64
      || s.charCodeAt(0) === 9 || s.charCodeAt(0) === 13
      || (s.charCodeAt(0) === 45 && s.length > 1)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** 报告列定义：`cols` 决定 CSV 表头与每行取值顺序（row[key] 为 undefined 时输出空串） */
  var CLEAN_COLS = ['file', 'hits', 'matched', 'status', 'out'];
  // v4.84：末列 cross = 词级交叉校验结论（漏检 / 多报），导入报告时才有值
  // v4.87：补 cat（文件类别）/ mtime（修改时间）/ level（判定密级）/ over（是否越级存储）
  // 新列一律追加在末尾：前几列的顺序是既有约定（用户的脚本按位置取列），插在中间会打断下游
  var SCAN_COLS = ['path', 'kind', 'size', 'hits', 'matched', 'ratio', 'mode', 'parts', 'cross',
    'cat', 'mtime', 'level', 'over', 'verdict', 'tier',
    // v4.94：外部检查系统报告里的原结论（导入报告时才有值），随报告一并导出，
    //   交出去时能同时看到「检查软件怎么说」与「本工具怎么说」。
    'ctime', 'checkerRatio', 'checkerMarkLevel', 'checkerVerdict', 'checkerCat'];

  /* ---------------- v4.87：文件类别 / 密级判定 ----------------
     外部保密检查系统的「文件涉密信息检查」有两个维度我们此前只做了一半：
       1) 检查文件类型按类目多选（doc / xls / ppt / pdf / txt / html / wps / et …）；
       2) 文件密级 vs 本机定密级——文件密级高于本机即「越级存储」。
     这里把两套口径做成纯函数，界面扫描、报告导出、命令行扫描共用同一份定义。 */

  /** 文件类别定义：key 用于勾选，exts 展开成实际扩展名过滤集 */
  var FILE_CATS = [
    { key: 'doc', label: '文字文档', exts: ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'rtf', 'odt', 'wps', 'wpsx', 'wpt'] },
    { key: 'sheet', label: '表格', exts: ['xlsx', 'xlsm', 'xltx', 'xltm', 'xls', 'xlt', 'csv', 'tsv', 'et', 'ods'] },
    { key: 'slide', label: '演示', exts: ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'ppt', 'pot', 'pps', 'dps', 'odp'] },
    { key: 'pdf', label: 'PDF', exts: ['pdf'] },
    { key: 'text', label: '文本', exts: ['txt', 'text', 'md', 'markdown', 'rst', 'tex', 'log', 'lst', 'nfo', 'me', 'sub', 'srt', 'vtt', 'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'yml', 'yaml', 'toml', 'json', 'jsonl', 'xml', 'sql', 'reg'] },
    { key: 'web', label: '网页', exts: ['html', 'htm', 'xhtml', 'mht', 'svg'] },
    { key: 'code', label: '源码脚本', exts: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'pl', 'lua', 'r', 'swift', 'dart', 'css', 'scss', 'less', 'styl', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'vbs'] },
    { key: 'zip', label: '压缩包', exts: ['zip', 'zipx', 'jar', 'apk', 'xpi', 'epub', 'whl', 'nupkg', 'rar', '7z'] },
    { key: 'other', label: '其他', exts: [] }
  ];

  /** 取扩展名（小写，无点） */
  function extOf(name) {
    var s = String(name || '');
    var i = s.lastIndexOf('.');
    if (i < 0) return '';
    var e = s.slice(i + 1).toLowerCase();
    return /^[a-z0-9]{1,12}$/.test(e) ? e : '';
  }

  /** 文件所属类别（未知扩展名归「其他」） */
  function fileCatOf(name) {
    var e = extOf(name);
    if (!e) return 'other';
    for (var i = 0; i < FILE_CATS.length; i++) {
      if (FILE_CATS[i].exts.indexOf(e) >= 0) return FILE_CATS[i].key;
    }
    return 'other';
  }

  /** 类别 key → 中文名 */
  function fileCatLabel(key) {
    for (var i = 0; i < FILE_CATS.length; i++) {
      if (FILE_CATS[i].key === key) return FILE_CATS[i].label;
    }
    return '其他';
  }

  /**
   * 按勾选的类别展开成扩展名集合。
   * 勾了「其他」表示不限制（返回 null，等同「全部支持格式」）。
   */
  function catExts(keys) {
    var list = (keys || []).filter(function (k) { return k && k !== 'other'; });
    if (!list.length) return null;
    var out = [];
    list.forEach(function (k) {
      FILE_CATS.forEach(function (c) {
        if (c.key === k) c.exts.forEach(function (e) { if (out.indexOf(e) < 0) out.push(e); });
      });
    });
    return out.length ? out : null;
  }

  /* ---------------- 密级判定 ----------------
     密级词本身带级别信息：绝密 > 机密 > 秘密 > 内部。
     文件密级 = 命中词里级别最高的那个；与「本机定密级」相比高出的即为「越级存储」。 */

  var SECRET_LEVELS = ['公开', '内部', '秘密', '机密', '绝密']; // 由低到高

  /** 命中词 → 文件判定密级（无密级词则空串） */
  function levelOfMatched(matched) {
    var best = '';
    (matched || []).forEach(function (w) {
      var t = String(w == null ? '' : w).trim();
      if (t === '公开') return;                 // 「公开」是定密级用词，不是命中出来的
      if (SECRET_LEVELS.indexOf(t) < 0) return;
      if (SECRET_LEVELS.indexOf(t) > SECRET_LEVELS.indexOf(best)) best = t;
    });
    return best;
  }

  /** 密级序（越大越密）；无法识别返回 -1 */
  function levelRank(level) {
    var i = SECRET_LEVELS.indexOf(String(level || '').trim());
    return i < 0 ? -1 : i;
  }

  /** 文件密级是否高于本机定密级（越级存储） */
  function isOverLevel(fileLevel, machineLevel) {
    var a = levelRank(fileLevel), b = levelRank(machineLevel);
    return a > 0 && b >= 0 && a > b;
  }

  /* ---------------- v4.89：涉密分档 ----------------
     外部保密检查系统的结果表除了「命中百分比」，还按百分比把文件分成四档
     （实测其报告里的占比只有 25% / 50% / 75% / 100% 四种取值），
     并用「标密文件 / 判定的密级文件 / 判定的公开文件」三个页签分流。
     我们不把占比压成四档（连续值信息更多），但沿用它按四档给结论的做法：
     占比越高，复核优先级越高，界面上直接给出档位，人工不用自己换算。 */

  var RISK_TIERS = [
    { min: 0.75, key: 'extreme', label: '极高' },
    { min: 0.5, key: 'high', label: '高' },
    { min: 0.25, key: 'mid', label: '中' },
    { min: 0.0001, key: 'low', label: '低' }
  ];

  /** 命中占比 → 档位 key（无有效占比返回空串） */
  function riskTier(ratio) {
    var v = Number(ratio);
    if (!isFinite(v) || v <= 0) return '';
    for (var i = 0; i < RISK_TIERS.length; i++) {
      if (v >= RISK_TIERS[i].min) return RISK_TIERS[i].key;
    }
    return '';
  }

  /** 档位 key → 中文名 */
  function riskTierLabel(key) {
    for (var i = 0; i < RISK_TIERS.length; i++) {
      if (RISK_TIERS[i].key === key) return RISK_TIERS[i].label;
    }
    return '';
  }

  /**
   * 涉密情况结论（对应外部保密检查系统结果表的「涉密情况」列）。
   * 越级存储 → 涉嫌越级存储；判出密级 → 涉密（X 级）；其余 → 未标密。
   * 注意：「未标密」只说明文件里没有密级标识词，不代表文件可以对外发，
   * 报告里仍按人工判定清单走。
   */
  function secrecyVerdict(level, over) {
    if (over) return '涉嫌越级存储';
    var lv = String(level || '').trim();
    return lv ? ('涉密（' + lv + '）') : '未标密';
  }

  /**
   * 通用 CSV 报告构造：CRLF 行尾 + 行首 `#` 元信息注释行，Excel 双击可直接打开。
   * @param {Array<[string,(string|number)]>} summary 元信息
   * @param {Array<Object>} rows 明细行（按 cols 取字段）
   * @param {string[]} cols 列顺序
   */
  function buildReportCsv(summary, rows, cols) {
    var list = cols || CLEAN_COLS;
    var lines = (summary || []).map(function (kv) {
      return '#' + [kv[0], kv[1] == null ? '' : kv[1]].map(csvCell).join(',');
    });
    lines.push(list.join(','));
    (rows || []).forEach(function (r) {
      lines.push(list.map(function (key) {
        var v = r ? r[key] : '';
        return (Array.isArray(v) ? v.join(' / ') : v);
      }).map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /** 清除报告（CSV） */
  function buildCleanReportCsv(summary, rows) {
    return buildReportCsv(summary, rows, CLEAN_COLS);
  }

  /** 扫描报告（CSV）：命中清单，供导出核对 */
  function buildScanReportCsv(summary, rows) {
    return buildReportCsv(summary, rows, SCAN_COLS);
  }

  /** 通用 JSON 报告：{ meta, files }，files 原样透流行对象（字段已由调用方规整） */
  function buildReportJson(summary, rows) {
    var meta = {};
    (summary || []).forEach(function (kv) { meta[kv[0]] = kv[1]; });
    return JSON.stringify({ meta: meta, files: (rows || []).map(function (r) { return r || {}; }) }, null, 2);
  }

  /** 清除报告（JSON） */
  function buildCleanReportJson(summary, rows) {
    return buildReportJson(summary, (rows || []).map(function (r) {
      return { file: r.file, hits: r.hits, matched: r.matched || [], status: r.status, out: r.out || '' };
    }));
  }

  /** 扫描报告（JSON） */
  function buildScanReportJson(summary, rows) {
    return buildReportJson(summary, rows);
  }

  global.DWRUtil = {
    mapPool: mapPool,
    suggestedConcurrency: suggestedConcurrency,
    csvCell: csvCell,
    FILE_CATS: FILE_CATS,
    SECRET_LEVELS: SECRET_LEVELS,
    fileCatOf: fileCatOf,
    fileCatLabel: fileCatLabel,
    catExts: catExts,
    levelOfMatched: levelOfMatched,
    levelRank: levelRank,
    isOverLevel: isOverLevel,
    riskTier: riskTier,
    riskTierLabel: riskTierLabel,
    secrecyVerdict: secrecyVerdict,
    buildReportCsv: buildReportCsv,
    buildReportJson: buildReportJson,
    buildCleanReportCsv: buildCleanReportCsv,
    buildCleanReportJson: buildCleanReportJson,
    buildScanReportCsv: buildScanReportCsv,
    buildScanReportJson: buildScanReportJson
  };
})(typeof window !== 'undefined' ? window : globalThis);
