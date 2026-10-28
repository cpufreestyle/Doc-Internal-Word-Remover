/**
 * ooxml.js —— 文档处理核心
 * 1) 纯文本类：txt md csv log json xml html ini cfg yml sql 等
 * 2) Office 类：docx / xlsx / pptx（OOXML，直接改写内部 XML）
 *
 * 关键点：Word 常把一个词拆进多个 <w:t> run（如"内"+"部"），
 * 逐 run 替换会漏网。本模块采用「段落级重建」：
 * 先合并段落内全部文本，命中后回写第一个 run、其余 run 清空，
 * 从而保证跨 run 的敏感词也能被彻底清除。
 */
(function (global) {
  'use strict';

  var Zip = global.DWRZip;

  var OOXML_LIMITS = {
    maxEmbedDepth: 3,
    maxEmbedDocuments: 32,
    maxEmbedBytes: 256 * 1024 * 1024,
    maxOfficeMillis: 180000
  };

  function officeBudget(rootBytes) {
    return {
      depth: 0,
      documents: 0,
      bytes: rootBytes || 0,
      started: Date.now()
    };
  }

  function assertNestedBudget(budget, bytes, depth) {
    if (depth >= OOXML_LIMITS.maxEmbedDepth) {
      throw new Error('内嵌 Office 文档递归超过安全深度（' + OOXML_LIMITS.maxEmbedDepth + ' 层）');
    }
    if (budget.documents >= OOXML_LIMITS.maxEmbedDocuments) {
      throw new Error('内嵌 Office 文档数量超过安全上限（' + OOXML_LIMITS.maxEmbedDocuments + ' 个）');
    }
    if (budget.bytes + bytes > OOXML_LIMITS.maxEmbedBytes) {
      throw new Error('内嵌 Office 文档累计大小超过安全上限（'
        + Math.round(OOXML_LIMITS.maxEmbedBytes / 1048576) + ' MB）');
    }
    if (Date.now() - budget.started > OOXML_LIMITS.maxOfficeMillis) {
      throw new Error('Office 文档解析超过安全时限（' + Math.round(OOXML_LIMITS.maxOfficeMillis / 1000) + ' 秒）');
    }
    budget.documents++;
    budget.bytes += bytes;
  }

  /* ---------------- XML 实体 ---------------- */

  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

  function encodeXml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  function decodeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }

  /* ---------------- 文本编解码 ---------------- */

  var BOM = '\uFEFF';

  function decodeText(buf) {
    var u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    var encoding = 'utf-8';
    var text;
    // UTF-16 带 BOM（Windows 记事本「Unicode」保存的格式）：必须先按 UTF-16 解码，
    // 否则中文会变成夹带 NUL 的乱码、敏感词整文件漏报；写回时统一转为 UTF-8 + BOM
    if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) {
      try {
        text = new TextDecoder('utf-16le').decode(u8);
        return { text: text, encoding: 'utf-16le', bom: true };
      } catch (e0) { /* 引擎不支持时退回流式解码 */ }
    } else if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) {
      try {
        text = new TextDecoder('utf-16be').decode(u8);
        return { text: text, encoding: 'utf-16be', bom: true };
      } catch (e0) { /* 引擎不支持时退回流式解码 */ }
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
    } catch (e) {
      try {
        text = new TextDecoder('gbk').decode(u8);
        encoding = 'gbk';
      } catch (e2) {
        text = new TextDecoder('utf-8').decode(u8);
      }
    }
    // TextDecoder('utf-8') 默认吞掉 BOM，所以「文本首字符是不是 BOM」判不出 UTF-8 BOM；
    // 必须看原始字节，否则带 BOM 的 .csv/.txt 脱敏写回后丢 BOM，中文 Windows 双击乱码。
    var utf8Bom = u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
    return { text: text, encoding: encoding, bom: utf8Bom || text.charAt(0) === BOM };
  }

  function encodeText(text, withBom, encoding) {
    // TextEncoder 仅支持 UTF-8。若原文件为 GBK 等非 UTF-8 编码，写回时强制带 BOM，
    // 以保证中文 Windows 记事本等按 UTF-8 读取不出现乱码（编码已隐式转为 UTF-8）。
    if (encoding && encoding !== 'utf-8' && encoding !== 'utf8') withBom = true;
    var bytes = new TextEncoder().encode(text);
    if (!withBom) return bytes;
    var out = new Uint8Array(bytes.length + 3);
    out[0] = 0xef; out[1] = 0xbb; out[2] = 0xbf;
    out.set(bytes, 3);
    return out;
  }

  /* ---------------- 支持的文件类型 ---------------- */

  var TEXT_EXT = [
    // 文档 / 数据
    'txt', 'text', 'md', 'markdown', 'rst', 'tex', 'log', 'lst', 'nfo', 'me', 'sub', 'srt', 'vtt',
    'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'xhtml', 'svg', 'sql', 'reg',
    // 配置
    'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'yml', 'yaml', 'toml',
    'gitignore', 'dockerignore', 'editorconfig',
    // 代码
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
    'py', 'java', 'kt', 'kts', 'scala', 'groovy',
    'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'go', 'rs',
    'rb', 'php', 'pl', 'lua', 'r', 'swift', 'dart',
    // 样式 / 脚本
    'css', 'scss', 'less', 'styl', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'vbs'
  ];

  // Office OOXML：普通文档 / 启用宏的文档 / 模板，四类均为同一 ZIP+XML 结构，处理方式完全一致
  var WORD_EXT = ['docx', 'docm', 'dotx', 'dotm'];
  var EXCEL_EXT = ['xlsx', 'xlsm', 'xltx', 'xltm'];
  var PPT_EXT = ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'];
  var OFFICE_EXT = WORD_EXT.concat(EXCEL_EXT, PPT_EXT);

  function extOf(name) {
    var i = String(name).lastIndexOf('.');
    return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
  }

  /* v4.3 主流格式：默认扫描范围。日常办公文档一档，
     不含源码 / 配置 / 构建产物（命中率低且显著拖慢整盘扫描）。
     用户可在界面增删，或切回「全部支持格式」。 */
  var COMMON_EXT = ['docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'rtf', 'docm', 'xlsm', 'pptm'];

  /** 当前生效的扩展名过滤器：null 表示不限制（全部支持格式） */
  var extFilter = null;

  /** 设置扩展名过滤器；传 null / 空数组表示不限制 */
  function setExtFilter(list) {
    if (!list || !list.length) { extFilter = null; return; }
    extFilter = list.map(function (x) { return String(x).trim().toLowerCase().replace(/^\.+/, ''); }).filter(Boolean);
  }

  /** 取当前过滤器（null 表示不限制） */
  function getExtFilter() { return extFilter ? extFilter.slice() : null; }

  function isTextFile(name) { return TEXT_EXT.indexOf(extOf(name)) >= 0; }
  function isOfficeFile(name) { return OFFICE_EXT.indexOf(extOf(name)) >= 0; }
  function isSupported(name) {
    if (extFilter && extFilter.indexOf(extOf(name)) < 0) return false;
    return isTextFile(name) || isOfficeFile(name);
  }

  /** 归类：'doc' | 'xls' | 'ppt' | 'txt'（供界面标签与报告统一使用） */
  function kindOf(name) {
    var e = extOf(name);
    if (WORD_EXT.indexOf(e) >= 0) return 'doc';
    if (EXCEL_EXT.indexOf(e) >= 0) return 'xls';
    if (PPT_EXT.indexOf(e) >= 0) return 'ppt';
    return 'txt';
  }

  /* ---------------- 纯文本处理 ---------------- */

  function processText(text, engine, encoding) {
    var hasBom = text.charAt(0) === BOM;
    var body = hasBom ? text.slice(1) : text;

    var crlf = body.indexOf('\r\n') >= 0;
    var lines = body.split(/\r\n|\r|\n/);

    // 首行 / 尾行定位：取首个与最后一个「非空白」行（跳过前后空行）
    var firstIdx = -1, lastIdx = -1;
    for (var fi = 0; fi < lines.length; fi++) {
      if (lines[fi].replace(/\s/g, '') !== '') {
        if (firstIdx < 0) firstIdx = fi;
        lastIdx = fi;
      }
    }

    var hits = 0;
    var hitChars = 0;
    var totalChars = 0;
    var matched = [];
    var firstHit = false, lastHit = false;
    var out = lines.map(function (line, i) {
      var r = engine.apply(line, i === firstIdx, i === lastIdx);
      hits += r.hits;
      hitChars += (r.hitChars || 0);
      totalChars += line.replace(/\s/g, '').length;
      if (r.hits > 0) {
        if (r.atFirst) firstHit = true;
        if (r.atLast) lastHit = true;
      }
      r.matched.forEach(function (m) {
        if (matched.indexOf(m) === -1) matched.push(m);
      });
      return r.text;
    });

    var result = out.join('\n');
    if (crlf) result = result.replace(/\n/g, '\r\n');

    return {
      text: hasBom ? BOM + result : result,
      hits: hits,
      hitChars: hitChars,
      totalChars: totalChars,
      ratio: totalChars > 0 ? hitChars / totalChars : 0,
      matched: matched,
      touched: hits > 0,
      encoding: encoding,
      firstHit: firstHit,
      lastHit: lastHit
    };
  }

  /* ---------------- OOXML 内部 XML 处理 ---------------- */

  /**
   * 预览专用：与 processText 同口径，但把 extractText 加的定位行（`[正文]`，早期为 `[word/document.xml]`）
   * 排除在首 / 尾行判定之外。
   * 原因：那些行是抽取时打的定位标记，不是文档内容。若不排除，真实首段会落到第 2 行，
   * scope=first 时永远判不中首行，预览的「处理后」与原文一字不差——用户核对不出处理效果。
   * 真实处理走 processXml 按块判定，没有这个问题，所以只影响预览。
   * 返回的行号（firstIdx/lastIdx）供高亮栏共用，两栏看到的「首 / 尾行」始终一致。
   */
  function previewProcess(text, engine, marks) {
    var lines = String(text).split(/\r\n|\r|\n/);
    var isHead = /^\[[^\]\r\n]*\]$/;
    var firstIdx = -1, lastIdx = -1;
    // 无 marks（兼容旧调用）时退回「全文档首 / 尾行」口径；Office 预览一律带 marks，
    // 由 extractPreview 按「逐部件、逐块组」算好，与 processXml 的真实处理完全一致：
    // 真实处理是每个部件、每个块组各自判首尾（页眉 / 文档属性等附属部件整部件算首尾），
    // 用全局首尾会让「正文尾段、附属部件」的命中在预览里既不显示清除、也不高亮——
    // 用户按预览核对会以为漏清，实际处理结果却对不上。
    if (!marks) {
      for (var i = 0; i < lines.length; i++) {
        if (isHead.test(lines[i])) continue;   // 部件标记行不算内容
        if (lines[i].replace(/\s/g, '') !== '') {
          if (firstIdx < 0) firstIdx = i;
          lastIdx = i;
        }
      }
    }

    var hits = 0;
    var matched = [];
    var firstHit = false, lastHit = false;
    var outMarks = marks ? new Array(lines.length) : null;
    var out = lines.map(function (line, i) {
      var mk = (marks && i < marks.length) ? marks[i] : null;
      var f = marks ? !!(mk && mk.first) : (i === firstIdx);
      var l = marks ? !!(mk && mk.last) : (i === lastIdx);
      if (outMarks) outMarks[i] = mk ? { first: f, last: l } : null;
      var r = engine.apply(line, f, l);
      hits += r.hits;
      if (r.hits > 0) {
        if (r.atFirst) firstHit = true;
        if (r.atLast) lastHit = true;
      }
      r.matched.forEach(function (m) {
        if (matched.indexOf(m) === -1) matched.push(m);
      });
      return r.text;
    });

    return {
      text: out.join('\n'),
      hits: hits,
      matched: matched,
      touched: hits > 0,
      firstHit: firstHit,
      lastHit: lastHit,
      firstIdx: firstIdx,
      lastIdx: lastIdx,
      marks: outMarks
    };
  }

  function mergeMatch(counter, res) {
    counter.hits += res.hits;
    counter.hitChars += (res.hitChars || 0);
    res.matched.forEach(function (m) {
      if (counter.matched.indexOf(m) === -1) counter.matched.push(m);
    });
    if (res.hits > 0) {
      if (res.atFirst) counter.firstHit = true;
      if (res.atLast) counter.lastHit = true;
    }
  }

  /** 段落级重建：blockRe 匹配段落，tag 为文本节点标签。
   *  首/尾语义：以「首个/最后一个含非空白文本的块」为准（供 scope=firstlast 使用）。 */
/**
   * 跨 run 合并后会留下被清空的运行（`<w:r><w:t></w:t></w:r>`）：不影响阅读，但让输出 XML 变脏。
   * 只清理「仅含可选 rPr + 单个空白文本节点」的运行——含 <w:br/> / <w:tab/> / <w:drawing/> 等
   * 其它内容的运行一律保留（删掉会改变换行与排版）。
   * 判定必须按 <x:r> 边界逐个进行，不能写成一条跨 run 的正则：可选 rPr 组里的 [\s\S]*?</x:rPr>
   * 在回溯时会越过若干 run 去接后面的 </x:rPr>，于是「带 rPr 且仍有文字的 run」后面只要跟一个
   * 带 rPr 的空运行，匹配就从前者起跳，把中间的 run 连文字一起吞掉（实测三段 run 会被删成空段）。
   */
  var RUN_SPAN_RE = { w: /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g, a: /<a:r(?:\s[^>]*)?>[\s\S]*?<\/a:r>/g };
  // 可选 rPr 前缀：自闭合（<w:rPr b="1"/>，drawingML 常见）与成对两种形态都支持
  var RPR_HEAD_RE = {
    w: /^\s*<w:rPr(?:\s[^>]*?)?(?:\/>|[\s\S]*?<\/w:rPr>)\s*/,
    a: /^\s*<a:rPr(?:\s[^>]*?)?(?:\/>|[\s\S]*?<\/a:rPr>)\s*/
  };
  /** 块内全部 <x:r> 区间（run 不嵌套，升序返回），用于把文本节点定位回它所属的 run */
  function blockRuns(raw, prefix) {
    var re = RUN_SPAN_RE[prefix];
    var out = [];
    if (!re) return out;
    re.lastIndex = 0;
    var m;
    while ((m = re.exec(raw)) !== null) out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
    return out;
  }
  /** run 内除了 nodeEl 只剩可选 rPr（自闭合 / 成对）——只有这种 run 才能在文本节点被清空后整段删掉 */
  function runOnlyHoldsNode(runRaw, prefix, nodeEl) {
    var body = runRaw.slice(runRaw.indexOf(">") + 1, runRaw.length - (("</" + prefix + ":r>").length));
    body = body.replace(RPR_HEAD_RE[prefix], "");
    return body.replace(/\s+/g, "") === nodeEl.replace(/\s+/g, "");
  }

  function replaceBlocks(xml, blockRe, tag, engine, counter, full, range) {
    // 快速跳过：部件里没有该文本节点时不做任何扫描（大多数 docx 无 w:delText / w:instrText）
    if (xml.indexOf('<' + tag) === -1) return xml;
    var ci = tag.indexOf(':');
    var runPrefix = ci > 0 ? tag.slice(0, ci) : '';
    var re = new RegExp(blockRe.source, 'g');
    var tReSrc = '<' + tag + '(\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>';

    // 第一遍：收集全部块并解析文本节点，确定首/尾块
    var blocks = [];
    var m;
    while ((m = re.exec(xml)) !== null) {
      var raw = m[0];
      var tRe = new RegExp(tReSrc, 'g');
      var parts = [];
      var plain = '';
      var tm;
      while ((tm = tRe.exec(raw)) !== null) {
        parts.push({
          start: tm.index,
          end: tm.index + tm[0].length,
          attrs: tm[1] || '',
          text: decodeXml(tm[2])
        });
        plain += decodeXml(tm[2]);
      }
      blocks.push({ start: m.index, end: m.index + raw.length, raw: raw, parts: parts, plain: plain });
    }
    if (!blocks.length) return xml;

    // 首 / 尾块下标：processXml 按标签分组后统一算好传进来；没传时按本组自己的块算
    var firstIdx = -1, lastIdx = -1, firstSet = null, lastSet = null;
    if (range) {
      firstIdx = range.firstIdx;
      lastIdx = range.lastIdx;
      firstSet = range.firstSet;
      lastSet = range.lastSet;
    } else {
      for (var i = 0; i < blocks.length; i++) {
        if (blocks[i].parts.length && blocks[i].plain.replace(/\s/g, '') !== '') {
          if (firstIdx < 0) firstIdx = i;
          lastIdx = i;
        }
      }
    }

    // 第二遍：逐块重建（未命中的块按原字节保留）
    var out = '';
    var cursor = 0;
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      out += xml.slice(cursor, b.start);
      cursor = b.end;

      if (!b.parts.length) { out += b.raw; continue; }

      // firstSet / lastSet：外层首段 / 尾段内的所有块都算首 / 尾（v2.25 多段文本框）
      var isFirst = !!full || bi === firstIdx || (!!firstSet && firstSet.indexOf(bi) >= 0);
      var isLast = !!full || bi === lastIdx || (!!lastSet && lastSet.indexOf(bi) >= 0);
      var res = engine.apply(b.plain, isFirst, isLast);
      // 命中百分比分母：全文有效字符（去空白）。必须在「未命中就 continue」之前累计，
      // 否则大段未命中正文不计入分母，百分比会虚高到离谱。
      if (counter) counter.totalChars += b.plain.replace(/\s/g, '').length;
      if (res.text === b.plain) { out += b.raw; continue; }
      mergeMatch(counter, res);

      // 本次合并会把 pi>0 的文本节点全部清空（首个节点承载全部文本）。只有「被这次合并清空」
      // 的 run 才允许整段删掉：块内其它本来就是空白的 run 必须原样保留——典型是嵌在文本框里的
      // 段落，它的文本节点已改名、不属于本块的 part，那份空白不在合并文本里，删掉就是净丢失。
      // 含 <w:br/> / <w:drawing/> 等其它内容的 run 同样保留（删掉会改变换行与排版）。
      var drops = [];
      if (runPrefix && b.parts.length > 1) {
        var runs = blockRuns(b.raw, runPrefix);
        var ri = 0;
        b.parts.forEach(function (p, pi) {
          while (ri < runs.length && runs[ri].end <= p.start) ri++;
          // 首个节点承载合并后的全部文本，只有「合并后全空」时才随空 run 一起删掉
          if (pi === 0 && (res.text !== '' || p.text === '')) return;
          if (ri >= runs.length || runs[ri].start > p.start) return;
          var run = runs[ri];
          if (runOnlyHoldsNode(run.raw, runPrefix, b.raw.slice(p.start, p.end))) drops.push(run);
        });
      }
      var rebuilt = '';
      var last = 0;
      b.parts.forEach(function (p, pi) {
        var killed = null;
        for (var k = 0; k < drops.length; k++) {
          if (drops[k].start <= p.start && p.end <= drops[k].end) { killed = drops[k]; break; }
        }
        // 节点所在的整个 run 被删：run 之前的原文照搬，run 整体跳过
        if (killed) { rebuilt += b.raw.slice(last, killed.start); last = killed.end; return; }
        rebuilt += b.raw.slice(last, p.start);
        var attrs = p.attrs;
        if (pi === 0 && attrs.indexOf('xml:space') === -1 && /^\s|\s$/.test(res.text)) {
          attrs = ' xml:space="preserve"' + attrs;
        }
        var content = (pi === 0) ? encodeXml(res.text) : '';
        rebuilt += '<' + tag + attrs + '>' + content + '</' + tag + '>';
        last = p.end;
      });
      rebuilt += b.raw.slice(last);
      out += rebuilt;
    }
    out += xml.slice(cursor);
    return out;
  }

  /** 标签之间的文本节点（docProps 等结构简单文件）；
   *  首/尾以「首个/最后一个非空白文本节点」为准。 */
  function replaceTextNodes(xml, engine, counter, full) {
    var re = />([^<>]+)</g;
    var nodes = [];
    var m;
    while ((m = re.exec(xml)) !== null) {
      nodes.push({ start: m.index, end: m.index + m[0].length, inner: m[1] });
    }
    if (!nodes.length) return xml;

    var firstIdx = -1, lastIdx = -1;
    for (var i = 0; i < nodes.length; i++) {
      if (decodeXml(nodes[i].inner).replace(/\s/g, '') !== '') {
        if (firstIdx < 0) firstIdx = i;
        lastIdx = i;
      }
    }

    var out = '';
    var cursor = 0;
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      out += xml.slice(cursor, node.start);
      var dec = decodeXml(node.inner);
      var res = engine.apply(dec, !!full || ni === firstIdx, !!full || ni === lastIdx);
      if (counter) counter.totalChars += dec.replace(/\s/g, '').length;
      if (res.text === dec) {
        out += xml.slice(node.start, node.end);
      } else {
        mergeMatch(counter, res);
        out += '>' + encodeXml(res.text) + '<';
      }
      cursor = node.end;
    }
    out += xml.slice(cursor);
    return out;
  }

  /** 属性值（如 xlsx 工作表名）；首/尾以「首个/最后一个非空属性值」为准。 */
  function replaceAttrs(xml, engine, counter, full) {
    if (xml.indexOf('="') === -1) return xml;
    var re = /="([^"]*)"/g;
    var attrs = [];
    var m;
    while ((m = re.exec(xml)) !== null) {
      attrs.push({ start: m.index, end: m.index + m[0].length, value: m[1] });
    }
    if (!attrs.length) return xml;

    var firstIdx = -1, lastIdx = -1;
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].value !== '') {
        if (firstIdx < 0) firstIdx = i;
        lastIdx = i;
      }
    }

    var out = '';
    var cursor = 0;
    for (var ai = 0; ai < attrs.length; ai++) {
      var a = attrs[ai];
      out += xml.slice(cursor, a.start);
      var dec = decodeXml(a.value);
      var res = engine.apply(dec, !!full || ai === firstIdx, !!full || ai === lastIdx);
      // 命中百分比分母：与 replaceBlocks / replaceTextNodes 同口径，在「未命中就跳过」之前累计。
      // 否则命中只出现在属性值（Excel 工作表名、形状名、书签名等）时分母为 0，
      // 占比要么显示 0%（totalChars 为 0 时 ratio 取 0），要么虚高到 100%。
      if (counter) counter.totalChars += dec.replace(/\s/g, '').length;
      if (res.text === dec) {
        out += '="' + a.value + '"';
      } else {
        mergeMatch(counter, res);
        var enc = encodeXml(res.text);
        // 防止属性值被整段清空导致文档不合法（如工作表名 name="" 会让 Excel 提示修复）
        if (enc === '' && a.value !== '') enc = '***';
        out += '="' + enc + '"';
      }
      cursor = a.end;
    }
    out += xml.slice(cursor);
    return out;
  }

  /** 根据内部条目路径选择处理策略
   *  覆盖 Office 文档的全部文本部件：正文/页眉页脚/脚注/批注（w:p/w:t）、
   *  文本框与图示（a:p/a:t，drawingML）、工作表与共享字符串（si/is）、
   *  以及 xlsx 批注（comment/t）。 */
  function specFor(name) {
    var n = String(name).toLowerCase();
    if (!/\.(xml|rels)$/.test(n)) return null;
    // .rels 的 Target / Type 是结构引用：改写会让文档打不开（关系找不到目标），
    // 而「报了命中却清不掉」更容易误导用户，因此 .rels 一律不处理、不统计
    if (/\.rels$/.test(n)) return null;

    // 文档属性整部件处理：标题 / 主题 / 作者 / 关键字都是元数据，不该被「只清首尾行」放过
    if (/^docprops\//.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    // customXml（内容类型 / 文档管理属性等数据存储）同样是元数据：
    // 里面的节点没有「首行 / 尾行」语义，且属性值一样能 unzip 直读，
    // 因此按 docProps / workbook 的口径整部件处理
    if (/^customxml\//.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    // 图表部件（ppt/charts、xl/charts）：Excel 图表把类别名 / 系列名 / 数据点文字写在
    // <c:v> 里，图表内的富文本段落则是 <a:p> / <a:t>——unzip 原样读得到，
    // 却没有「首行 / 尾行」语义，因此整部件清理（rich 富值同样覆盖 <a:p> / <a:t>）
    if (/^(?:ppt|xl)\/charts\//.test(n)) {
      return {
        blocks: [
          { re: /<c:v(?:\s[^>]*)?>[\s\S]*?<\/c:v>/g, tag: 'c:v' },
          { re: /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g, tag: 'a:t' }
        ],
        attrs: true,
        attrsFull: true,
        full: true // 图表是自由文本，不跟随用户选择的首尾范围
      };
    }
    if (/^word\//.test(n)) {
      // 段落首尾口径：<w:p> 内任意文本标签（正文 w:t / 删除记录 w:delText / 域代码 w:instrText /
      // 文本框 a:t）有非空白文字，该段就算「首个 / 最后一个有效段」。
      // 文本框-only 的首 / 尾段因此也能被正确判为首尾；反过来嵌在中段段落里的文本框
      // 不会按 <a:p> 组自己的粒度被当成首 / 尾而误清（v2.21）。
      var paraRange = [{
        re: /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,
        tags: ['w:t', 'w:delText', 'w:instrText', 'a:t', 'w:dwr-nest\\d+-t']
      }];
      var wordBlocks = [
        { re: /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, tag: 'w:t', rangeFrom: paraRange,
          hasTags: ['w:t', 'w:delText', 'w:instrText', 'w:dwr-nest\\d+-t'] },
        { re: /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, tag: 'w:delText' },   // 跟踪修改的删除运行（历史记录仍可回收）
        { re: /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, tag: 'w:instrText' }, // 域代码（HYPERLINK / REF 等）
        { // 文本框 / 图示 / 形状（drawingML）：<a:p> 嵌在 <w:p> 里，算不算首尾由外层段落决定；
          // nested 表示「整个外层段算一行」，首段里的多段文本框要整块清（v2.25）
          re: /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g, tag: 'a:t', rangeFrom: paraRange, nested: true }
      ];
      var isBody = /^word\/document\.xml$/.test(n);
      return {
        blocks: wordBlocks,
        // 文本框内段落的块规格按实际嵌套层数在 processXml / extractFromSpec 里动态生成，
        // 它们与 <a:p> 一样共用这份「外层段落区间」来判首尾
        nestRangeFrom: paraRange,
        attrs: true, attrsFull: true, full: !isBody, maskNested: true
      };
    }
    if (/^xl\/tables\//.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    if (/^xl\/workbook\.xml$/.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    // 数据透视缓存 / 查询表：字段名与缓存记录可能含敏感文本（属性值与简单文本节点）
    if (/^xl\/pivotcache\//.test(n) || /^xl\/querytables\//.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    // 批注类部件：传统批注（comments*.xml，author 与批注正文）、现代批注（threadedComments/* 的 <text>）
    // 都是 unzip 即可读出的自由文本，且没有「首行 / 尾行」语义，因此整部件处理
    if (/^xl\/comments(?:\d+)?\.xml$/.test(n) || /^xl\/threadedcomments\//.test(n)) {
      return { textnodes: true, attrs: true, full: true };
    }
    if (/^xl\//.test(n)) {
      return {
        attrs: true,
        attrsFull: true,
        blocks: [
          { re: /<si(?:\s[^>]*)?>[\s\S]*?<\/si>/g, tag: 't' },
          { re: /<is(?:\s[^>]*)?>[\s\S]*?<\/is>/g, tag: 't' },
          { re: /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g, tag: 'a:t' },   // 绘图 / 图表（drawingML）
          { re: /<comment(?:\s[^>]*)?>[\s\S]*?<\/comment>/g, tag: 't' }, // 批注
          { re: /<f(?:\s[^>]*)?>[\s\S]*?<\/f>/g, tag: 'f' },             // 单元格公式里的字符串字面量
          { re: /<v(?:\s[^>]*)?>[\s\S]*?<\/v>/g, tag: 'v' },             // 公式计算结果的缓存值、richData 富值（unzip 原样读得到）
          // 数据验证下拉列表 / 条件格式公式：常见「公开,内部,机密,绝密」这类密级下拉，
          // unzip 即可原样读出。属于配置而非正文，因此不跟随用户选择的首尾范围
          { re: /<formula1(?:\s[^>]*)?>[\s\S]*?<\/formula1>/g, tag: 'formula1', full: true },
          { re: /<formula2(?:\s[^>]*)?>[\s\S]*?<\/formula2>/g, tag: 'formula2', full: true },
          { re: /<formula(?:\s[^>]*)?>[\s\S]*?<\/formula>/g, tag: 'formula', full: true }
        ]
      };
    }
    // 批注类部件（ppt/comments/*）：传统批注的正文在 <p:txBody><a:p><a:t> 里，
    // 而某些版本的现代批注把 <a:t> 直接挂在 <p:cm> 下（没有 <a:p> 包裹）——
    // 只有 <a:p> 块时这类文本整段漏掉。两类都是 unzip 即可读出的自由文本，整部件处理。
    if (/^ppt\/comments\//.test(n)) {
      return {
        blocks: [
          { re: /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g, tag: 'a:t' },
          // 仅匹配「内部没有 <a:p> 的 <p:cm>」（现代批注形态），与上面的 <a:p> 块（传统批注）不重叠
          { re: /<p:cm(?:\s[^>]*[^/\s])?>(?:(?!<\/?a:p[\s/>])[\s\S])*?<\/p:cm>/g, tag: 'a:t' }
        ],
        attrs: true,
        attrsFull: true,
        full: true
      };
    }
    if (/^ppt\//.test(n)) {
      // 只有 ppt/slides/* 是逐页显示的流动内容，才有「首 / 尾」可言（对应 word/document.xml）。
      // 版式 / 母版是占位符与页脚提示的模板，备注母版 / 讲义母版覆盖全部备注页与讲义页，
      // drawings（SmartArt 等图示）是自由文本——都没有「首行 / 尾行」语义；按首尾取范围等于只清
      // 该部件的第一个 / 最后一个文本块，中段的密级标识会整段留下（v2.23）。
      // 与 word 附属部件、xl/comments*、ppt/comments 的整部件口径保持一致。
      var isSlide = /^ppt\/slides\/[^/]+\.xml$/.test(n);
      return {
        blocks: [{ re: /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g, tag: 'a:t' }], // 幻灯片/版式/母版/备注/图示
        attrs: true, // 形状名称 / 替换文字（descr）等属性值
        attrsFull: true,
        full: !isSlide
      };
    }
    return null;
  }

  /** 文本节点正则按标签名缓存：块级判定会被调用上千次，没必要每次重新编译 */
  var TAG_TEXT_RE = {};
  function tagTextRe(tag) {
    var r = TAG_TEXT_RE[tag];
    if (!r) {
      r = new RegExp('<' + tag + '(\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g');
      TAG_TEXT_RE[tag] = r;
    }
    r.lastIndex = 0;
    return r;
  }

  /** 块内是否存在非空白文本（判定该块是否算「首个 / 最后一个有效块」） */
  function blockHasText(raw, tags) {
    for (var ti = 0; ti < tags.length; ti++) {
      var tRe = tagTextRe(tags[ti]);
      var tm;
      while ((tm = tRe.exec(raw)) !== null) {
        if (decodeXml(tm[2]).replace(/\s/g, '') !== '') return true;
      }
    }
    return false;
  }

  /** [start,end) 是否与任一给定绝对区间相交 */
  function inSpans(start, end, spans) {
    for (var i = 0; i < spans.length; i++) {
      if (start < spans[i][1] && end > spans[i][0]) return true;
    }
    return false;
  }

  /**
   * 「首个 / 最后一个含非空白文本的块」的绝对区间，供两类场景共用：
   *  - 嵌套块：word 的 <a:p>（文本框 / 图示 / 形状）嵌在 <w:p> 里，内层算不算首尾该由外层
   *    段落决定，否则中段段落里的文本框会按 <a:p> 组自己的粒度被当成首 / 尾而误清；
   *  - 跨存储形态：xlsx 的 <si>（共享字符串）与 <is>（内联字符串）是同一种「单元格文本」的两种
   *    存法，原先两套正则各自算首尾，混排时会分别清掉两组的首 / 尾，把中段内容连带误删。
   * entries: [{ re, tags }]；多个正则的匹配按文档顺序合并后统一取首尾。
   */
  function firstLastSpans(xml, entries) {
    if (entries.length === 1) {
      // 单组正则时流式一趟：只保留首 / 尾两个区间，不必为每个块建对象（大文档上是主要开销）
      var e0 = entries[0];
      var scan0 = new RegExp(e0.re.source, 'g');
      var m0, firstSpan = null, lastSpan = null;
      while ((m0 = scan0.exec(xml)) !== null) {
        if (!blockHasText(m0[0], e0.tags)) continue;
        var span = [m0.index, m0.index + m0[0].length];
        if (!firstSpan) firstSpan = span;
        lastSpan = span;
      }
      if (!firstSpan) return [];
      return firstSpan === lastSpan ? [firstSpan] : [firstSpan, lastSpan];
    }
    // 多组正则：匹配按文档顺序归并后统一取首尾
    var hits = [];
    entries.forEach(function (e) {
      var scan = new RegExp(e.re.source, 'g');
      var m;
      while ((m = scan.exec(xml)) !== null) {
        hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], tags: e.tags });
      }
    });
    if (!hits.length) return [];
    hits.sort(function (a, b) { return a.start - b.start; });
    var first = -1, last = -1;
    for (var i = 0; i < hits.length; i++) {
      if (blockHasText(hits[i].raw, hits[i].tags)) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return [];
    var spans = [[hits[first].start, hits[first].end]];
    if (last !== first) spans.push([hits[last].start, hits[last].end]);
    return spans;
  }

  /** 按块正则取「首 / 尾」块下标（供 scope=firstlast 使用）。
   *  相同块正则的标签必须合成一组统一判定：word 的 w:t / w:delText / w:instrText 共用 <w:p>，
   *  末尾文字只出现在删除记录或域代码时，中间段落不能被误判成尾段提前清掉。
   *  allowed: 可选的绝对区间白名单（由 spec.blocks 的 rangeFrom 描述），只有落在区间内的块才
   *           参与首尾判定；区间外的块直接跳过，顺带省掉大半扫描开销。
   *  nested: 嵌套块（文本框内段落）为 true 时，凡落在外层首 / 尾段区间内的块都算首 / 尾，
   *           结果放在 firstSet / lastSet 里（多段文本框的中段不会被漏掉）。
   *  @returns {{firstIdx:number,lastIdx:number,firstSet:?number[],lastSet:?number[]}}
   *           下标均为 -1 / 空数组表示没有有效块
   */
  function contentRange(xml, re, tags, allowed, nested) {
    var range = { firstIdx: -1, lastIdx: -1, firstSet: null, lastSet: null };
    if (xml.indexOf('<') === -1) return range;
    var scan = new RegExp(re.source, 'g');
    var m;
    var idx = 0;
    var firstSet = (nested && allowed) ? [] : null;
    var lastSet = (nested && allowed && allowed.length > 1) ? [] : null;
    while ((m = scan.exec(xml)) !== null) {
      var raw = m[0];
      var cur = idx++;
      if (allowed && !inSpans(m.index, m.index + raw.length, allowed)) continue;
      if (!blockHasText(raw, tags)) continue;
      if (range.firstIdx < 0) range.firstIdx = cur;
      range.lastIdx = cur;
      // 嵌套块（文本框内的段落）把整个外层段算作「一行」：只要落在外层首段 / 尾段区间内就
      // 全部参与处理。若只按本组的第一 / 最后一个块判定，多段文本框在默认范围下仍会漏掉中段
      if (firstSet && inSpans(m.index, m.index + raw.length, [allowed[0]])) firstSet.push(cur);
      if (lastSet && inSpans(m.index, m.index + raw.length, [allowed[allowed.length - 1]])) lastSet.push(cur);
    }
    range.firstSet = firstSet;
    range.lastSet = lastSet;
    return range;
  }

  /* Word 里 <w:p> 会嵌在 <w:p> 内：文本框（<w:txbxContent>）、VML 形状（<w:pict><v:textbox>）、
     SmartArt / 图示的富文本都属此类。若不区分，<w:p> 的懒惰匹配到内层 </w:p> 就结束：
       ① 外层段里「内层文本框之后」的 run 落在所有块之外，即使范围选「全文」也整段漏清；
       ② 外层段的文本节点把文本框里的文字一并吸进来，重建时整段文本被搬进第一个 run，
          文本框自己反而被清空（内容错位、版式变形）。
     文本框里还能再放文本框，故按「段落嵌套层数」改名：第 k 层段落的 <w:p> / <w:t> 改成
     w:dwr-nest{k}p / w:dwr-nest{k}t。同层段落互不嵌套，各层的懒惰正则因此都能匹配到本层真正
     的闭合标签。外层标签与属性一个字符都不动，改名前后严格可逆，且与具体嵌套载体无关。
     实现上直接扫 <w:p> / <w:t> 的配对标签、按栈深判定层号，只做「点替换」——
     不依赖任何容器标签，因而对不规范 / 旧式写法同样成立。
     自闭合空段（<w:p/>、<w:p w14:paraId="…"/>，Word 空段落的常见序列化写法）必须跳过：
     它没有闭合标签，若当开标签压栈，「</w:p>」配对从此错位——后续段落层号漂移、闭合标签被
     误改名，掩码后的 XML 里不再有配对的 </w:p>，所有块正则（含 w:p 组自身）全部失配，
     整个部件静默漏检（正文层 1 个自闭合空段会让其后所有段落扫不到）。 */
  var NEST_TOKEN_RE = /<w:p(?=[\s/>])|<\/w:p>|<w:t(?=[\s/>])|<\/w:t>/g;
  function maskNestedWord(xml) {
    if (xml.indexOf('<w:p') < 0) return { xml: xml, levels: 0 };
    var stack = [];
    var edits = [];
    var m;
    NEST_TOKEN_RE.lastIndex = 0;
    while ((m = NEST_TOKEN_RE.exec(xml)) !== null) {
      var tok = m[0];
      if (tok === '<w:p') {
        var gt = xml.indexOf('>', m.index + 4);
        if (gt > 0 && xml.charAt(gt - 1) === '/') continue; // 自闭合空段：不入栈、不改名
        var lvl = stack.length;              // 栈深 = 外层段落层号，首层段落为 0
        if (lvl >= 1) edits.push({ at: m.index, end: m.index + 4, level: lvl, kind: 'p', open: true });
        stack.push(lvl);
      } else if (tok === '</w:p>') {
        if (!stack.length) continue;
        var lv = stack.pop();
        if (lv >= 1) edits.push({ at: m.index, end: m.index + 6, level: lv, kind: 'p', open: false });
      } else {
        // 文本节点归属最内层打开的段落
        var cur = stack.length ? stack[stack.length - 1] : 0;
        if (cur < 1) continue;
        edits.push({ at: m.index, end: m.index + tok.length, level: cur, kind: 't', open: tok.charAt(1) !== '/' });
      }
    }
    if (!edits.length) return { xml: xml, levels: 0 };
    var out = '', cursor = 0, levels = 0;
    edits.forEach(function (e) {
      if (e.level > levels) levels = e.level;
      out += xml.slice(cursor, e.at) + (e.open
        ? '<w:dwr-nest' + e.level + '-' + e.kind
        : '</w:dwr-nest' + e.level + '-' + e.kind + '>');
      cursor = e.end;
    });
    return { xml: out + xml.slice(cursor), levels: levels };
  }
  function unmaskNestedWord(xml) {
    // 只替换标签名本身，属性与自闭合写法原样保留：
    //   <w:dwr-nest1-p w14:paraId=\"…\"> → <w:p w14:paraId=\"…\">、<w:dwr-nest1-t/> → <w:t/>
    // 早先的写法要求标签以 > 结尾，而真实 Word 文档的段落几乎都带属性（w14:paraId / rsid 等），
    // 于是嵌套标签会原样漏进输出，Word 直接判定文档损坏——只有合成用例（无属性）能通过。
    return xml.replace(/<(\/?)w:dwr-nest\d+-([pt])(?=[\s/>])/g, function (all, slash, kind) {
      return '<' + slash + 'w:' + kind;
    });
  }
  /** 第 1..level 层嵌套段落的块规格：算不算首尾由外层 <w:p> 决定（nested） */
  function nestedBlocks(levels, rangeFrom) {
    var out = [];
    for (var k = 1; k <= levels; k++) {
      out.push({
        re: new RegExp('<w:dwr-nest' + k + '-p(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:dwr-nest' + k + '-p>', 'g'),
        tag: 'w:dwr-nest' + k + '-t',
        rangeFrom: rangeFrom,
        nested: true
      });
    }
    return out;
  }
  function processXml(xml, engine, spec, counter) {
    // 文本框内的段落嵌在外层 <w:p> 里，先按层改名再按块处理（见 maskNestedWord）
    var levels = 0, work = xml;
    if (spec.maskNested) {
      var masked = maskNestedWord(xml);
      if (masked.levels) { work = masked.xml; levels = masked.levels; }
    }
    var out = work;
    if (spec.blocks) {
      // 文本框内段落按实际层数动态成组：层数不固定，没法写死在 spec 里（见 nestedBlocks）
      var nestBlocks = levels ? nestedBlocks(levels, spec.nestRangeFrom) : [];
      var allBlocks = spec.blocks.concat(nestBlocks);
      // 按块正则分组：相同正则来源的块必须合成一组，组内所有标签统一算首尾——
      // word 的 w:t / w:delText / w:instrText 共用 <w:p> 块正则，若各标签单独算，
      // 末尾文字只出现在删除记录或域代码时，中间段会被当成尾段提前清掉
      var groups = [];
      var spanCache = [];
      allBlocks.forEach(function (b) {
        var g = null;
        for (var i = 0; i < groups.length; i++) if (groups[i].src === b.re.source) { g = groups[i]; break; }
        if (g) { if (b.hasTags && !g.hasTags) g.hasTags = b.hasTags; return; }
        groups.push({ src: b.re.source, re: b.re, tags: [b.tag], hasTags: b.hasTags || null, rangeFrom: b.rangeFrom, nested: !!b.nested });
      });
      // 首尾一律基于「原始 xml」算完再统一改写：若边改写边算，前一组把整段敏感词删掉后
      // 「首个含文本的块」判定会漂移（被清空的首段不再是有效块，嵌套它的文本框会跟着漏清），
      // 绝对区间也会因字符串长度变化而失位。各组索引空间互不影响，因此可以先全部算完。
      // 同一份 rangeFrom 可能被多个块组共享（word 的 <w:p> 与 <a:p> 组就用同一份）
      // 缓存起见，避免把同一段 XML 重复扇遍
      var spansFor = function (entries) {
        for (var si = 0; si < spanCache.length; si++) {
          if (spanCache[si][0] === entries) return spanCache[si][1];
        }
        var spans = firstLastSpans(work, entries);
        spanCache.push([entries, spans]);
        return spans;
      };
      groups.forEach(function (g) {
        g.range = contentRange(work, g.re, g.hasTags || g.tags, g.rangeFrom ? spansFor(g.rangeFrom) : null, g.nested);
      });
      groups.forEach(function (g) {
        allBlocks.forEach(function (b) {
          if (b.re.source !== g.src) return;
          // 块级 full 优先：同一部件里既有正文（跟随范围）又有配置类文本（整块处理）
          out = replaceBlocks(out, b.re, b.tag, engine, counter, !!(spec.full || b.full), g.range);
        });
      });
    }
    // 元数据类部件（文档属性 / 工作表名 / 表名等）整部件处理；
    // 属性值（形状名、替换文字、书签名、域指令等）同样属于元数据，一律不跟随用户选择的首尾范围
    if (spec.textnodes) out = replaceTextNodes(out, engine, counter, spec.full);
    if (spec.attrs) out = replaceAttrs(out, engine, counter, spec.full || spec.attrsFull);
    if (levels) out = unmaskNestedWord(out);
    return out;
  }

  /* ---------------- 结构层加固：条目名 / 引用 / 缩略图 ---------------- */

  var CT_NAME = '[Content_Types].xml';
  /* v4.45 文档缩略图的准确位置：OOXML 规范里它固定是 docProps/thumbnail.*，
     关系声明在 _rels/.rels。旧正则 (?:^|/)thumbnail\. 过于宽松——
     word/media/thumbnail.png 这类**正文插图**（被 document.xml 的 r:embed 引用）
     也会被当成缩略图删掉，删完 .rels 里的 Target 仍指向已删除的部件，
     Word / WPS 打开时报「文档损坏需修复」。实测确认过这一处。 */
  var THUMB_RE = /^docProps\/thumbnail\.(?:emf|wmf|jpg|jpeg|png)$/i;

  /** .rels 文件所维护的部件目录：word/_rels/document.xml.rels -> word/ */
  function relsBaseDir(relsName) {
    return String(relsName).replace(/_rels\/[^/]*$/, '');
  }

  /**
   * 把 .rels 的 Target 解析成包内部件路径；外部 URL / 空值返回 null（不在包内，不能改名）
   */
  function resolveTarget(baseDir, target) {
    var t = String(target || '');
    if (!t || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return null; // http(s): / mailto: 等外部目标
    if (t.charAt(0) === '/') return t.slice(1);                 // 包内绝对路径
    // 去掉空段：baseDir 带尾斜杠（"word/"）时 split 会产生空字符串，不过滤会解析出 "word//x" 造成失配
    var stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
    t.split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') { if (stack.length) stack.pop(); return; }
      stack.push(seg);
    });
    return stack.join('/');
  }

  /** 条目名按全文口径替换敏感词（不受用户选择的首尾行范围限制）；无命中返回 null */
  function sanitizeEntryName(name, engine) {
    var r;
    try { r = engine.scan(name, true, true); } catch (e) { return null; }
    if (!r || !r.hits) return null;
    var out;
    try { out = engine.apply(name, true, true).text; } catch (e) { return null; }
    // 只拒绝“替换把名字变成绝对路径 / 含反斜杠 / 空字符 / 目录穿越”；路径分隔符本就存在于合法条目名中
    if (!out || out === name) return null;
    if (/^\/|\\|\0|\/\.\.(\/|$)/.test(out)) return null;
    return out;
  }

  /** 规整新条目名：保留扩展名（内容类型按扩展名匹配），避免空名 / 隐藏文件名 */
  function tidyEntryName(newName, oldName) {
    var slash = newName.lastIndexOf('/');
    var dir = slash >= 0 ? newName.slice(0, slash + 1) : '';
    var base = slash >= 0 ? newName.slice(slash + 1) : newName;
    var oSlash = oldName.lastIndexOf('/');
    var oBase = oSlash >= 0 ? oldName.slice(oSlash + 1) : oldName;
    var oDot = oBase.lastIndexOf('.');
    var oldExt = oDot > 0 ? oBase.slice(oDot) : '';
    // 按“词干 + 扩展名”拆分：替换把名字吃掉后剩下的可能只有扩展名（如 “.xlsx”）、仅剩词干、或完整名字
    var dot = base.lastIndexOf('.');
    var stem = dot > 0 ? base.slice(0, dot) : (dot === 0 ? '' : base);
    var ext = dot >= 0 ? base.slice(dot) : '';
    if (!ext && oldExt) ext = oldExt; // 内容类型按扩展名匹配，丢不会打开
    if (!stem) stem = 'part';
    if (stem === '.' || stem === '..') stem = 'part';
    return dir + stem + ext;
  }

  /** [Content_Types].xml 的 Override/@PartName 跟随部件改名 */
  function fixContentTypes(xml, renames) {
    return xml.replace(/PartName="([^"]*)"/g, function (m, pn) {
      var target = pn.charAt(0) === '/' ? pn.slice(1) : pn;
      for (var i = 0; i < renames.length; i++) {
        if (target === renames[i].from) return 'PartName="/' + renames[i].to + '"';
      }
      return m;
    });
  }

  /** 全部 .rels 的 Relationship/@Target 跟随部件改名（保持原有的相对 / 绝对写法） */
  function fixRelsTargets(xml, baseDir, renames) {
    return xml.replace(/<Relationship\b[^>]*>/g, function (tag) {
      if (!/Target="/.test(tag)) return tag;
      return tag.replace(/Target="([^"]*)"/, function (m, t) {
        var resolved = resolveTarget(baseDir, t);
        if (!resolved) return m;
        for (var i = 0; i < renames.length; i++) {
          if (resolved !== renames[i].from) continue;
          if (t.charAt(0) === '/') return 'Target="/' + renames[i].to + '"';
          var slash = t.lastIndexOf('/');
          var prefix = slash >= 0 ? t.slice(0, slash + 1) : '';
          return 'Target="' + prefix + renames[i].to.slice(renames[i].to.lastIndexOf('/') + 1) + '"';
        }
        return m;
      });
    });
  }

  /** 移除一个部件在 [Content_Types].xml 与 _rels/.rels 中的声明（留下空行无，XML 仍然合法性） */
  function stripPartRefs(zip, partName) {
    var chain = Promise.resolve();
    if (zip.has(CT_NAME)) {
      chain = chain.then(function () {
        return zip.getText(CT_NAME).then(function (xml) {
          var out = xml.replace(/<Override\b[^>]*>/g, function (tag) {
            var m = /PartName="([^"]*)"/.exec(tag);
            if (!m) return tag;
            var pn = m[1].charAt(0) === '/' ? m[1].slice(1) : m[1];
            return pn === partName ? '' : tag;
          });
          if (out !== xml) zip.setText(CT_NAME, out);
        });
      });
    }
    if (zip.has('_rels/.rels')) {
      chain = chain.then(function () {
        return zip.getText('_rels/.rels').then(function (xml) {
          var out = xml.replace(/<Relationship\b[^>]*>/g, function (tag) {
            var m = /Target="([^"]*)"/.exec(tag);
            if (!m) return tag;
            return resolveTarget('', m[1]) === partName ? '' : tag;
          });
          if (out !== xml) zip.setText('_rels/.rels', out);
        });
      });
    }
    return chain;
  }

  /**
   * 结构层加固（外部保密检查软件按「解包 + 检索全部字节」工作，条目名明文存放于 ZIP 头里）:
   *   1) 条目名含敏感词 → 重命名，并同步修正 [Content_Types].xml 与全部 .rels 的引用
   *   2) 缩略图（首页渲染图，可能带出敏感内容）→ 整部件移除，并清理声明与关系
   * @returns {Promise<{changed:boolean, renamed:Array<{from:string,to:string}>, removed:string[], thumb:boolean}>}
   */
  function hardenZip(zip, engine) {
    var renames = [], taken = {};
    zip.entries.forEach(function (e) { taken[e.name] = true; });
    zip.entries.forEach(function (e) {
      var nn = sanitizeEntryName(e.name, engine);
      if (!nn) return;
      nn = tidyEntryName(nn, e.name);
      if (nn === e.name) return;
      if (taken[nn]) { // 改名后撞名：扩展名前补序号
        var slash = nn.lastIndexOf('/');
        var dir = slash >= 0 ? nn.slice(0, slash + 1) : '';
        var base = slash >= 0 ? nn.slice(slash + 1) : nn;
        var dot = base.lastIndexOf('.');
        var stem = dot > 0 ? base.slice(0, dot) : base;
        var ext = dot > 0 ? base.slice(dot) : '';
        var k = 1;
        while (taken[dir + stem + '_' + k + ext]) k++;
        nn = dir + stem + '_' + k + ext;
      }
      taken[nn] = true;
      renames.push({ from: e.name, to: nn });
    });

    if (!renames.length) {
      return Promise.resolve().then(function () {
        return hardenThumbs(zip, []).then(function (r) { return { changed: r.changed, renamed: [], removed: r.removed, thumb: r.thumb }; });
      });
    }

    var chain = Promise.resolve();
    if (zip.has(CT_NAME)) {
      chain = chain.then(function () {
        return zip.getText(CT_NAME).then(function (xml) {
          var out = fixContentTypes(xml, renames);
          if (out !== xml) zip.setText(CT_NAME, out);
        });
      });
    }
    zip.entries.slice().forEach(function (e) {
      if (!/\.rels$/i.test(e.name)) return;
      chain = chain.then(function () {
        return zip.getText(e.name).then(function (xml) {
          var out = fixRelsTargets(xml, relsBaseDir(e.name), renames);
          if (out !== xml) zip.setText(e.name, out);
        });
      });
    });

    return chain.then(function () {
      renames.forEach(function (r) { zip.rename(r.from, r.to); });
      return hardenThumbs(zip, renames).then(function (r) {
        // changed 必须同时考虑重命名与缩略图移除：只有缩略图时不能覆盖“只改了名”的情况
        return { changed: !!(renames.length || r.removed.length), renamed: renames, removed: r.removed, thumb: r.thumb };
      });
    });
  }

  /** 移除缩略图条目（及其声明与关系）；无缩略图时仅作为空操作 */
  function hardenThumbs(zip, renames) {
    var thumbs = zip.entries.filter(function (e) { return THUMB_RE.test(e.name); });
    if (!thumbs.length) return Promise.resolve({ changed: false, renamed: renames, removed: [], thumb: false });
    var chain = Promise.resolve();
    var removed = [];
    thumbs.forEach(function (e) {
      chain = chain.then(function () {
        return stripPartRefs(zip, e.name).then(function () {
          zip.remove(e.name);
          removed.push(e.name);
        });
      });
    });
    return chain.then(function () {
      return { changed: true, renamed: renames, removed: removed, thumb: true };
    });
  }

  /**
   * 处理 Office 文件
   * @returns {Promise<{blob: Blob, hits: number, matched: string[], touched: boolean}>}
   */
  function processOffice(arrayBuffer, engine, onProgress, budget, depth) {
    budget = budget || officeBudget(arrayBuffer.byteLength);
    depth = depth || 0;
    return Zip.load(arrayBuffer).then(function (zip) {
      var counter = { hits: 0, hitChars: 0, totalChars: 0, matched: [], firstHit: false, lastHit: false, hasVba: false, hasThumb: false };
      var tasks = [];
      var total = 0, done = 0;
      function tick() { done++; if (onProgress) { try { onProgress(done, total); } catch (e) {} } }

      zip.entries.forEach(function (entry) {
        // 条目名命中与 scanOffice 同口径计数：重命名本身就是「清理」，
        // 不计数会出现「扫描报 N 处、处理报 0 处」的对不上（重命名清单见 renamed）
        var nr = engine.scan(entry.name, true, true);
        if (nr && nr.hits) {
          counter.hits += nr.hits;
          (nr.matched || []).forEach(function (m) {
            if (counter.matched.indexOf(m) === -1) counter.matched.push(m);
          });
        }
        var spec = specFor(entry.name);
        if (spec) {
          total++;
          tasks.push(zip.getText(entry.name).then(function (xml) {
            if (xml == null) { tick(); return; }
            var out = processXml(xml, engine, spec, counter);
            if (out !== xml) zip.setText(entry.name, out);
            tick();
          }));
          return;
        }
        // 递归脱敏内嵌的 Office 文档（word/embeddings、ppt/embeddings、xl/embeddings 等）
        // 内嵌文档的命中也计入计数，与 scanOffice 的递归扫描保持一致
        if (/embeddings\//.test(entry.name) && isOfficeFile(entry.name)) {
          total++;
          tasks.push(zip.getBytes(entry.name).then(function (bytes) {
            if (!bytes) { tick(); return; }
            assertNestedBudget(budget, bytes.byteLength, depth);
            var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return processOffice(ab, engine, null, budget, depth + 1).then(function (res) {
              // 内嵌文档的命中同样计入总数：否则「已处理数」与扫描结果对不上
              if (res.hits > 0) {
                counter.hits += res.hits;
                res.matched.forEach(function (m) {
                  if (counter.matched.indexOf(m) === -1) counter.matched.push(m);
                });
                if (res.firstHit) counter.firstHit = true;
                if (res.lastHit) counter.lastHit = true;
              }
              if (res.vba) counter.hasVba = true;
              if (res.thumb) counter.hasThumb = true;
              if (res.touched && res.blob) {
                return res.blob.arrayBuffer().then(function (inner) {
                  zip.setBytes(entry.name, new Uint8Array(inner));
                });
              }
            });
          }).then(function () { tick(); }));
        }
        // 含宏（VBA）或缩略图（可能含截图）的文档需人工复核
        if (/vbaProject\.bin$/i.test(entry.name)) counter.hasVba = true;
        if (THUMB_RE.test(entry.name)) counter.hasThumb = true;
      });

      return Promise.all(tasks).then(function () {
        // 结构层加固与正文命中无关：保密检查软件检索的是解包后的全部字节，
        // 条目名与缩略图不在 specFor 的部件策略范围内，必须独立收尾
        return hardenZip(zip, engine).catch(function () {
          return { changed: false, renamed: [], removed: [], thumb: false };
        }).then(function (harden) {
          if (counter.hits === 0 && !harden.changed) {
            return { blob: null, hits: 0, hitChars: 0, totalChars: counter.totalChars, ratio: 0, matched: [], touched: false, firstHit: false, lastHit: false, vba: !!counter.hasVba, thumb: false, renamed: [], removed: [] };
          }
          return zip.toBlob().then(function (blob) {
            return {
              blob: blob,
              hits: counter.hits,
              hitChars: counter.hitChars,
              totalChars: counter.totalChars,
              ratio: counter.totalChars > 0 ? counter.hitChars / counter.totalChars : 0,
              matched: counter.matched,
              touched: true,
              firstHit: !!counter.firstHit,
              lastHit: !!counter.lastHit,
              vba: !!counter.hasVba,
              thumb: !!counter.hasThumb && !harden.thumb,
              renamed: harden.renamed,
              removed: harden.removed
            };
          });
        });
      });
    });
  }

  /** 扫描专用引擎包装：复用真实匹配逻辑，命中统计由 mergeMatch 完成。
   *  扫描为只读，改写结果被丢弃；不传替换回调才能正确累计命中（否则文本不变会触发提前 return 跳过统计）。 */
  function noopEngine(engine) {
    return {
      apply: function (text, isFirst, isLast) {
        return engine.apply(text, isFirst, isLast);
      }
    };
  }

  /**
   * 扫描 Office 文件（只读，不重新打包，速度快）
   * @returns {Promise<{hits: number, matched: string[]}>}
   */
  function scanOffice(arrayBuffer, engine, budget, depth) {
    budget = budget || officeBudget(arrayBuffer.byteLength);
    depth = depth || 0;
    return Zip.load(arrayBuffer).then(function (zip) {
      var counter = { hits: 0, hitChars: 0, totalChars: 0, matched: [], firstHit: false, lastHit: false, hasVba: false, hasThumb: false };
      var ne = noopEngine(engine);
      var tasks = [];

      zip.entries.forEach(function (entry) {
        // 条目名也算命中（不受用户范围限制）：仅条目名含敏感词的文件也必须被报出并清理，
        // 否则保密检查软件解包后仍能从 ZIP 本地文件头 / 中央目录里检索到
        var nr = engine.scan(entry.name, true, true);
        if (nr && nr.hits) {
          counter.hits += nr.hits;
          (nr.matched || []).forEach(function (m) {
            if (counter.matched.indexOf(m) < 0) counter.matched.push(m);
          });
        }
        if (/vbaProject\.bin$/i.test(entry.name)) counter.hasVba = true;
        if (THUMB_RE.test(entry.name)) counter.hasThumb = true;
        var spec = specFor(entry.name);
        if (spec) {
          tasks.push(zip.getText(entry.name).then(function (xml) {
            if (xml == null) return;
            processXml(xml, ne, spec, counter);
          }));
          return;
        }
        // 递归扫描内嵌的 Office 文档（与 processOffice 的处理范围对齐）
        // 否则会出现「扫描报 0 命中、清理时却又改动文件」的不一致
        if (/embeddings\//.test(entry.name) && isOfficeFile(entry.name)) {
          tasks.push(zip.getBytes(entry.name).then(function (bytes) {
            if (!bytes) return;
            assertNestedBudget(budget, bytes.byteLength, depth);
            var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            return scanOffice(ab, engine, budget, depth + 1).then(function (r) {
              counter.hits += r.hits;
              r.matched.forEach(function (m) {
                if (counter.matched.indexOf(m) === -1) counter.matched.push(m);
              });
              if (r.hits > 0) {
                if (r.firstHit) counter.firstHit = true;
                if (r.lastHit) counter.lastHit = true;
              }
              if (r.vba) counter.hasVba = true;
              if (r.thumb) counter.hasThumb = true;
            });
          }));
        }
      });

      return Promise.all(tasks).then(function () {
        return { hits: counter.hits, hitChars: counter.hitChars, totalChars: counter.totalChars, ratio: counter.totalChars > 0 ? counter.hitChars / counter.totalChars : 0, matched: counter.matched, firstHit: !!counter.firstHit, lastHit: !!counter.lastHit, vba: !!counter.hasVba, thumb: !!counter.hasThumb };
      });
    });
  }

  /* ---------------- 提取纯文本（预览用） ---------------- */

  /** 在 work（已按 maskNestedWord 改名）上按 processXml 的口径算首 / 尾：
   *  相同块正则合并为一组，组内首 / 尾取「第一个 / 最后一个含非空白文本的块」；
   *  full（整部件处理）时全部算首尾；嵌套块按外层段落区间（rangeFrom）判定。
   *  返回一个匹配器：给定块对象与它在 work 里的起点，返回该块是否算首 / 尾。 */
  function buildMarkMatcher(work, blocks, spec) {
    function firstLastOf(re, tags, allowed, nested) {
      var firstSet = (nested && allowed) ? {} : null;
      var lastSet = (nested && allowed && allowed.length > 1) ? {} : null;
      var first = null, last = null;
      var scan = new RegExp(re.source, 'g'), m;
      while ((m = scan.exec(work)) !== null) {
        if (allowed && !inSpans(m.index, m.index + m[0].length, allowed)) continue;
        if (!blockHasText(m[0], tags)) continue;
        if (first === null) first = m.index;
        last = m.index;
        // 嵌套块（文本框内段落）把整个外层段算作「一行」：落在外层首段 / 尾段区间内就都算首 / 尾
        if (firstSet && inSpans(m.index, m.index + m[0].length, [allowed[0]])) firstSet[m.index] = true;
        if (lastSet && inSpans(m.index, m.index + m[0].length, [allowed[allowed.length - 1]])) lastSet[m.index] = true;
      }
      return { first: first, last: last, firstSet: firstSet, lastSet: lastSet };
    }
    var cache = [];
    function cachedRange(b) {
      for (var ci = 0; ci < cache.length; ci++) if (cache[ci].b === b) return cache[ci].r;
      var r = firstLastOf(b.re, b.hasTags || b.tags, b.rangeFrom ? firstLastSpans(work, b.rangeFrom) : null, !!b.nested);
      cache.push({ b: b, r: r });
      return r;
    }
    return {
      full: !!spec.full,
      mark: function (b, start) {
        var r = cachedRange(b);
        var isFirst = r.first !== null && start === r.first;
        var isLast = r.last !== null && start === r.last;
        if (r.firstSet && r.firstSet[start]) isFirst = true;
        if (r.lastSet && r.lastSet[start]) isLast = true;
        return { first: !!this.full || isFirst, last: !!this.full || isLast };
      }
    };
  }

  /** 按 spec 抽取某部件内的全部文本节点（与脱敏覆盖的部件一致）。
   *  mode==='preview' 时对每行附 { first, last } 元数据，按 processXml 的口径标出该块
   *  是否算首 / 尾，供预览「处理后」与原文高亮按同一行判定。 */
  function extractFromSpec(xml, spec, extraBlocks, mode, work) {
    var lines = [];
    var marks = mode === 'preview' ? [] : null;
    var mm = marks ? buildMarkMatcher(work == null ? xml : work, spec.blocks || [], spec) : null;
    var allBlocks = (spec.blocks || []).concat(extraBlocks || []);
    if (allBlocks.length) {
      // 与 processXml 同一分组口径：共用块正则的多个文本标签合成一组，段落内按出现顺序拼接。
      // 逐 <w:t> 输出成行会让「机」+「密」这种被 run 拆写的词在预览里断成两行、判不中，
      // 于是扫描报命中、预览却不高亮、处理后与原文一字不差，用户核对不出处理效果。
      // 真实 Word 文档切换加粗 / 字体就会拆 run，是最常见的命中形态，必须按段合并。
      var groups = [];
      allBlocks.forEach(function (b) {
        var g = null;
        for (var i = 0; i < groups.length; i++) if (groups[i].src === b.re.source) { g = groups[i]; break; }
        // 与 processXml 同一分组口径：共用块正则的标签合成一组，组元数据（rangeFrom /
        // hasTags / nested）取该组首个块，供 buildMarkMatcher 复算首 / 尾
        if (g) { if (g.tags.indexOf(b.tag) < 0) g.tags.push(b.tag); return; }
        groups.push({ src: b.re.source, re: b.re, tags: [b.tag],
          hasTags: b.hasTags || null, rangeFrom: b.rangeFrom, nested: !!b.nested });
      });
      groups.forEach(function (g) {
        var re = new RegExp(g.re.source, 'g');
        // 组内标签按文档顺序匹配，而不是一个标签扫全篇再扫下一个：
        // 同段里正文 / 删除记录 / 域代码交错时，拼接结果要与肉眼读到的顺序一致
        var nodeRe = new RegExp('<(?:' + g.tags.join('|') + ')(?:[ \t\r\n][^>]*)?>([^]*?)</(?:' + g.tags.join('|') + ')>', 'g');
        var m;
        while ((m = re.exec(xml)) !== null) {
          var raw = m[0];
          nodeRe.lastIndex = 0;
          var buf = '';
          var nt;
          while ((nt = nodeRe.exec(raw)) !== null) buf += decodeXml(nt[1]);
          if (buf.replace(/\s/g, '') !== '') {
            lines.push(buf);
            if (mm) marks.push(mm.mark(g, m.index));
          }
        }
      });
    }
    if (spec.textnodes) {
      var tn = />([^<>]+)</g, x;
      while ((x = tn.exec(xml)) !== null) {
        var d = decodeXml(x[1]);
        if (d.replace(/\s/g, '') !== '') {
          lines.push(d);
          if (mm) marks.push({ first: !!spec.full, last: !!spec.full });
        }
      }
    }
    if (!marks) return lines;
    return { lines: lines, marks: marks };
  }

  /**
   * 预览定位行用的可读部件名。
   * 预览栏是给普通用户看的，直接摊出 `[word/document.xml]` 这类包内路径既难懂、
   * 又像是程序出错；这里换成中文部位名，并保留方括号包裹，
   * previewProcess / highlightOffice 仍按同一口径跳过这些定位行。
   */
  function partLabel(name) {
    var n = String(name).toLowerCase();
    if (/^word\//.test(n)) {
      if (/^word\/document\.xml$/.test(n)) return '正文';
      if (/^word\/header/.test(n)) return '页眉';
      if (/^word\/footer/.test(n)) return '页脚';
      if (/comments/.test(n)) return '批注';
      if (/footnotes/.test(n)) return '脚注';
      if (/endnotes/.test(n)) return '尾注';
      return '正文';
    }
    if (/^docprops\//.test(n)) return '文档属性';
    if (/^customxml\//.test(n)) return '文档数据';
    if (/^xl\//.test(n)) {
      if (/^xl\/sharedstrings\.xml$/.test(n)) return '共享文本';
      if (/^xl\/workbook\.xml$/.test(n)) return '工作簿';
      if (/^xl\/worksheets\//.test(n)) return '工作表';
      if (/^xl\/charts\//.test(n)) return '图表';
      if (/comments/.test(n)) return '批注';
      return '表格';
    }
    if (/^ppt\//.test(n)) {
      if (/^ppt\/slides\//.test(n)) return '幻灯片';
      if (/notes/.test(n)) return '备注';
      if (/^ppt\/comments\//.test(n)) return '批注';
      if (/^ppt\/charts\//.test(n)) return '图表';
      return '幻灯片';
    }
    return name;
  }

  /** 抽取 Office 文档正文纯文本与逐行首 / 尾标记（覆盖全部文本部件）。
   *  返回 { text, marks }：marks[i] 对应 text 的第 i 行，{ first, last } 或 null（定位行 / 空行）。
   *  首 / 尾按「逐部件、逐块组」判定，与 processXml 真实处理一致；预览据此清词与高亮。 */
  function extractPreview(arrayBuffer) {
    return Zip.load(arrayBuffer).then(function (zip) {
      var out = [];
      var marks = [];
      var chain = Promise.resolve();
      zip.entries.forEach(function (entry) {
        var spec = specFor(entry.name);
        if (!spec) return;
        chain = chain.then(function () {
          return zip.getText(entry.name).then(function (xml) {
            if (xml == null) return;
            // 与 processXml 同一口径：文本框内的段落按层改名后再抽取，否则外层 <w:p> 的
            // 懒惰匹配会在内层 </w:p> 处截断，文本框之后的正文在预览里缺失
            var mk = spec.maskNested ? maskNestedWord(xml || '') : null;
            var wx = mk ? mk.xml : (xml || '');
            var nb = (mk && mk.levels) ? nestedBlocks(mk.levels, spec.nestRangeFrom) : null;
            var ex = extractFromSpec(wx, spec, nb, 'preview', wx);
            // 定位行只在确实抽到文字时才输出：工作簿这类部件的文本全在属性里，
            // 抽不出正文时会留下一个只有标签、没有内容的空行，用户会以为渲染出错。
            if (!ex.lines.length) return;
            out.push('[' + partLabel(entry.name) + ']');
            marks.push(null); // 定位行
            // 文本节点内部可能含换行（&#10; 等）：previewProcess 按换行切行，这里必须
            // 按同一口径拆开并复制标记，否则 marks 与显示行错位，首尾判定整体偏移
            ex.lines.forEach(function (s, i) {
              var parts = String(s).split(/\r\n|\r|\n/);
              parts.forEach(function (p) { out.push(p); marks.push(ex.marks[i]); });
            });
          });
        });
      });
      return chain.then(function () { return { text: out.join('\n'), marks: marks }; });
    });
  }

  /** 抽取 Office 文档正文纯文本（兼容旧调用，只取文本部分） */
  function extractText(arrayBuffer) {
    return extractPreview(arrayBuffer).then(function (r) { return r.text; });
  }

  /* ---------------- 清除后自检（防外部保密检查软件检出残留） ---------------- */

  var NAMED_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  /** 解码 XML 实体（含 &#x673A; / &#25104; 数字实体）：转义写法同样能被保密检查软件读出 */
  function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g, function (m, hex, dec, name) {
      try {
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        if (dec) return String.fromCodePoint(parseInt(dec, 10));
        return NAMED_ENT[name] || m;
      } catch (e) { return m; }
    });
  }

  /**
   * 把一个 XML 部件拆成可检索视图（与 specFor 的部件策略无关，按「解包后全文检索」口径）：
   *   text —— 去掉全部标签后拼接的文本，等价于「复制全文」，跨 run 拆写的词会在这里现形
   *   attr —— 所有属性值（.rels 的 Target、形状 name / descr、图表数据标签等）
   *   hide —— XML 注释与 CDATA 里的内容（普通文本节点检索会漏掉）
   */
  function xmlViews(raw) {
    var hide = [];
    var m, cmt = /<!--([\s\S]*?)-->/g;
    while ((m = cmt.exec(raw)) !== null) hide.push(m[1]);
    var cd = /<!\[CDATA\[([\s\S]*?)]]>/g;
    while ((m = cd.exec(raw)) !== null) hide.push(m[1]);

    var attrs = [];
    var tag = /<[^>]*>/g;
    while ((m = tag.exec(raw)) !== null) {
      var a = /[A-Za-z_:][-\w:.]*\s*=\s*"([^"]*)"/g, one;
      while ((one = a.exec(m[0])) !== null) attrs.push(one[1]);
    }

    var views = [{ kind: 'text', text: decodeEntities(raw.replace(/<[^>]*>/g, '')) }];
    if (attrs.length) views.push({ kind: 'attr', text: decodeEntities(attrs.join('\n')) });
    if (hide.length) views.push({ kind: 'hide', text: decodeEntities(hide.join('\n')) });
    return views;
  }

  /** 旧版 OLE 容器（doc / xls）里的文本按 UTF-16LE 存放，按 UTF-16 解码后即可检索 */
  function utf16leText(bytes) {
    var out = '';
    var end = bytes.length - (bytes.length % 2);
    for (var i = 0; i < end; i += 2) {
      var c = bytes[i] | (bytes[i + 1] << 8);
      out += (c >= 32 && c !== 0xffff) ? String.fromCharCode(c) : ' ';
    }
    return out;
  }

  var VIEW_KIND_LABEL = { text: '', attr: '·属性', hide: '·注释', utf16: '·OLE', bin: '·二进制', name: '·条目名' };

  function viewsFor(name, bytes) {
    var n = String(name).toLowerCase();
    if (/\.(?:xml|rels)$/.test(n)) return xmlViews(new TextDecoder('utf-8').decode(bytes));
    if (isTextFile(n)) return [{ kind: 'text', text: decodeText(bytes).text }];
    // OLE2 复合文档签名 D0CF11E0：旧版 Office / 嵌入对象的文本按 UTF-16 存放
    if (bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return [{ kind: 'utf16', text: utf16leText(bytes) }];
    }
    return [{ kind: 'bin', text: new TextDecoder('utf-8').decode(bytes) }];
  }
  function addVerifyHit(res, label, hits, matched) {
    res.hits += hits;
    matched.forEach(function (m) { if (res.matched.indexOf(m) < 0) res.matched.push(m); });
    var p = null;
    for (var i = 0; i < res.parts.length; i++) {
      if (res.parts[i].name === label) { p = res.parts[i]; break; }
    }
    if (!p) { p = { name: label, hits: 0, matched: [] }; res.parts.push(p); }
    p.hits += hits;
    matched.forEach(function (m) { if (p.matched.indexOf(m) < 0) p.matched.push(m); });
  }

  function scanViews(views, engine, label, res) {
    views.forEach(function (v) {
      var r;
      try { r = engine.scan(v.text, true, true); } catch (e) { return; }
      if (!r || !r.hits) return;
      addVerifyHit(res, label + (VIEW_KIND_LABEL[v.kind] || ''), r.hits, r.matched || []);
    });
  }

  function mergeVerify(dst, src) {
    dst.scanned += src.scanned;
    src.parts.forEach(function (p) { addVerifyHit(dst, p.name, p.hits, p.matched); });
  }

  /**
   * 复检一个 ZIP 包（含内嵌 Office 文档递归）里的全部条目：
   *  外部保密检查软件按「解包 + 全文检索」工作，因此这里不做部件策略筛选、也不受范围（首行 / 尾行）限制
   * @returns {Promise<{hits:number, matched:string[], parts:{name,hits,matched}[], scanned:number}>}
   */
  function verifyZip(zip, engine, prefix, depth, budget) {
    var res = { hits: 0, matched: [], parts: [], scanned: 0 };
    var tasks = zip.entries.map(function (entry) {
      res.scanned++;
      // 条目名明文存放在 ZIP 本地文件头 / 中央目录里，保密检查软件解包前就能检索到，必须担入检查范围
      scanViews([{ kind: 'name', text: entry.name }], engine, prefix + entry.name, res);
      return zip.getBytes(entry.name).then(function (bytes) {
        if (!bytes || !bytes.length) return;
        // 内嵌 Office 文档：内容同样是外部检查工具的检索对象，递归复检
        if (/embeddings\//.test(entry.name) && isOfficeFile(entry.name)) {
          assertNestedBudget(budget, bytes.byteLength, depth);
          var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          return Zip.load(ab).then(function (inner) {
            return verifyZip(inner, engine, prefix + entry.name + '!', depth + 1, budget).then(function (sub) {
              mergeVerify(res, sub);
            });
          }, function () {
            scanViews(viewsFor(entry.name, bytes), engine, prefix + entry.name, res);
          });
        }
        scanViews(viewsFor(entry.name, bytes), engine, prefix + entry.name, res);
      }).catch(function () { /* 单条目读取失败不拖垮整体复检 */ });
    });
    return Promise.all(tasks).then(function () { return res; });
  }

  /**
   * 清除后自检：对处理结果做一次「全文 + 全部部件」复查
   * @param {ArrayBuffer} arrayBuffer docx / xlsx / pptx 字节
   * @param {Object} engine createEngine 生成（调用方传 scope:'all'，自检不受范围限制）
   */
  function verifyOffice(arrayBuffer, engine) {
    return Zip.load(arrayBuffer).then(function (zip) {
      return verifyZip(zip, engine, '', 0, officeBudget(arrayBuffer.byteLength));
    });
  }

  /**
   * 清除后自检（纯文本 / 二进制文件）：直接对解码后的全文检索
   * @returns {Promise<{hits:number, matched:string[], parts:Array}>}
   */
  function verifyBytes(bytes, engine) {
    if (!bytes || !bytes.length) return Promise.resolve({ hits: 0, matched: [], parts: [] });
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return verifyOffice(ab, engine).then(function (r) {
        return { hits: r.hits, matched: r.matched, parts: r.parts };
      });
    }
    return Promise.resolve().then(function () {
      var res = { hits: 0, matched: [], parts: [] };
      scanViews(viewsFor('x.txt', bytes), engine, '', res);
      return res;
    });
  }
  global.DWRDoc = {
    TEXT_EXT: TEXT_EXT,
    WORD_EXT: WORD_EXT,
    EXCEL_EXT: EXCEL_EXT,
    PPT_EXT: PPT_EXT,
    OFFICE_EXT: OFFICE_EXT,
    COMMON_EXT: COMMON_EXT,
    setExtFilter: setExtFilter,
    getExtFilter: getExtFilter,
    extOf: extOf,
    kindOf: kindOf,
    isTextFile: isTextFile,
    isOfficeFile: isOfficeFile,
    isSupported: isSupported,
    decodeText: decodeText,
    encodeText: encodeText,
    processText: processText,
    previewProcess: previewProcess,
    processOffice: processOffice,
    scanOffice: scanOffice,
    verifyOffice: verifyOffice,
    OOXML_LIMITS: OOXML_LIMITS,
    verifyBytes: verifyBytes,
    extractText: extractText,
    extractPreview: extractPreview,
    encodeXml: encodeXml,
    decodeXml: decodeXml
  };
})(window);
