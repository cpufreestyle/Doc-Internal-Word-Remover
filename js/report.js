/**
 * report.js —— 解析通用检查软件导出的 HTML 报告 / 路径清单
 *
 * 背景：外部检查工具的详细报告通常是一个 HTML 文件，
 * 里面按「关键词命中文件记录 / 标密文件记录 / 判定的密级文件记录」等分节列出命中文件，
 * 每行含 文件名称 / 文件路径 / 命中关键字 / 命中百分比 / 标记密级 等列。
 * 本模块把这类报告解析成统一的 [{ file, hits, matched[], size }] 清单，
 * 网页端据此批量加载这些文件，CLI 的 --from-report 也复用它（JSON 清单继续支持）。
 *
 * 设计取舍：不依赖 DOM（CLI 是 Node、无 window），用正则按 <tr>/<td> 拆行；
 * 「文件路径」列不写死下标——先认每个分节自己的表头行（单元格以「路径/关键字/大小」
 * 结尾），记住列下标供后续数据行使用；表头认不出时退化为「单元格像 Windows 路径」
 * 的启发式，兼容不同版本报告的列序差异。同一文件在多个分节重复出现时合并命中关键
 * 字、按路径小写去重。
 */
(function (global) {
  'use strict';

  var NAMED_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  /** 解码常见 HTML 实体（含 &#x4E2D; / &#20013; 数字实体） */
  function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, function (m, hex, dec, name) {
      try {
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        if (dec) return String.fromCodePoint(parseInt(dec, 10));
        var v = NAMED_ENT[name.toLowerCase()];
        return v === undefined ? m : v;
      } catch (e) { return m; }
    });
  }

  /** 去掉一段 HTML 的标签，压缩空白 */
  function cellText(html) {
    var t = String(html == null ? '' : html)
      .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '');
    t = decodeEntities(t).replace(/[\u3000\s]+/g, ' ').trim();
    return t;
  }


  /** 探测字节流编码：兼容 UTF-16LE/BE 与 UTF-8（含无 BOM 的 UTF-16） */
  function detectEncoding(u8) {
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) return 'utf-16le';
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) return 'utf-16be';
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return 'utf-8';
    // 无 BOM 的 UTF-16：ASCII 字符在 UTF-16 中必然「隔位」出现 0x00（中文等双字节字符没有零字节，
    // 但 HTML 报告里标签 / 路径全是 ASCII，隔位零的比例足够高，是 UTF-16 最强的字节级特征）
    var altZeros = function (offset) {
      var n = Math.min(u8.length, 2048), zeros = 0, total = 0;
      for (var i = offset; i < n; i += 2) { total++; if (u8[i] === 0) zeros++; }
      return total >= 8 && zeros / total > 0.4;
    };
    if (altZeros(1)) return 'utf-16le';
    if (altZeros(0)) return 'utf-16be';
    try { new TextDecoder('utf-8', { fatal: true }).decode(u8); return 'utf-8'; }
    catch (e) { /* 不是合法 UTF-8：按 UTF-16LE 兜底（检查软件报告的主流导出编码） */ }
    return 'utf-16le';
  }

  /**
   * 报告字节流 → 字符串。部分检查软件会以 UTF-16LE 导出，
   * 直接当 UTF-8 读会得到带大量 \u0000 的乱码，因此这里先探测编码再解码。
   * 浏览器侧传 ArrayBuffer、Node 侧传 Buffer 均可。
   */
  function decodeBytes(bytes) {
    if (bytes == null) return '';
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!u8.length) return '';
    var enc = detectEncoding(u8);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder(enc).decode(u8);
    if (enc === 'utf-8' && typeof Buffer !== 'undefined') {
      return Buffer.from(u8).toString('utf8').replace(/^\uFEFF/, '');
    }
    var le = enc !== 'utf-16be', out = '';
    for (var i = 2; i + 1 < u8.length; i += 2) {
      var lo = u8[i], hi = u8[i + 1];
      out += String.fromCharCode(le ? (lo | (hi << 8)) : ((lo << 8) | hi));
    }
    return out;
  }

  /** Windows 绝对路径 / UNC 路径判定（报告里路径单元格的稳定特征） */
  function isPathLike(s) {
    // Windows 绝对路径（C:/ 或 C:\）、UNC（\\server\share）、POSIX 绝对路径（/usr/...）
    // 后者让 Linux/macOS 上生成或导入的报告同样可解析（CI 在 Linux 跑，测试此前必挂）
    return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]/.test(s) || s.charAt(0) === '/';
  }

  function normCell(c) { return String(c == null ? '' : c).replace(/\s+/g, ''); }

  /** 命中关键字单元格如 “秘密(1)|内部(2)” → ['秘密','内部'] */
  function parseKeywords(cell) {
    if (!cell) return [];
    var out = [];
    cell.split(/[|,;，；]/).forEach(function (seg) {
      var w = seg.replace(/\(\s*\d*\s*\)?\s*$/g, '').trim();
      if (!w || isLevelMark(w)) return;
      if (out.indexOf(w) < 0) out.push(w);
    });
    return out;
  }

  /** 密级判定标记：方括号包裹且以「级」结尾，如 [绝密级]、[机密级]
   *
   *  这类形态出现在「标密文件记录」分节：它表示该文件被判定为绝密级，
   *  而不是文中出现了「绝密级」三个字。当成关键词命中，会凭空多出一个
   *  词库里根本没有的词，词级交叉校验时会被误判成「检查软件报了但我们没命中」。 */
  function isLevelMark(w) {
    var s = String(w);
    var closeOf = { '[': ']', '【': '】', '（': '）', '(': ')' };
    var open = s.charAt(0);
    if (!Object.prototype.hasOwnProperty.call(closeOf, open)) return false;
    if (s.charAt(s.length - 1) !== closeOf[open]) return false;
    var inner = s.slice(1, -1);
    return inner.length >= 1 && inner.length <= 8 && /级$/.test(inner);
  }

  /** 密级判定标记的等级名，如 [绝密级] → 绝密级 */
  function levelMarkName(w) {
    return isLevelMark(w) ? String(w).slice(1, -1) : '';
  }

  /** 整个单元格就是「词(次数)[|词(次数)…]」形状（表头缺关键字列时的兜底识别） */
  function isKeywordCell(c) {
    return /^[^|()]+\(\d+\)(?:\s*[|,;，；]\s*[^|()]+\(\d+\))*$/.test(normCell(c));
  }

  /**
   * 命中关键字单元格 → { words:[{word,count}], unknown:boolean }
   *
   *  鼎普等保密检查软件的这一列是带次数的：“内部(2)|秘密(1)”，括号里是该词在文件里的
   *  出现次数。v4.84 之前这个次数被整个丢掉，于是报告里的「N 处」只剩词种类数，
   *  与本工具的命中处数根本不是同一个量纲，两者无法互相校验。
   *
   *  - count 为 null：报告只给了裸词，没给次数，按 1 处计
   *  - unknown：报告写的是「未知」——检查软件自己都没认出是哪个词，不是关键词命中
   */
  function parseKeywordCell(cell) {
    var res = { words: [], unknown: false, level: '' };
    if (!cell) return res;
    cell.split(/[|,;，；]/).forEach(function (seg) {
      var s = String(seg).trim();
      if (!s) return;
      var m = /^(.*?)[（(]\s*(\d+)\s*[)）]\s*$/.exec(s);
      var word, count = null;
      if (m) { word = m[1].trim(); count = parseInt(m[2], 10); }
      else { word = s.replace(/[（(]\s*\d*\s*[)）]\s*$/g, '').trim(); }
      if (!word) return;
      if (word === '未知') { res.unknown = true; return; }
      if (isLevelMark(word)) {
        // 密级判定标记：不是原样的关键词命中，但 [绝密级] 就是「命中了绝密」，
        // 去掉「级」字后按普通命中词计入——否则这类行会因「没有关键词」被漏掉，
        // 而我们恰恰该核对：检查软件判了绝密，本工具有没有检出绝密。
        var name = levelMarkName(word);
        if (!res.level) res.level = name;
        var core = name.replace(/级$/, '');
        if (core) res.words.push({ word: core, count: 1 });
        return;
      }
      res.words.push({ word: word, count: count });
    });
    return res;
  }

  /** 词 → 该词报告的命中次数（同词取最大值：跨分节重复出现时是同一批内容，不能累加） */
  function mergeCount(map, word, count) {
    var n = (count == null) ? 1 : count;
    if (!(word in map) || map[word] < n) map[word] = n;
  }

  /** 每词次数表 → 总处数 */
  function totalOccurrences(counts) {
    var n = 0;
    for (var w in counts) {
      if (Object.prototype.hasOwnProperty.call(counts, w)) n += counts[w];
    }
    return n;
  }

  /** 大小单元格 → 字节数：兼容「1,024」「45 B」「12.5 KB」「2MB」等写法（无单位按字节）。
   *  不能只拼接数字——「12.5 MB」会拼成 125，报告里的大小列会整体失真 */
  function toSize(v) {
    var s = String(v || '').replace(/,/g, '');
    var m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB|B|K|M|G|T)?\b/i.exec(s.trim());
    if (!m) return 0;
    var n = parseFloat(m[1]);
    var mult = { '': 1, B: 1, K: 1024, KB: 1024, M: 1048576, MB: 1048576,
      G: 1073741824, GB: 1073741824, T: 1099511627776, TB: 1099511627776 }[(m[2] || '').toUpperCase()];
    return (isFinite(n) && n > 0 && mult) ? Math.round(n * mult) : 0;
  }

  /**
   * 时间单元格 → 毫秒时间戳。外部检查系统给的是「2025-03-04 19:03:25」，
   * 也可能给「2025/03/04 19:03」或空值；解析不了就返回 0（界面上留空，不编造时间）。
   */
  function toTime(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s === '-' || s === '--') return 0;
    // 统一分隔符：日期里的「/」「年」「月」与时间里的「:」都交给 Date 解析
    var norm = s.replace(/年|月/g, '-').replace(/日/g, ' ').replace(/\//g, '-');
    var m = /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(norm);
    if (!m) {
      var t = Date.parse(s);
      return isFinite(t) ? t : 0;
    }
    return new Date(+m[1], +m[2] - 1, +m[3],
      m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0).getTime();
  }

  /**
   * 百分比单元格 → 0~1 的小数。「25.0%」「25%」「0.25」三种写法都能吃下。
   * 报告给的是检查软件按「命中字数 / 全文总字数」算出来的占比，
   * 原样留存后可以和本工具复检出来的占比并排对照——两者不一致本身就是重要信号。
   */
  function toRatio(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s === '-' || s === '--') return 0;
    var m = /^([\d.]+)\s*%$/.exec(s);
    if (m) {
      var p = parseFloat(m[1]);
      return isFinite(p) ? Math.max(0, Math.min(1, p / 100)) : 0;
    }
    var n = parseFloat(s);
    if (!isFinite(n)) return 0;
    // 没有百分号时按「已是 0~1 的小数」处理；大于 1 的按百分数补算
    return n > 1 ? Math.max(0, Math.min(1, n / 100)) : Math.max(0, Math.min(1, n));
  }

  /** 按 <tr> 拆行，行内按 <td> 拆单元格（其余结构一律忽略） */
  function htmlRows(html) {
    var rows = [];
    var trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;
    while ((m = trRe.exec(html)) !== null) {
      var cells = [], tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi, t;
      while ((t = tdRe.exec(m[1])) !== null) cells.push(cellText(t[1]));
      if (cells.length) rows.push(cells);
    }
    return rows;
  }

  /**
   * 识别表头行：某单元格以「路径」结尾，且同行还有名称/关键字/大小等表头字样。
   * 数据行的文件名也可能含「路径」二字，因此要求同行必须另有表头特征才算表头，
   * 避免把数据行误判成表头而丢文件。
   * @returns {{path:number, kw:number, size:number}|null}
   */
  function headerCols(cells) {
    var pathIdx = -1, kwIdx = -1, sizeIdx = -1, hasName = false;
    var ctimeIdx = -1, mtimeIdx = -1, catIdx = -1, pctIdx = -1;
    var markLevelIdx = -1, verdictIdx = -1;
    cells.forEach(function (c, i) {
      var t = normCell(c);
      // 「路径」结尾且本身像 Windows 路径的是数据行（文件落在 …\文件路径 之类目录下），
      // 不是表头——表头单元格是「文件路径 / 路径」这样的列名
      if (pathIdx < 0 && /(?:文件)?(?:全)?路径$/.test(t) && !isPathLike(t)) pathIdx = i;
      else if (kwIdx < 0 && /关键字$/.test(t)) kwIdx = i;
      else if (sizeIdx < 0 && /(?:文件)?大小$/.test(t)) sizeIdx = i;
      else if (/^(?:文件)?名称$/.test(t)) hasName = true;
      // v4.94：外部检查系统结果表的其余列。
      //   创建时间 / 修改时间 两列名只差「创」「修」，必须分别判定，不能用同一个正则。
      else if (ctimeIdx < 0 && /^创建时间$/.test(t)) ctimeIdx = i;
      else if (mtimeIdx < 0 && /^(?:修改时间|最后修改时间)$/.test(t)) mtimeIdx = i;
      else if (catIdx < 0 && /^(?:文件)?类别$/.test(t)) catIdx = i;
      else if (pctIdx < 0 && /(?:百分比|占比)$/.test(t)) pctIdx = i;
      else if (markLevelIdx < 0 && /^(?:标记密级|密级标记|标记)$/.test(t)) markLevelIdx = i;
      else if (verdictIdx < 0 && /^(?:涉密情况|涉密判定|判定结果)$/.test(t)) verdictIdx = i;
    });
    if (pathIdx < 0) return null;
    if (!hasName && kwIdx < 0 && sizeIdx < 0) return null;
    // v4.94：把外部检查系统结果表里其余几列一并定位下来。
    //   此前只取路径 / 关键字 / 大小三列，报告里给的创建时间、修改时间、文件类别、
    //   命中百分比、标记密级、涉密情况在解析时被直接丢掉——这些是检查软件已经算好的结论，
    //   导入后应当原样留存以便与本工具的复检结果逐项对照，不能因为「我们自己也能算」就扔掉。
    return {
      path: pathIdx, kw: kwIdx, size: sizeIdx,
      ctime: ctimeIdx, mtime: mtimeIdx, cat: catIdx,
      pct: pctIdx, markLevel: markLevelIdx, verdict: verdictIdx
    };
  }

  /**
   * 解析保密检查软件的 HTML 详细报告
   * @returns {{files: Array<{file:string, hits:number, matched:string[], size:number,
   *          counts:Object<string,number>, occurrences:number, unknown:boolean}>, sections: string[]}}
   *          hits = 命中词种类数（历史语义，保持不变）；occurrences = 报告给出的总处数
   */
  function parseHtml(html) {
    var text = String(html || '');
    var files = [], seen = {}, sections = [];
    var rows = htmlRows(text);

    // 分节标题（ToggleTable 的参数就是各节的表格 id），仅用于日志 / 展示。
    // 先解码实体：部分报告把引号写成 &#39;
    var secRe = /ToggleTable\(\s*'([^']+)'\s*,/g, sm;
    var plain = decodeEntities(text);
    while ((sm = secRe.exec(plain)) !== null) {
      if (sections.indexOf(sm[1]) < 0) sections.push(sm[1]);
    }

    var cols = null; // 最近一次表头行的列下标（每个分节都有自己的表头行）
    rows.forEach(function (cells) {
      var head = headerCols(cells);
      if (head) { cols = head; return; } // 表头行本身不是数据

      var file = '';
      if (cols && cols.path >= 0 && cells[cols.path] && isPathLike(cells[cols.path])) file = cells[cols.path];
      if (!file) {
        // 表头缺失/列序异常时：取第一个像 Windows 路径的单元格
        for (var i = 0; i < cells.length; i++) {
          if (isPathLike(cells[i])) { file = cells[i]; break; }
        }
      }
      if (!file) return;
      var key = file.toLowerCase();

      // 关键词单元格：优先用表头定位的列，表头缺失 / 列序异常时再按「词(次数)」形状兜底
      var kw = (cols && cols.kw >= 0) ? parseKeywordCell(cells[cols.kw]) : { words: [], unknown: false, level: '' };
      if (!kw.words.length && !kw.unknown) {
        for (var k = 0; k < cells.length; k++) {
          if (isKeywordCell(cells[k])) { kw = parseKeywordCell(cells[k]); break; }
        }
      }
      var matched = [];
      kw.words.forEach(function (x) {
        if (matched.indexOf(x.word) < 0) matched.push(x.word);
      });
      var size = cols && cols.size >= 0 ? toSize(cells[cols.size]) : 0;
      // v4.94：外部检查系统给出的其余列，原样留档。
      //   这些字段在报告里是「检查软件已经得出的结论」，导入后必须保留，
      //   才能和本工具复检的结果逐项对照（本工具算出不同的占比 / 密级，正是要看的信号）。
      var ctime = cols && cols.ctime >= 0 ? toTime(cells[cols.ctime]) : 0;
      var mtime = cols && cols.mtime >= 0 ? toTime(cells[cols.mtime]) : 0;
      var ratio = cols && cols.pct >= 0 ? toRatio(cells[cols.pct]) : 0;
      var markLevel = cols && cols.markLevel >= 0 ? normCell(cells[cols.markLevel]) : '';
      var verdict = cols && cols.verdict >= 0 ? normCell(cells[cols.verdict]) : '';
      var cat = cols && cols.cat >= 0 ? normCell(cells[cols.cat]) : '';

      var prev = seen[key];
      if (prev) { // 同一文件出现在多个分节：合并命中关键字、补全大小
        kw.words.forEach(function (x) {
          if (prev.matched.indexOf(x.word) < 0) prev.matched.push(x.word);
          mergeCount(prev.counts, x.word, x.count);
        });
        prev.unknown = prev.unknown || kw.unknown;
        if (!prev.level && kw.level) prev.level = kw.level;
        prev.hits = prev.matched.length;
        prev.occurrences = totalOccurrences(prev.counts);
        if (!prev.size && size) prev.size = size;
        if (!prev.ctime && ctime) prev.ctime = ctime;
        if (!prev.mtime && mtime) prev.mtime = mtime;
        if (!prev.ratio && ratio) prev.ratio = ratio;
        if (!prev.markLevel && markLevel) prev.markLevel = markLevel;
        if (!prev.verdict && verdict) prev.verdict = verdict;
        if (!prev.cat && cat) prev.cat = cat;
        return;
      }
      var counts = {};
      kw.words.forEach(function (x) { mergeCount(counts, x.word, x.count); });
      var item = {
        file: file,
        hits: matched.length,
        matched: matched,
        size: size,
        // v4.84：每词的命中次数与总处数——检查软件报的「N 处」是处数，不是词种类数
        counts: counts,
        occurrences: totalOccurrences(counts),
        unknown: kw.unknown,
        level: kw.level || '',
        // v4.94：外部检查系统的原报告字段（留档用，不参与本工具的判定）
        ctime: ctime,
        mtime: mtime,
        ratio: ratio,
        markLevel: markLevel,
        verdict: verdict,
        cat: cat
      };
      seen[key] = item;
      files.push(item);
    });

    return { files: files, sections: sections };
  }

  /**
   * 解析纯路径清单（每行一个路径，支持一行多路径按盘符拆、# 开头为注释）
   */
  function parsePathList(text) {
    var files = [], seen = {};
    String(text || '').split(/[\r\n]+/).forEach(function (line) {
      var l = line.trim();
      if (!l || l.charAt(0) === '#') return;
      l.split(/(?=[A-Za-z]:[\\/])/).forEach(function (seg) {
        var p = seg.trim().replace(/^[,;、，]+|[,;、，]+$/g, '');
        if (!isPathLike(p)) return;
        var key = p.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        files.push({ file: p, hits: 0, matched: [], size: 0, counts: {}, occurrences: 0, unknown: false });
      });
    });
    return { files: files, sections: [] };
  }

  /** 本工具自己导出的 JSON 报告（{meta,files:[{file,…}]} 或纯数组） */
  function parseJsonList(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return { files: [], sections: [] }; }
    var arr = Array.isArray(data) ? data : (data && Array.isArray(data.files) ? data.files : []);
    var files = [], seen = {};
    arr.forEach(function (it) {
      var f = it && (it.file || it.path);
      if (!f || !isPathLike(String(f))) return;
      var key = String(f).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      files.push({
        file: String(f),
        hits: it.hits | 0,
        matched: it.matched || [],
        size: it.size | 0,
        // JSON 清单没有逐词次数，处数按给定的命中数计
        counts: it.counts || {},
        occurrences: it.occurrences != null ? (it.occurrences | 0) : (it.hits | 0),
        unknown: !!it.unknown
      });
    });
    return { files: files, sections: [] };
  }

  /** 按扩展名 / 内容自动选解析器 */
  function parseAny(name, text) {
    var n = String(name || '').toLowerCase();
    var head = String(text || '').slice(0, 400).replace(/^\uFEFF/, '').trim();
    if (/\.json$/.test(n)) return parseJsonList(text);
    if (/\.(?:html?|htm)$/.test(n) || /^</.test(head)) return parseHtml(text);
    return parsePathList(text);
  }

  global.DWRReport = {
    decodeEntities: decodeEntities,
    parseHtml: parseHtml,
    parsePathList: parsePathList,
    parseJsonList: parseJsonList,
    parseAny: parseAny,
    parseKeywords: parseKeywords,
    parseKeywordCell: parseKeywordCell,
    decodeBytes: decodeBytes,
    detectEncoding: detectEncoding,
    isPathLike: isPathLike
  };
})(typeof window !== 'undefined' ? window : globalThis);
