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
  var SCAN_COLS = ['path', 'kind', 'size', 'hits', 'matched', 'ratio'];

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
    buildReportCsv: buildReportCsv,
    buildReportJson: buildReportJson,
    buildCleanReportCsv: buildCleanReportCsv,
    buildCleanReportJson: buildCleanReportJson,
    buildScanReportCsv: buildScanReportCsv,
    buildScanReportJson: buildScanReportJson
  };
})(typeof window !== 'undefined' ? window : globalThis);
