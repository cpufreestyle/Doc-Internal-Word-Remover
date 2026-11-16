/* v4.92 XML 报告导出：把检查结果写成 .xml。
   外部保密检查系统（鼎普等）可导出 HTML / XML / Word / PDF 四种，
   我们原来有 HTML / Word / JSON / CSV，缺一种「给别的系统读」的 XML。
   零依赖、纯字符串拼装；内容与 js/reporthtml.js、js/reportdocx.js 一一对应：
   同样的标题、结论、概要、本次做法、局限、明细表，换成 XML 元素。
   元素名用英文（机器读），内容用中文（人读）；列的显示名放在 <Columns> 里对应，
   这样外部系统按 key 取字段、不受界面改名影响。 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /** 元素名合法化：只保留 XML 名允许的字符，开头必须是字母或下划线 */
  function elName(k) {
    var s = String(k == null ? '' : k).replace(/[^A-Za-z0-9_.\-]/g, '_');
    if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
    return s || '_field';
  }

  /** 数组值用顿号拼（与 HTML / Word 报告口径一致），空值给空串 */
  function flat(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.join('、');
    return String(v);
  }

  /** 明细单元格：数组摊成多个子元素，标量直接写文本 */
  function cellXml(tag, v, indent) {
    var pad = indent || '        ';
    if (Array.isArray(v)) {
      if (!v.length) return pad + '<' + tag + ' count="0"/>';
      var out = [pad + '<' + tag + ' count="' + v.length + '">'];
      v.forEach(function (x) {
        out.push(pad + '  <Term>' + esc(flat(x)) + '</Term>');
      });
      out.push(pad + '</' + tag + '>');
      return out;
    }
    return pad + '<' + tag + '>' + esc(flat(v)) + '</' + tag + '>';
  }

  /** 生成整份 XML 文档（返回字符串） */
  function documentXml(o) {
    o = o || {};
    var L = [];
    var title = o.title || '文档敏感词检查报告';
    var cols = (o.cols && o.cols.length) ? o.cols : [
      { k: 'file', label: '文件路径' },
      { k: 'hits', label: '命中处数' },
      { k: 'matched', label: '命中词' },
      { k: 'status', label: '状态' }
    ];
    var rows = o.rows || [];

    L.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    L.push('<InspectionReport xmlns="urn:doc-internal-word-remover:report:1" version="1.0" generator="文档敏感词批量清除工具">');
    L.push('  <Title>' + esc(title) + '</Title>');
    L.push('  <GeneratedAt>' + esc(o.generatedAt || '') + '</GeneratedAt>');
    if (o.conclusion) L.push('  <Conclusion>' + esc(o.conclusion) + '</Conclusion>');
    if (o.review) L.push('  <Review>' + esc(o.review) + '</Review>');
    if (o.note) L.push('  <Note>' + esc(o.note) + '</Note>');

    var summary = o.summary || [];
    if (summary.length) {
      L.push('  <Summary count="' + summary.length + '">');
      summary.forEach(function (kv) {
        L.push('    <Item>');
        L.push('      <Label>' + esc(kv[0] == null ? '' : kv[0]) + '</Label>');
        L.push('      <Value>' + esc(kv[1] == null ? '' : String(kv[1])) + '</Value>');
        L.push('      <Kind>' + esc(kv[2] || 'obs') + '</Kind>');
        if (kv[3]) L.push('      <Evidence>' + esc(kv[3]) + '</Evidence>');
        L.push('    </Item>');
      });
      L.push('  </Summary>');
    }

    var steps = o.steps || [];
    if (steps.length) {
      L.push('  <Method count="' + steps.length + '">');
      steps.forEach(function (s, i) {
        L.push('    <Step index="' + (i + 1) + '">' + esc(s) + '</Step>');
      });
      L.push('  </Method>');
    }

    var limits = (o.limits || []).concat(o.extraLimits || []);
    if (limits.length) {
      L.push('  <Limits count="' + limits.length + '">');
      limits.forEach(function (s) { L.push('    <Limit>' + esc(s) + '</Limit>'); });
      L.push('  </Limits>');
    }

    // 人工判定清单：外部系统传进来的是「文本：结论」用分号串起来的整段，这里拆成逐条
    if (o.reviewList) {
      var items = String(o.reviewList).split('；').filter(function (t) { return t.trim(); });
      if (items.length) {
        L.push('  <ReviewList count="' + items.length + '">');
        items.forEach(function (t) { L.push('    <Item>' + esc(t.trim()) + '</Item>'); });
        L.push('  </ReviewList>');
      }
    }

    L.push('  <Details>');
    L.push('    <Columns count="' + cols.length + '">');
    cols.forEach(function (c) {
      L.push('      <Column key="' + esc(c.k) + '" label="' + esc(c.label || c.k) + '"/>');
    });
    L.push('    </Columns>');
    L.push('    <Rows count="' + rows.length + '">');
    rows.forEach(function (r, i) {
      L.push('      <Row index="' + (i + 1) + '">');
      var done = {};
      cols.forEach(function (c) {
        done[c.k] = true;
        L.push(cellXml(elName(c.k), r[c.k], '        '));
      });
      // 列之外的字段也别丢：外部系统常常要看命中位置、交叉校验结论这类附加列
      Object.keys(r).forEach(function (k) {
        if (done[k]) return;
        L.push(cellXml(elName(k), r[k], '        '));
      });
      L.push('      </Row>');
    });
    L.push('    </Rows>');
    L.push('  </Details>');
    L.push('</InspectionReport>');
    return L.join('\n');
  }

  /** 生成 .xml（返回 Blob；无 Blob 环境时退回字符串，方便测试与命令行用） */
  function build(o) {
    var xml = documentXml(o);
    if (typeof Blob === 'undefined') return xml;
    return new Blob([xml], { type: 'application/xml;charset=utf-8' });
  }

  root.DWRReportXml = { build: build, documentXml: documentXml };
})(typeof window !== 'undefined' ? window : globalThis);
