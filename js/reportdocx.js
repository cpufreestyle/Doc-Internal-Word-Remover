/* v4.91 Word 报告导出：把检查结果写成 .docx。
   外部保密检查系统（鼎普等）的报告可导出 HTML / XML / Word / PDF 四种，
   我们原来只有 HTML / JSON / CSV 三种：HTML 能打印成 PDF，JSON/CSV 只能给机器看，
   交整改报告时缺一份「能直接在 Word 里改、盖电子章」的稿子。
   这里用自带的 zip 打包器（js/zip.js 的 pack）直接生成 OOXML，不引任何外部依赖。
   生成结构与 js/reporthtml.js 的 HTML 报告一一对应：同样的标题、结论、概要、
   本次做法、局限、明细表，方便同一批结果换两种格式看。
   表格宽度按明细列数自适应（A4 横向），长路径列多给一些，其余均分。 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 段落：text 可为字符串；opts.bold / opts.size(半点) / opts.align / opts.style */
  function para(text, opts) {
    opts = opts || {};
    var rPr = '';
    if (opts.bold) { rPr += '<w:b/>'; }
    if (opts.size) { rPr += '<w:sz w:val="' + opts.size + '"/><w:szCs w:val="' + opts.size + '"/>'; }
    if (rPr) { rPr = '<w:rPr>' + rPr + '</w:rPr>'; }
    var pPr = '<w:pPr>';
    if (opts.style) { pPr += '<w:pStyle w:val="' + opts.style + '"/>'; }
    if (opts.align) { pPr += '<w:jc w:val="' + opts.align + '"/>'; }
    if (opts.spacing) { pPr += '<w:spacing w:before="' + opts.spacing + '" w:after="60"/>'; }
    pPr += '<w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>'
      + (opts.bold ? '<w:b/>' : '') + '</w:rPr></w:pPr>';
    var body = (text === '' || text == null) ? '' : '<w:r>' + rPr
      + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
    return '<w:p>' + pPr + body + '</w:p>';
  }

  /** 表格：第一行为表头。cells 为二维字符串数组；widths 为各列宽度（twips） */
  function table(head, rows, widths) {
    var total = widths.reduce(function (a, b) { return a + b; }, 0);
    var grid = widths.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('');
    var border = '<w:tblBorders>'
      + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(function (side) {
        return '<w:' + side + ' w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>';
      }).join('')
      + '</w:tblBorders>';
    var h = ['<w:tbl><w:tblPr><w:tblW w:w="' + total + '" w:type="dxa"/>' + border
      + '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>'];

    function cell(text, w, isHead) {
      var rPr = '<w:rPr>' + (isHead ? '<w:b/>' : '') + '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
      var pPr = '<w:pPr><w:spacing w:before="20" w:after="20"/>'
        + '<w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/>'
        + (isHead ? '<w:b/>' : '') + '<w:sz w:val="18"/></w:rPr></w:pPr>';
      return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
        + '<w:vAlign w:val="center"/></w:tcPr>'
        + '<w:p>' + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p></w:tc>';
    }

    h.push('<w:tr><w:trPr><w:tblHeader/></w:trPr>');
    head.forEach(function (t, i) { h.push(cell(t, widths[i], true)); });
    h.push('</w:tr>');
    rows.forEach(function (r) {
      h.push('<w:tr>');
      for (var i = 0; i < head.length; i++) { h.push(cell(r[i] == null ? '' : r[i], widths[i], false)); }
      h.push('</w:tr>');
    });
    h.push('</w:tbl>');
    h.push('<w:p><w:pPr><w:spacing w:after="80"/></w:pPr></w:p>');
    return h.join('');
  }

  /** 明细列宽：按内容长度粗估，长路径列多给一些，其余均分 */
  function planWidths(cols, rows) {
    var usable = 15400;
    var w = cols.map(function (c) {
      var maxLen = (c.label || '').length;
      rows.slice(0, 200).forEach(function (r) {
        var v = r[c.k];
        if (Array.isArray(v)) { v = v.join('、'); }
        else if (v == null) { v = ''; }
        else { v = String(v); }
        if (v.length > maxLen) { maxLen = v.length; }
      });
      return Math.min(Math.max(maxLen, 4), 60);
    });
    var sum = w.reduce(function (a, b) { return a + b; }, 0) || 1;
    var out = w.map(function (x) { return Math.max(700, Math.round(usable * x / sum)); });
    var diff = usable - out.reduce(function (a, b) { return a + b; }, 0);
    out[out.length - 1] += diff;
    return out;
  }

  /** 明细表单元格取值：口径与 HTML 报告保持一致 */
  function cellText(col, row) {
    var v = row[col.k];
    if (col.k === 'matched') {
      v = (v || []).join('、') || '—';
    } else if (col.k === 'hits') {
      v = (v == null ? '-' : v);
    } else if (v == null) {
      v = '';
    } else if (Array.isArray(v)) {
      v = v.join('、');
    } else {
      v = String(v);
    }
    return v;
  }

  /** 生成 word/document.xml 的正文（不含打包） */
  function documentXml(o) {
    var body = [];
    var title = o.title || '检查报告';
    body.push(para(title, { style: 'Title' }));
    body.push(para('由「文档敏感词批量清除工具」生成 · ' + (o.generatedAt || ''), { size: 18 }));
    if (o.conclusion) {
      body.push(para('结论', { bold: true, size: 22, spacing: 120 }));
      body.push(para(o.conclusion, { size: 20 }));
    }
    if (o.summary && o.summary.length) {
      body.push(para('概要', { bold: true, size: 22, spacing: 120 }));
      var sRows = o.summary.map(function (s) {
        return [s[0] == null ? '' : s[0], s[1] == null ? '' : String(s[1]), s[3] || ''];
      });
      body.push(table(['项目', '结论', '依据'], sRows, [2600, 6400, 6400]));
    }
    var steps = o.steps && o.steps.length ? o.steps : [];
    if (steps.length) {
      body.push(para('本次做法', { bold: true, size: 22, spacing: 120 }));
      steps.forEach(function (s, i) {
        body.push(para((i + 1) + '. ' + s, { size: 20 }));
      });
    }
    if (o.limits && o.limits.length) {
      body.push(para('处理范围与局限', { bold: true, size: 22, spacing: 120 }));
      o.limits.forEach(function (s) { body.push(para('· ' + s, { size: 20 })); });
    }
    var cols = (o.cols && o.cols.length)
      ? o.cols
      : [{ k: 'file', label: '路径' }, { k: 'hits', label: '命中处数' },
         { k: 'matched', label: '命中词' }, { k: 'status', label: '状态' }];
    var rows = o.rows || [];
    body.push(para('明细', { bold: true, size: 22, spacing: 120 }));
    var head = cols.map(function (c) { return c.label || c.k; });
    var bodyRows = rows.map(function (r) {
      return cols.map(function (c) { return cellText(c, r); });
    });
    body.push(table(head, bodyRows, planWidths(cols, rows)));
    if (o.note) { body.push(para(o.note, { size: 18 })); }
    body.push('<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
      + '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"'
      + ' w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body>' + body.join('') + '</w:body></w:document>';
  }

  var CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';

  var ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  var DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  var STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:cs="Microsoft YaHei"/>'
    + '<w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
    + '<w:pPr><w:spacing w:after="60" w:line="280" w:lineRule="auto"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
    + '<w:pPr><w:spacing w:after="60"/></w:pPr>'
    + '<w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>'
    + '</w:styles>';

  /**
   * 生成 .docx（返回 Blob）。
   * @param {Object} o 与 DWRReportHtml.build 相同的入参
   * @returns {Promise<Blob>}
   */
  function build(o) {
    o = o || {};
    if (!root.DWRZip || !root.DWRZip.pack) {
      return Promise.reject(new Error('缺少 zip 打包器，无法生成 Word 报告'));
    }
    var files = [
      { name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
      { name: 'word/styles.xml', data: STYLES },
      { name: 'word/document.xml', data: documentXml(o) }
    ];
    return Promise.resolve(root.DWRZip.pack(files));
  }

  root.DWRReportDocx = { build: build, documentXml: documentXml };
})(typeof window !== 'undefined' ? window : globalThis);
