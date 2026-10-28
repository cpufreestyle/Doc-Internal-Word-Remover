/* v3.8 HTML 检查报告：把 CSV / JSON 报告渲染成一张可打印的 A4 单页，
   给合规 / 审计角色一个能签字的东西。零依赖，纯字符串拼接。
   v3.8 参照 REA（Reverse Engineering Assistant）的报告范式：
     - 结论先行：报告顶部一段话讲清「查了什么、结果如何、下一步」；
     - 证据分级：每条概要标注 obs（文件里读到的）/ der（由观测确定性算出）/
       inf（需人工复核的判断），读者知道哪些数字可以直接采信；
     - Evidence 列：每条概要附依据说明，回答「这个数怎么来的」；
     - 局限声明：明确列出本报告不覆盖的范围（图片 / PDF / 宏 / OLE）。 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CSS = [
    '*{box-sizing:border-box}',
    'body{margin:0;padding:24px;font:13px/1.6 Noto Sans CJK SC, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif;color:#1d1d1f;background:#fff}',
    'h1{font-size:20px;margin:0 0 4px}',
    '.sub{color:#6e6e73;font-size:12px;margin:0 0 20px}',
    'table{width:100%;border-collapse:collapse;margin:0 0 20px}',
    'caption{text-align:left;font-weight:700;font-size:14px;padding:0 0 8px}',
    'th,td{border:1px solid #d2d2d7;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-all}',
    'th{background:#f5f5f7;font-weight:600}',
    'td.k{width:180px;color:#6e6e73}',
    '.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;white-space:nowrap}',
    '.t-ok{background:#e8f5e9;color:#1b5e20}',
    '.t-hit{background:#fff3e0;color:#e65100}',
    '.t-err{background:#ffebee;color:#b71c1c}',
    '.t-mute{background:#f5f5f7;color:#6e6e73}',
    '.foot{color:#6e6e73;font-size:11px;border-top:1px solid #d2d2d7;padding-top:10px}',
    '.concl{border-left:3px solid #0066cc;background:#f5f8ff;padding:10px 12px;margin:0 0 20px;border-radius:0 6px 6px 0}',
    '.concl strong{display:block;font-size:12px;color:#0066cc;margin-bottom:3px}',
    '.review{border-left:3px solid #34c759;background:#f0faf3;padding:10px 12px;margin:0 0 20px;border-radius:0 6px 6px 0}',
    '.review strong{display:block;font-size:12px;color:#1b7a3d;margin-bottom:3px}',
    '.ev{color:#6e6e73;font-size:11px}',
    '.lv{display:inline-block;padding:0 6px;border-radius:4px;font-size:11px;margin-right:6px;white-space:nowrap}',
    '.lv-obs{background:#e8f5e9;color:#1b5e20}',
    '.lv-der{background:#e3f2fd;color:#0d47a1}',
    '.lv-inf{background:#fff3e0;color:#e65100}',
    'ul.limits{margin:0 0 20px;padding-left:20px;color:#6e6e73;font-size:12px}',
    'ul.limits li{margin:2px 0}',
    'table.steps td{background:#fafafa}',
    '@media print{body{padding:0}}',
  ].join('');

  function statusTag(status) {
    var map = {
      done: ['t-ok', '已处理'],
      hit: ['t-hit', '命中'],
      error: ['t-err', '失败'],
      pending: ['t-mute', '未处理'],
      clean: ['t-mute', '无命中']
    };
    var m = map[status] || ['t-mute', String(status || '-')];
    return '<span class="tag ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  /** 证据分级徽章：obs=直接从文件读到，der=由观测确定性算出，inf=需人工复核的判断 */
  function levelTag(kind) {
    var map = {
      obs: ['lv-obs', '观测'],
      der: ['lv-der', '推算'],
      inf: ['lv-inf', '待核']
    };
    var m = map[kind] || map.obs;
    return '<span class="lv ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  /** 默认的处理范围与局限（与界面顶部提示一致，报告里给完整版） */
  var DEFAULT_LIMITS = [
    '图片、截图、图表内的文字不在处理范围内（本工具不做 OCR）。',
    'PDF 与旧版二进制 Office 格式（.doc / .xls / .ppt）不在处理范围内。',
    '宏（VBA）内的文本无法自动处理，需人工复核。',
    '嵌入的 OLE 对象需人工复核。',
    '无命中不等于安全，重要文件请人工复核后分发。'
  ];

  /** 默认的本次做法说明：让读者知道结论是怎么来的（参照 REA 的 Methodology 一节） */
  var DEFAULT_STEPS = [
    '按当前词库对文件全文做归一化匹配（剔除零宽字符、折叠全角与空格、容忍符号插字与繁体写法）。',
    'Word / Excel / PPT 直接改写内部 XML，覆盖正文、页眉页脚、脚注批注、文本框与元数据。',
    '按所选作用范围处理，再按全文复查一遍范围外的残留。',
    '逐文件统计命中处数与命中词，汇总成本报告。'
  ];

  /**
   * @param {Object} o
   *   title       报告标题
   *   conclusion  结论先行（一段话：查了什么、结果如何、下一步）；不传则不渲染该段
   *   summary     [[key, value, kind, evidence], ...] 概要表
   *               kind：obs|der|inf 证据分级（默认 obs）
   *               evidence：该结论的依据说明，显示为灰字（可省）
   *   steps       本次怎么做的（方法说明，字符串数组）；不传则用默认四条
   *   limits      处理范围与局限：基础五条 + 本次实际发生的（动态追加）
   *   rows        [{file, hits, matched[], status, note}]
   *   cols        [{k, label, width?}] 明细列（默认 路径 / 类型 / 命中 / 命中词 / 状态）
   *   note        页脚补充说明（可省）
   */
  function build(o) {
    o = o || {};
    var title = o.title || '文档敏感词检查报告';
    var conclusion = o.conclusion || '';
    var review = o.review || '';
    var summary = o.summary || [];
    var rows = o.rows || [];
    var steps = o.steps || DEFAULT_STEPS;
    var extraLimits = o.extraLimits || [];
    var limits = DEFAULT_LIMITS.concat(extraLimits);
    var cols = o.cols || [
      { k: 'file', label: '文件路径' },
      { k: 'hits', label: '命中处数', width: '70px' },
      { k: 'matched', label: '命中词' },
      { k: 'status', label: '状态', width: '80px' }
    ];
    var h = [];
    h.push('<!DOCTYPE html>');
    h.push('<html lang="zh-CN"><head><meta charset="UTF-8">');
    h.push('<title>' + esc(title) + '</title>');
    h.push('<style>' + CSS + '</style></head><body>');
    h.push('<h1>' + esc(title) + '</h1>');
    h.push('<p class="sub">由「文档敏感词批量清除工具」生成 · ' + esc(o.generatedAt || '') + '</p>');
    if (conclusion) {
      h.push('<div class="concl"><strong>结论</strong>' + esc(conclusion) + '</div>');
    }
    if (review) {
      h.push('<div class="review"><strong>复核意见</strong>' + esc(review) + '</div>');
    }
    if (summary.length) {
      h.push('<table><caption>概要</caption><tbody>');
      summary.forEach(function (kv) {
        var kind = kv[2] || 'obs';
        var ev = kv[3];
        var val = esc(kv[1]);
        if (ev) val += ' <span class="ev">' + esc(ev) + '</span>';
        h.push('<tr><td class="k">' + esc(kv[0]) + '</td><td>' + levelTag(kind) + val + '</td></tr>');
      });
      h.push('</tbody></table>');
    }
    h.push('<table><caption>明细（' + rows.length + ' 条）</caption><thead><tr>');
    cols.forEach(function (c) {
      h.push('<th' + (c.width ? ' style="width:' + esc(c.width) + '"' : '') + '>' + esc(c.label) + '</th>');
    });
    h.push('</tr></thead><tbody>');
    if (!rows.length) {
      h.push('<tr><td colspan="' + cols.length + '">无记录</td></tr>');
    }
    rows.forEach(function (r) {
      h.push('<tr>');
      cols.forEach(function (c) {
        var v = r[c.k];
        if (c.k === 'matched') v = (v || []).join('、') || '—';
        else if (c.k === 'status') { h.push('<td>' + statusTag(v) + '</td>'); return; }
        else if (c.k === 'hits') v = (v == null ? '-' : v);
        h.push('<td>' + esc(v) + '</td>');
      });
      h.push('</tr>');
    });
    h.push('</tbody></table>');
    h.push('<table><caption>本次做法</caption><tbody><tr><td>');
    h.push('<ul class="limits">' + steps.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
    h.push('</td></tr></tbody></table>');
    h.push('<table><caption>处理范围与局限</caption><tbody><tr><td>');
    h.push('<ul class="limits">' + limits.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
    h.push('</td></tr></tbody></table>');
    h.push('<p class="foot">' + esc(o.note || '本报告由本地工具生成，数据未离开本机。') + '</p>');
    h.push('</body></html>');
    return h.join('\n');
  }

  root.DWRReportHtml = { build: build };
})(typeof window !== 'undefined' ? window : globalThis);
