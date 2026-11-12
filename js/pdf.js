/**
 * pdf.js —— PDF 正文提取（只读）
 *
 * 为什么需要它：外部保密检查软件按「解包 + 全文检索」工作，PDF 正文同样会被
 * 命中。本工具此前把 .pdf 归入「不支持格式」，只能查文件名——实测被检查软件
 * 报出的 116 个 PDF 里只有 4 个能从文件名看出来，剩下 112 个是纯漏报。
 *
 * 做法（不引第三方库、不依赖 DecompressionStream）：
 *   1) 按 `N G obj … endobj` 切对象，流按 `stream … endstream` 取原始字节；
 *   2) 自带 DEFLATE 解压（zlib / deflate-raw 两种写法都认）；
 *   3) 每页经 /Resources → /Font 找字体，用 /ToUnicode CMap（bfchar / bfrange）
 *      把字形码还原成 Unicode；
 *   4) 内容流按 PDF 运算符走：Tf 切字体，Tj / TJ / ' / " 取文本。
 *
 * 解压没有沿用 DecompressionStream：Chrome / Node 对「流结束后还有多余字节」
 * 的处理不一致（Node 会抛到进程级，try/catch 抓不住），而 PDF 的 stream 与
 * endstream 之间常带 CR/LF。自带解码器行为确定，浏览器与命令行结果一致。
 *
 * 已覆盖：直接 / 间接 / 继承（/Parent 链）的 /Resources、CID 字体的十六进制
 * 与字面量字符串、1 字节与 2 字节字形码、多内容流页面、增量更新对象。
 * 未覆盖：/Encrypt 加密、损坏文件、扫描件（只有图片没有文本层）、对象流
 * （/ObjStm）里的字体与内容。读不到正文时返回空文本，调用方会降级成
 * 「仅文件名」，不会把「没读」说成「干净」。
 */
(function (global) {
  'use strict';

  var LIMITS = {
    maxObjects: 400000,
    maxPages: 4000,
    maxInflate: 96 * 1024 * 1024,
    maxStream: 24 * 1024 * 1024,
    maxTokens: 400000,
    maxText: 24 * 1024 * 1024
  };

  var DELIM = /[\s\/\[\]<>(){}%]/;

  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function bytesToLatin1(bytes) {
    var out = '', chunk = 0x4000, i;
    for (i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return out;
  }

  function latin1ToBytes(str) {
    var u = new Uint8Array(str.length), i;
    for (i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
    return u;
  }

  /* ---------------- DEFLATE（RFC 1951） ---------------- */

  function buildHuff(lengths, n) {
    var count = new Int32Array(16), symbol = new Int32Array(n), offs = new Int32Array(16), i;
    for (i = 0; i < n; i++) count[lengths[i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count: count, symbol: symbol };
  }

  var FIXED_LIT = null, FIXED_DIST = null;
  function fixedTables() {
    if (FIXED_LIT) return;
    var l = new Uint8Array(288), i;
    for (i = 0; i < 144; i++) l[i] = 8;
    for (; i < 256; i++) l[i] = 9;
    for (; i < 280; i++) l[i] = 7;
    for (; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildHuff(l, 288);
    var d = new Uint8Array(30);
    for (i = 0; i < 30; i++) d[i] = 5;
    FIXED_DIST = buildHuff(d, 30);
  }

  /**
   * 解压一段 raw DEFLATE。
   * @param {Uint8Array} data 压缩数据
   * @param {number} start 起始偏移（zlib 头之后）
   * @param {number} maxOut 输出上限
   */
  function inflateRaw(data, start, maxOut) {
    var pos = start, bitBuf = 0, bitCnt = 0;
    var out = new Uint8Array(4096), outLen = 0;

    function bits(n) {
      while (bitCnt < n) {
        if (pos >= data.length) throw new Error('PDF 压缩流被截断');
        bitBuf |= data[pos++] << bitCnt;
        bitCnt += 8;
      }
      var v = bitBuf & ((1 << n) - 1);
      bitBuf >>>= n;
      bitCnt -= n;
      return v;
    }

    function ensure(n) {
      if (outLen + n <= out.length) return;
      var cap = out.length;
      while (cap < outLen + n) cap *= 2;
      if (cap > maxOut) throw new Error('PDF 流解压超过上限');
      var nb = new Uint8Array(cap);
      nb.set(out.subarray(0, outLen));
      out = nb;
    }

    function decodeSym(h) {
      var code = 0, first = 0, index = 0, len;
      for (len = 1; len <= 15; len++) {
        code |= bits(1);
        var count = h.count[len];
        if (code - first < count) return h.symbol[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('PDF 压缩流编码非法');
    }

    function block(lit, dist) {
      for (;;) {
        var sym = decodeSym(lit);
        if (sym < 256) {
          ensure(1);
          out[outLen++] = sym;
          continue;
        }
        if (sym === 256) return;
        var li = sym - 257;
        if (li >= 29) throw new Error('PDF 压缩流符号越界');
        var len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
        var ds = decodeSym(dist);
        if (ds >= 30) throw new Error('PDF 压缩流距离越界');
        var d = DIST_BASE[ds] + bits(DIST_EXTRA[ds]);
        if (d > outLen) throw new Error('PDF 压缩流回溯越界');
        ensure(len);
        for (var i = 0; i < len; i++) {
          out[outLen] = out[outLen - d];
          outLen++;
        }
      }
    }

    var last = 0;
    while (!last) {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > data.length) throw new Error('PDF 压缩流被截断');
        var len0 = data[pos] | (data[pos + 1] << 8);
        var nlen = data[pos + 2] | (data[pos + 3] << 8);
        pos += 4;
        if ((len0 ^ 0xffff) !== nlen) throw new Error('PDF 压缩流长度校验失败');
        if (pos + len0 > data.length) throw new Error('PDF 压缩流被截断');
        ensure(len0);
        out.set(data.subarray(pos, pos + len0), outLen);
        outLen += len0;
        pos += len0;
      } else if (type === 1) {
        fixedTables();
        block(FIXED_LIT, FIXED_DIST);
      } else if (type === 2) {
        var nlen2 = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        var cl = new Uint8Array(19), i;
        for (i = 0; i < ncode; i++) cl[CL_ORDER[i]] = bits(3);
        var clh = buildHuff(cl, 19);
        var lengths = new Uint8Array(nlen2 + ndist);
        i = 0;
        while (i < lengths.length) {
          var s = decodeSym(clh);
          if (s < 16) { lengths[i++] = s; continue; }
          var rep, val = 0;
          if (s === 16) {
            if (!i) throw new Error('PDF 压缩流码长非法');
            val = lengths[i - 1];
            rep = 3 + bits(2);
          } else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > lengths.length) throw new Error('PDF 压缩流码长越界');
          while (rep--) lengths[i++] = val;
        }
        block(buildHuff(lengths.subarray(0, nlen2), nlen2),
          buildHuff(lengths.subarray(nlen2), ndist));
      } else {
        throw new Error('PDF 压缩流块类型非法');
      }
    }
    return out.subarray(0, outLen);
  }

  /** /FlateDecode：zlib（带 2 字节头）与 raw 两种写法都认 */
  function inflateStream(bytes, budget) {
    var left = LIMITS.maxStream;
    if (budget) left = Math.min(left, budget.limit - budget.used);
    if (left <= 0) return null;
    var end = bytes.length;
    // stream 与 endstream 之间常有多余的 CR / LF，解压器会把它当垃圾字节
    while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
    var zlib = end > 2 && (bytes[0] & 0x0f) === 8 && (((bytes[0] << 8) | bytes[1]) % 31) === 0;
    var out;
    try {
      out = inflateRaw(bytes, zlib ? 2 : 0, left);
    } catch (e) {
      // 头判定错了就换一种再试（少数生成器写的是「zlib 头 + raw 数据」一类畸形流）
      try {
        out = inflateRaw(bytes, zlib ? 0 : 2, left);
      } catch (e2) {
        return null;
      }
    }
    if (budget) budget.used += out.length;
    return out;
  }

  /* ---------------- 对象 ---------------- */

  /**
   * 按 `N G obj` 切对象。二进制流里可能撞出同样的字面量，所以每个对象的
   * 段落到「下一个 obj 头」为止，流体再单独按 endstream 收口——先切头再收流，
   * 单靠 endobj 会被流内的二进制骗到。
   */
  function parseObjects(raw) {
    var objs = new Map();
    var marks = [];
    var re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    var m;
    while ((m = re.exec(raw))) {
      if (marks.length >= LIMITS.maxObjects) break;
      marks.push({ num: m[1], gen: +m[2], start: m.index, body: m.index + m[0].length });
    }
    for (var k = 0; k < marks.length; k++) {
      var limit = k + 1 < marks.length ? marks[k + 1].start : raw.length;
      var seg = raw.slice(marks[k].body, limit);
      var sI = seg.indexOf('stream');
      var rec = { num: +marks[k].num, gen: marks[k].gen, dict: seg, body: null };
      if (sI >= 0) {
        rec.dict = seg.slice(0, sI);
        var p = sI + 6;
        if (seg.charAt(p) === '\r') p++;
        if (seg.charAt(p) === '\n') p++;
        var eI = seg.indexOf('endstream', p);
        if (eI < 0) eI = seg.length;
        rec.body = { s: marks[k].body + p, e: marks[k].body + eI };
      }
      // 增量更新：同一对象号后出现的版本才是生效版本
      objs.set(marks[k].num, rec);
    }
    return objs;
  }

  /** 去掉流末尾的 CR / LF / 空格（zlib 与 AES 都要求数据干净） */
  function trimTail(bytes) {
    var end = bytes.length;
    while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d || bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end--;
    return end === bytes.length ? bytes : bytes.subarray(0, end);
  }

  /** 取对象的可检索文本；图片流与未知编码流返回 null */
  function streamText(ctx, o) {
    if (!o || !o.body) return null;
    var dict = o.dict || '';
    if (/\/Subtype\s*\/Image\b/.test(dict)) { ctx.hasImage = true; return null; }
    if (/\/(?:DCT|JPX|CCITTFax|JBIG2|RunLength)Decode\b/.test(dict)) return null;
    var data = latin1ToBytes(ctx.raw.slice(o.body.s, o.body.e));
    if (ctx.crypt) {
      data = decryptStream(ctx, o, trimTail(data));
      if (!data || !data.length) return null;
    }
    if (!/\/FlateDecode\b/.test(dict)) return bytesToLatin1(data);
    var out = inflateStream(data, ctx.budget);
    return out ? bytesToLatin1(out) : null;
  }

  /**
   * 展开对象流（/Type /ObjStm）。
   * PDF 1.5+ 常把页面、字体、资源字典整块压进对象流里，文件里连一个
   * `/Type /Page` 都搜不到——不展开的话整份 PDF 读出来是 0 字，等于漏检。
   * 流的内容是「N 组「对象号 偏移」+ 各对象正文」，偏移相对 /First。
   * 只补文件里没直接出现的对象号：显式定义优先。
   */
  function expandObjStms(ctx) {
    var streams = [];
    ctx.objs.forEach(function (o) {
      if (/\/Type\s*\/ObjStm\b/.test(o.dict || '')) streams.push(o);
    });
    for (var i = 0; i < streams.length; i++) {
      var o = streams[i];
      var txt = streamText(ctx, o);
      if (!txt) continue;
      var nm = /\/N\s+(\d+)/.exec(o.dict || '');
      var fm = /\/First\s+(\d+)/.exec(o.dict || '');
      var count = nm ? parseInt(nm[1], 10) : 0;
      var first = fm ? parseInt(fm[1], 10) : -1;
      if (!(count > 0) || !(first >= 0) || first > txt.length) continue;
      var pairs = [], m;
      var re = /(\d+)\s+(\d+)/g;
      var head = txt.slice(0, first);
      while ((m = re.exec(head)) && pairs.length < count) pairs.push([m[1], +m[2]]);
      for (var k = 0; k < pairs.length; k++) {
        var start = first + pairs[k][1];
        var end = k + 1 < pairs.length ? first + pairs[k + 1][1] : txt.length;
        if (start < 0 || start >= txt.length) continue;
        if (end < start || end > txt.length) end = txt.length;
        if (!ctx.objs.has(pairs[k][0])) {
          ctx.objs.set(pairs[k][0], { num: +pairs[k][0], gen: 0, dict: txt.slice(start, end), body: null });
        }
      }
    }
  }

  /* ---------------- 字体 / ToUnicode ---------------- */

  function resourceDict(objs, o) {
    var dict = o.dict || '';
    var rr = /\/Resources\s+(\d+)\s+(\d+)\s+R/.exec(dict);
    if (rr) {
      var ro = objs.get(rr[1]);
      if (ro) return ro.dict + ' ' + dict;
    }
    return dict;
  }

  /** 资源名 → 字体对象号（F1 → 12） */
  function fontsOf(objs, o) {
    if (o.__fonts !== undefined) return o.__fonts;
    var dict = resourceDict(objs, o);
    var out = new Map();
    var re = /\/([^\s\/\[\]<>()]+)\s+(\d+)\s+(\d+)\s+R/g;
    var m;
    var seg = /\/Font\s*<<([\s\S]{0,20000}?)>>/.exec(dict);
    if (seg) {
      while ((m = re.exec(seg[1]))) out.set(m[1], m[2]);
    }
    if (!out.size) {
      var fr = /\/Font\s+(\d+)\s+(\d+)\s+R/.exec(dict);
      var fo = fr && objs.get(fr[1]);
      if (fo) {
        re.lastIndex = 0;
        while ((m = re.exec(fo.dict))) out.set(m[1], m[2]);
      }
    }
    if (!out.size) { o.__fonts = null; return null; }
    o.__fonts = out;
    return out;
  }

  /** 资源名 → XObject 对象号（/XObject << /X1 12 0 R >>） */
  function xobjectsOf(objs, o) {
    if (o.__xo !== undefined) return o.__xo;
    var dict = resourceDict(objs, o);
    var out = new Map();
    var re = /\/([^\s\/\[\]<>()]+)\s+(\d+)\s+(\d+)\s+R/g;
    var m;
    var seg = /\/XObject\s*<<([\s\S]{0,20000}?)>>/.exec(dict);
    if (seg) {
      while ((m = re.exec(seg[1]))) out.set(m[1], m[2]);
    }
    if (!out.size) {
      var xr = /\/XObject\s+(\d+)\s+(\d+)\s+R/.exec(dict);
      var xo = xr && objs.get(xr[1]);
      if (xo) {
        re.lastIndex = 0;
        while ((m = re.exec(xo.dict))) out.set(m[1], m[2]);
      }
    }
    if (!out.size) { o.__xo = null; return null; }
    o.__xo = out;
    return out;
  }

  function hexToUnicode(hex) {
    var s = '', i;
    for (i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    if (!s && hex.length) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  }

  /**
   * 解析 CMap 的 bfchar / bfrange。
   * step 是字形码的十六进制位数：简单字体 2 位（1 字节），CID 字体 4 位（2 字节）。
   * 两者都要认——只按 4 位切会把所有简单字体的中文全丢掉。
   */
  function buildCMap(txt) {
    var map = new Map(), len = 0;
    function padKey(c, width) {
      var s = c.toString(16).toUpperCase();
      while (s.length < width) s = '0' + s;
      return s;
    }
    function add(key, val) {
      key = key.toUpperCase();
      if (!len || key.length < len) len = key.length;
      map.set(key, val);
    }
    var bc = /beginbfchar([\s\S]*?)endbfchar/g, m, e;
    while ((m = bc.exec(txt))) {
      var re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      while ((e = re.exec(m[1]))) add(e[1], hexToUnicode(e[2]));
    }
    var br = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = br.exec(txt))) {
      var re2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
      while ((e = re2.exec(m[1]))) {
        var lo = parseInt(e[1], 16), hi = parseInt(e[2], 16);
        if (!(hi >= lo) || hi - lo > 65535) continue;
        var pad = e[1].length, c, k;
        if (e[3] !== undefined) {
          var base = parseInt(e[3].substr(0, 4), 16);
          for (c = lo; c <= hi; c++) add(padKey(c, pad), String.fromCharCode(base + (c - lo)));
        } else {
          var arr = e[4].match(/<([0-9A-Fa-f]+)>/g) || [];
          for (c = lo, k = 0; c <= hi && k < arr.length; c++, k++) {
            add(padKey(c, pad), hexToUnicode(arr[k].slice(1, -1)));
          }
        }
      }
    }
    if (!map.size) return null;
    return { map: map, step: len >= 6 ? 6 : (len >= 4 ? 4 : 2) };
  }

  /** 字体对象号 → { map, step }（同一 PDF 内缓存，跨文档不共享） */
  function fontEntry(ctx, num) {
    if (ctx.fonts.has(num)) return ctx.fonts.get(num);
    var ent = null;
    var o = ctx.objs.get(num);
    var tu = o && /\/ToUnicode\s+(\d+)\s+(\d+)\s+R/.exec(o.dict);
    if (tu) {
      var t = ctx.objs.get(tu[1]);
      if (t) {
        var txt = streamText(ctx, t);
        if (txt) ent = buildCMap(txt);
      }
    }
    ctx.fonts.set(num, ent);
    return ent;
  }

  function resolveFonts(ctx, table) {
    if (!table) return null;
    var out = new Map();
    table.forEach(function (num, name) {
      out.set(name, fontEntry(ctx, num));
    });
    return out;
  }

  /* ---------------- 内容流 ---------------- */

  function tokenize(src) {
    var tokens = [], i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '%') {
        while (i < n && src.charAt(i) !== '\n' && src.charAt(i) !== '\r') i++;
        continue;
      }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '(') {
        var r = readLiteral(src, i);
        tokens.push({ t: 'str', v: r.v });
        i = r.end;
      } else if (c === '<' && src.charAt(i + 1) === '<') {
        tokens.push({ t: 'op', v: '<<' }); i += 2;
      } else if (c === '>' && src.charAt(i + 1) === '>') {
        tokens.push({ t: 'op', v: '>>' }); i += 2;
      } else if (c === '<') {
        var e = src.indexOf('>', i);
        if (e < 0) break;
        tokens.push({ t: 'hex', v: src.slice(i + 1, e) });
        i = e + 1;
      } else if (c === '/') {
        var j = i + 1;
        while (j < n && !DELIM.test(src.charAt(j))) j++;
        tokens.push({ t: 'name', v: src.slice(i + 1, j) });
        i = j;
      } else if (c === '[' || c === ']' || c === '{' || c === '}') {
        tokens.push({ t: 'op', v: c }); i++;
      } else {
        var k = i;
        while (k < n && !DELIM.test(src.charAt(k))) k++;
        if (k === i) { i++; continue; }
        var w = src.slice(i, k);
        i = k;
        if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) tokens.push({ t: 'num', v: parseFloat(w) });
        else tokens.push({ t: 'op', v: w });
      }
      if (tokens.length > LIMITS.maxTokens) return null;
    }
    return tokens;
  }

  /** 读 PDF 字面量字符串：括号可嵌套，`\ddd` 是八进制字节 */
  function readLiteral(src, start) {
    var depth = 1, i = start + 1, out = '';
    while (i < src.length) {
      var c = src.charAt(i);
      if (c === '\\') { out += c + src.charAt(i + 1); i += 2; continue; }
      if (c === '(') { depth++; out += c; i++; continue; }
      if (c === ')') {
        depth--;
        if (!depth) return { v: out, end: i + 1 };
        out += c; i++; continue;
      }
      out += c; i++;
    }
    return { v: out, end: i };
  }

  function hex2(b) {
    var s = (b & 0xff).toString(16).toUpperCase();
    return s.length < 2 ? '0' + s : s;
  }

  function literalToHex(lit) {
    var out = '', i;
    for (i = 0; i < lit.length; i++) {
      var ch = lit.charAt(i);
      if (ch !== '\\') { out += hex2(lit.charCodeAt(i)); continue; }
      var nx = lit.charAt(++i);
      if (nx === 'n') out += '0A';
      else if (nx === 'r') out += '0D';
      else if (nx === 't') out += '09';
      else if (nx === 'b') out += '08';
      else if (nx === 'f') out += '0C';
      else if (nx === '(' || nx === ')' || nx === '\\') out += hex2(nx.charCodeAt(0));
      else if (nx >= '0' && nx <= '7') {
        var oct = nx;
        while (/[0-7]/.test(lit.charAt(i + 1)) && oct.length < 3) oct += lit.charAt(++i);
        out += hex2(parseInt(oct, 8));
      } else if (nx === '\r') { if (lit.charAt(i + 1) === '\n') i++; }
      else if (nx === '\n') { /* 续行 */ }
      else out += hex2(nx.charCodeAt(0));
    }
    return out;
  }

  function decodeHex(hex, ent) {
    hex = hex.replace(/[^0-9A-Fa-f]/g, '');
    if (!hex) return '';
    var out = '', i;
    if (!ent || !ent.map) {
      // 没有 ToUnicode：只有 ASCII 可信，高位字节一律丢弃（避免解出假汉字）
      if (hex.length % 2) hex = hex.slice(0, -1);
      for (i = 0; i + 2 <= hex.length; i += 2) {
        var b = parseInt(hex.substr(i, 2), 16);
        if (b < 0x20 || b > 0x7e) return '';
        out += String.fromCharCode(b);
      }
      return out;
    }
    var step = ent.step;
    for (i = 0; i + step <= hex.length; i += step) {
      var c = ent.map.get(hex.substr(i, step).toUpperCase());
      if (c) out += c;
    }
    return out;
  }

  function decodeLiteral(lit, ent) {
    var hex = literalToHex(lit);
    if (!ent || !ent.map) {
      var out = '', i;
      for (i = 0; i + 2 <= hex.length; i += 2) {
        var b = parseInt(hex.substr(i, 2), 16);
        out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : ' ';
      }
      return out;
    }
    return decodeHex(hex, ent);
  }

  function textOf(tok, ent) {
    if (!tok) return '';
    if (tok.t === 'str') return decodeLiteral(tok.v, ent);
    if (tok.t === 'hex') return decodeHex(tok.v, ent);
    return '';
  }

  /**
   * 估一段文本在页面上的宽度（pt）。只用于判断页面是不是分栏排版，
   * 不参与关键字匹配，所以粗估即可：汉字按全角 1em，西文按 0.52em。
   * 块内多行时取最宽的一行。
   */
  function estTextWidth(text, size) {
    var s = size > 0 ? size : 10;
    var best = 0, w = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '\n') { if (w > best) best = w; w = 0; continue; }
      var code = text.charCodeAt(i);
      w += (code >= 0x2e80) ? 1.0 : ((code >= 0x20 && code <= 0x7e) ? 0.52 : 0.5);
    }
    return (w > best ? w : best) * s;
  }

  /**
   * 把块按 Y 分行（容差 3pt）。分行是判断分栏的关键：
   * 真分栏时，同一行里左侧栏和右侧栏的块都在。
   */
  function groupRows(items) {
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i], placed = false;
      for (var r = 0; r < rows.length; r++) {
        if (Math.abs(it.y - rows[r].y) <= 3) { rows[r].items.push(it); placed = true; break; }
      }
      if (!placed) rows.push({ y: it.y, items: [it] });
    }
    rows.sort(function (a, b) { return b.y - a.y; });
    return rows;
  }

  function medianOf(nums) {
    if (!nums.length) return 0;
    var a = nums.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * 找分栏的竖沟（栏与栏之间的空白带）。返回升序的边界数组，
   * 空数组表示整页单栏。
   *
   * 判据要同时满足，否则会误伤：
   *  - 竖沟够宽（≥12pt）；
   *  - 竖沟两侧都有块，且各自跨 ≥2 行（真栏目，不是同一行里两个图标）；
   *  - ≥2 行同时出现左右两侧的块（两栏在同一基线上对齐）；
   *  - 两侧块的典型宽度不小于竖沟宽度——否则「字距很宽的一行字」
   *    会被误判成两栏。
   */
  function detectColumnGaps(items) {
    if (items.length < 4) return [];
    var sorted = items.slice().sort(function (a, b) { return a.x - b.x; });
    var ranges = [];
    for (var i = 0; i < sorted.length; i++) {
      var s0 = sorted[i].x, e0 = sorted[i].x + sorted[i].w;
      var last = ranges[ranges.length - 1];
      if (!last || s0 > last[1]) ranges.push([s0, e0]);
      else if (e0 > last[1]) last[1] = e0;
    }
    var rows = groupRows(items);
    var gaps = [];
    for (var g = 1; g < ranges.length; g++) {
      var gStart = ranges[g - 1][1], gEnd = ranges[g][0];
      var gw = gEnd - gStart;
      if (gw < 12) continue;
      var left = [], right = [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        if (it.x + it.w <= gStart + 1) left.push(it);
        else if (it.x >= gEnd - 1) right.push(it);
      }
      if (left.length < 2 || right.length < 2) continue;
      var bothRows = 0, leftRows = 0, rightRows = 0;
      for (var r = 0; r < rows.length; r++) {
        var hasL = false, hasR = false;
        for (var q = 0; q < rows[r].items.length; q++) {
          var ri = rows[r].items[q];
          if (left.indexOf(ri) >= 0) hasL = true;
          if (right.indexOf(ri) >= 0) hasR = true;
        }
        if (hasL) leftRows++;
        if (hasR) rightRows++;
        if (hasL && hasR) bothRows++;
      }
      if (bothRows < 2) continue;
      if (leftRows < 2 || rightRows < 2) continue;
      var lw = medianOf(left.map(function (it) { return it.w; }));
      var rw = medianOf(right.map(function (it) { return it.w; }));
      if (lw < gw || rw < gw) continue;
      gaps.push({ start: gStart, end: gEnd });
    }
    return gaps;
  }

  /**
   * 解一条内容流。`owner` 是提供 /Resources 的对象（页面或表单），
   * 这样 `Do` 调用的 Form XObject 才能继续往里读——页眉页脚、水印、
   * 图表标注里的「内部」常整块放在表单对象里，只看页面内容流会漏。
   */
  function decodeContent(ctx, src, owner, fonts, depth, seen) {
    var toks = tokenize(src);
    if (!toks) return '';
    var s = '', ops = [], arr = null, dictDepth = 0, cur = null, i, k, j;
    // P1 阅读顺序归一化：BT 块级收集，块间按坐标排序，块内保持流内顺序。
    // 逐字定位的 PDF（思维导图、图表标注、整块水印）一个字一个 BT，
    // 块内绝不能拆词；块间按 Y 从上到下、同 Y 从左到右排，才是视觉阅读顺序。
    var blocks = [], curBlock = null;
    var lx = 0, ly = 0, leading = 0;   // 文本行矩阵原点与行距
    var curSize = 10;                  // 当前字号，用来估算块宽（判断分栏）
    for (i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.t === 'op' && t.v === '<<') { dictDepth++; continue; }
      if (t.t === 'op' && t.v === '>>') { if (dictDepth > 0) dictDepth--; continue; }
      if (dictDepth > 0) continue;
      if (t.t === 'op' && t.v === '[') { arr = []; continue; }
      if (t.t === 'op' && t.v === ']') { ops.push({ t: 'arr', v: arr || [] }); arr = null; continue; }
      if (t.t === 'name' || t.t === 'str' || t.t === 'hex' || t.t === 'num') {
        (arr || ops).push(t);
        continue;
      }
      var v = t.v;
      if (v === 'Tf') {
        var nm = null;
        for (k = 0; k < ops.length; k++) if (ops[k].t === 'name') nm = ops[k].v;
        cur = nm && fonts ? (fonts.get(nm) || null) : null;
        var fsz = 0;
        for (k = 0; k < ops.length; k++) if (ops[k].t === 'num') fsz = +ops[k].v;
        if (fsz > 0) curSize = fsz;
      } else if (v === 'Tm') {
        // Tm 是绝对定位：后两个数就是行矩阵原点 (e, f)
        if (ops.length >= 2) {
          lx = +ops[ops.length - 2].v;
          ly = +ops[ops.length - 1].v;
          if (curBlock && curBlock.y === null) { curBlock.y = ly; curBlock.x = lx; }
        }
      } else if (v === 'Td' || v === 'TD') {
        // Td / TD 是相对上一行矩阵的平移，必须累加：
        // 当成绝对坐标用，所有行都会落到原点附近，排序等于没排。
        if (ops.length >= 2) {
          var tdx = +ops[ops.length - 2].v, tdy = +ops[ops.length - 1].v;
          if (v === 'TD') leading = -tdy;
          lx += tdx; ly += tdy;
          // 排序键只取块内第一次定位：Td 在段落内是逐行下移，取最后一次会让
          // 长段落落到页面底部，阅读顺序反而乱掉。
          if (curBlock && curBlock.y === null) { curBlock.y = ly; curBlock.x = lx; }
        }
      } else if (v === 'T*') {
        // T* 换到下一行：行距由 TD 设定，没设就是 0
        ly -= leading;
        if (curBlock && curBlock.y === null) { curBlock.y = ly; curBlock.x = lx; }
      } else if (v === 'Tj' || v === "'" || v === '"') {
        if (v !== 'Tj') { if (curBlock) curBlock.text += '\n'; else s += '\n'; }
        var txt = textOf(ops[ops.length - 1], cur);
        if (curBlock) { curBlock.text += txt; if (!curBlock.size) curBlock.size = curSize; }
        else s += txt;
      } else if (v === 'TJ') {
        var a = ops[ops.length - 1];
        if (a && a.t === 'arr') for (j = 0; j < a.v.length; j++) {
          var jt = textOf(a.v[j], cur);
          if (curBlock) { curBlock.text += jt; if (!curBlock.size) curBlock.size = curSize; }
          else s += jt;
        }
      } else if (v === 'Do') {
        var xn = null;
        for (k = 0; k < ops.length; k++) if (ops[k].t === 'name') xn = ops[k].v;
        if (xn && depth < 6) {
          var table = xobjectsOf(ctx.objs, owner);
          var num = table && table.get(xn);
          var xo = num && ctx.objs.get(num);
          if (xo && !seen[num] && /\/Subtype\s*\/Form\b/.test(xo.dict || '')) {
            seen[num] = 1;
            var sub = streamText(ctx, xo);
            if (sub) {
              var subFonts = resolveFonts(ctx, fontsOf(ctx.objs, xo)) || fonts;
              var subTxt = decodeContent(ctx, sub, xo, subFonts, depth + 1, seen) + '\n';
              if (curBlock) curBlock.text += subTxt; else s += subTxt;
            }
          }
        }
      } else if (v === 'BT' || v === 'ET' || v === 'T*') {
        // 只在这三处断行。Td / Tm 是「每字定位」，按它断行会把「秘密」拆成
        // 两行——这类逐字定位的 PDF 很常见（思维导图、图表标注），一律漏词。
        if (v === 'BT') {
          // 规范里 BT 会把文本矩阵与行矩阵复位，所以块起点要等块内第一次 Td/Tm；
          // 沿用上一块的坐标只会把新段落排到旧位置附近。
          lx = 0; ly = 0; leading = 0;
            curBlock = { y: null, x: null, text: '', size: 0 };
          blocks.push(curBlock);
        } else if (v === 'ET') {
          curBlock = null;
        }
      }
      ops = [];
      arr = null;
    }
    // P1 阅读顺序归一化：BT 块按视觉顺序排序（Y 从上到下，同 Y 从左到右），
    // 块内保持原有片段顺序，避免逐字定位的「内 部」被拆散。容差内视为同一行。
    var ordered = '';
    if (blocks.length) {
      // 没定位的块（缺 Tm / Td）继承前后已知坐标：向前继承上一块，
      // 还不知道就向后借下一块的，两头都没有就只能按流内顺序留在原位。
      for (var bi = 1; bi < blocks.length; bi++) {
        if (blocks[bi].y == null) { blocks[bi].y = blocks[bi - 1].y; }
        if (blocks[bi].x == null) { blocks[bi].x = blocks[bi - 1].x; }
      }
      for (var bj = blocks.length - 2; bj >= 0; bj--) {
        if (blocks[bj].y == null) { blocks[bj].y = blocks[bj + 1].y; }
        if (blocks[bj].x == null) { blocks[bj].x = blocks[bj + 1].x; }
      }
      // 排序键缺失的块（两页都没坐标）不参与排序：留在原位，
      // 免得被当成 Y=0 拖到页面最底下。
      var keyed = blocks.filter(function (b) { return b.y != null; });
      var unkeyed = blocks.filter(function (b) { return b.y == null; });

      // 分栏检测：整页单栏就按 (Y 从上到下, 同 Y 从左到右) 排；
      // 若是两栏 / 三栏，先按栏从左到右，栏内再从上到下——
      // 否则左右两栏会按行交叉，读出来变成「A1 B1 A2 B2」。
      var items = keyed.filter(function (b) { return b.text; }).map(function (b) {
        b.col = 0;
        return { x: b.x, y: b.y, w: estTextWidth(b.text, b.size), b: b };
      });
      var gaps = detectColumnGaps(items);
      for (var gi = 0; gi < gaps.length; gi++) {
        for (var qi = 0; qi < items.length; qi++) {
          if (items[qi].x >= gaps[gi].start) items[qi].b.col++;
        }
      }

      keyed.sort(function (a, b) {
        if (a.col !== b.col) return a.col - b.col;
        var dY = b.y - a.y;
        return Math.abs(dY) < 2 ? (a.x - b.x) : dY;
      });
      ordered = keyed.concat(unkeyed).map(function (b) { return b.text; })
        .filter(function (t) { return t !== ''; }).join('\n');
    }
    return s + ordered;
  }

  function contentRefs(objs, page) {
    var dict = page.dict || '';
    var refs = [], m;
    var one = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict);
    if (one) { refs.push(one[1]); return refs; }
    var arr = /\/Contents\s*\[([\s\S]{0,4000}?)\]/.exec(dict);
    if (arr) {
      var re = /(\d+)\s+\d+\s+R/g;
      while ((m = re.exec(arr[1]))) refs.push(m[1]);
    }
    return refs;
  }

  /** 页面自己的字体表；没有就沿 /Parent 链往上找 */
  function pageFonts(ctx, page) {
    var table = fontsOf(ctx.objs, page);
    var up = page, guard = 0;
    while (!table && guard++ < 8) {
      var pr = /\/Parent\s+(\d+)\s+(\d+)\s+R/.exec(up.dict || '');
      var po = pr && ctx.objs.get(pr[1]);
      if (!po) break;
      table = fontsOf(ctx.objs, po);
      up = po;
    }
    return table;
  }

  /* ---------------- 标准安全处理器（空用户口令） ----------------
     政企 PDF 常见「只设权限密码、不设打开密码」：文件里的流照样是加密的。
     保密检查软件按空口令解开再检索，本工具解不开就等于整份漏检。
     这里实现 R2 / R3 / R4 的 Standard 处理器（MD5 派生密钥 + RC4 / AES-128-CBC）；
     AES-256（R5 / R6）不在支持范围，遇到时按「读不到」降级，不猜内容。 */

  var PAD = new Uint8Array([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
  ]);

  function rotl8(x, n) { return ((x << n) | (x >>> (8 - n))) & 0xff; }

  function gfMul(a, b) {
    var p = 0, i;
    for (i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return p;
  }

  function md5(bytes) {
    var SH = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = new Int32Array(64), i;
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    var len = bytes.length;
    var blocks = ((len + 8) >> 6) + 1;
    var words = new Int32Array(blocks * 16);
    for (i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i & 3) << 3);
    words[len >> 2] |= 0x80 << ((len & 3) << 3);
    var bits = len * 8;
    words[blocks * 16 - 2] = bits | 0;
    words[blocks * 16 - 1] = Math.floor(bits / 4294967296) | 0;
    var a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (var off = 0; off < words.length; off += 16) {
      var A = a0, B = b0, C = c0, D = d0, f, g, tmp;
      for (i = 0; i < 64; i++) {
        if (i < 16) { f = (B & C) | (~B & D); g = i; }
        else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { f = C ^ (B | ~D); g = (7 * i) & 15; }
        tmp = D; D = C; C = B;
        var v = (A + f + K[i] + words[off + g]) | 0;
        B = (B + ((v << SH[i]) | (v >>> (32 - SH[i])))) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    var out = new Uint8Array(16), ws = [a0, b0, c0, d0];
    for (i = 0; i < 4; i++) {
      out[i * 4] = ws[i] & 0xff;
      out[i * 4 + 1] = (ws[i] >> 8) & 0xff;
      out[i * 4 + 2] = (ws[i] >> 16) & 0xff;
      out[i * 4 + 3] = (ws[i] >>> 24) & 0xff;
    }
    return out;
  }

  function rc4(key, data) {
    var S = new Uint8Array(256), i, j = 0, t;
    for (i = 0; i < 256; i++) S[i] = i;
    for (i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 255;
      t = S[i]; S[i] = S[j]; S[j] = t;
    }
    var out = new Uint8Array(data.length);
    i = 0; j = 0;
    for (var k = 0; k < data.length; k++) {
      i = (i + 1) & 255;
      j = (j + S[i]) & 255;
      t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  }

  var SBOX = null, INV_SBOX = null;
  function buildSbox() {
    if (SBOX) return;
    SBOX = new Uint8Array(256);
    INV_SBOX = new Uint8Array(256);
    var inv = new Uint8Array(256), a, b;
    for (a = 1; a < 256; a++) {
      for (b = 1; b < 256; b++) if (gfMul(a, b) === 1) { inv[a] = b; break; }
    }
    for (a = 0; a < 256; a++) {
      var v = inv[a];
      var s = (v ^ rotl8(v, 1) ^ rotl8(v, 2) ^ rotl8(v, 3) ^ rotl8(v, 4) ^ 0x63) & 0xff;
      SBOX[a] = s;
      INV_SBOX[s] = a;
    }
  }

  function expandKey(key) {
    var w = new Uint8Array(176);
    w.set(key);
    var rcon = 1;
    for (var i = 16; i < 176; i += 4) {
      var t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
      if (i % 16 === 0) {
        t0 = SBOX[t1] ^ rcon;
        t1 = SBOX[t2];
        t2 = SBOX[t3];
        t3 = SBOX[w[i - 4]];
        rcon = gfMul(rcon, 2);
      }
      w[i] = w[i - 16] ^ t0;
      w[i + 1] = w[i - 15] ^ t1;
      w[i + 2] = w[i - 14] ^ t2;
      w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
  }

  function addRoundKey(s, w, round) {
    var base = round * 16;
    for (var i = 0; i < 16; i++) s[i] ^= w[base + i];
  }

  function invShiftRows(s) {
    var a, b, c, d;
    // 第 1 行右移 1：new[1]=old[13] new[5]=old[1] new[9]=old[5] new[13]=old[9]
    a = s[1]; b = s[5]; c = s[9]; d = s[13];
    s[1] = d; s[5] = a; s[9] = b; s[13] = c;
    // 第 2 行右移 2
    a = s[2]; b = s[6]; c = s[10]; d = s[14];
    s[2] = c; s[6] = d; s[10] = a; s[14] = b;
    // 第 3 行右移 3
    a = s[3]; b = s[7]; c = s[11]; d = s[15];
    s[3] = b; s[7] = c; s[11] = d; s[15] = a;
  }

  function invMixColumns(s) {
    for (var c = 0; c < 16; c += 4) {
      var a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
      s[c] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
      s[c + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
      s[c + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
      s[c + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
    }
  }

  function aesDecryptBlock(w, block) {
    var s = new Uint8Array(block), i, r;
    addRoundKey(s, w, 10);
    for (r = 9; r >= 1; r--) {
      invShiftRows(s);
      for (i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
      addRoundKey(s, w, r);
      invMixColumns(s);
    }
    invShiftRows(s);
    for (i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    addRoundKey(s, w, 0);
    return s;
  }

  function aesCbcDecrypt(key, data) {
    if (data.length < 32 || data.length % 16) return null;
    buildSbox();
    var w = expandKey(key);
    var out = new Uint8Array(data.length - 16);
    var prev = data.subarray(0, 16), at = 0, i, k;
    for (i = 16; i < data.length; i += 16) {
      var blk = aesDecryptBlock(w, data.subarray(i, i + 16));
      for (k = 0; k < 16; k++) out[at + k] = blk[k] ^ prev[k];
      prev = data.subarray(i, i + 16);
      at += 16;
    }
    return out;
  }

  function hexToU8(hex) {
    hex = String(hex).replace(/[^0-9A-Fa-f]/g, '');
    var n = hex.length >> 1, u = new Uint8Array(n), i;
    for (i = 0; i < n; i++) u[i] = parseInt(hex.substr(i * 2, 2), 16);
    return u;
  }

  /** 从加密字典里取 /O、/U 这类字节串 */
  function dictBytes(dict, key) {
    var at = dict.indexOf('/' + key);
    if (at < 0) return null;
    var i = at + key.length + 1;
    while (i < dict.length && /\s/.test(dict.charAt(i))) i++;
    if (dict.charAt(i) === '(') return hexToU8(literalToHex(readLiteral(dict, i).v));
    if (dict.charAt(i) === '<') {
      var e = dict.indexOf('>', i);
      if (e < 0) return null;
      return hexToU8(dict.slice(i + 1, e));
    }
    return null;
  }

  /** 读 trailer / 加密字典，算出文件主密钥；不支持或非 Standard 时返回 null */
  function setupCrypt(ctx) {
    if (ctx.raw.indexOf('/Encrypt') < 0) return null;
    var dict = null;
    var ref = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(ctx.raw);
    if (ref) {
      var o = ctx.objs.get(ref[1]);
      dict = o ? o.dict : null;
    }
    if (!dict) {
      var inline = /\/Encrypt\s*<<([\s\S]{0,800}?)>>/.exec(ctx.raw);
      dict = inline ? inline[1] : null;
    }
    if (!dict || !/\/Filter\s*\/Standard\b/.test(dict)) return null;
    var R = parseInt((/\/R\s+(\d+)/.exec(dict) || [])[1], 10);
    if (!(R >= 2 && R <= 4)) return null;
    if (/\/AESV3\b/.test(dict)) return null;
    // /CF << /StdCF << /Length 16 >> >> 里的 Length 是「字节」，
    // 外面那个才是位长（128 / 256）。先摘掉 /CF 再取，否则 128 位会被读成 16 位。
    var head = dict.replace(/\/CF\s*<<[\s\S]*?>>\s*>>/g, '').replace(/\/CF\s*<<[\s\S]*?>>/g, '');
    var bits = parseInt((/\/Length\s+(\d+)/.exec(head) || [])[1], 10) || 40;
    var n = R === 2 ? 5 : Math.floor(bits / 8);
    if (n < 5) n = 5;
    if (n > 16) n = 16;
    var O = dictBytes(dict, 'O');
    if (!O || O.length < 32) return null;
    var idm = /\/ID\s*\[\s*<([0-9A-Fa-f\s]+)>/.exec(ctx.raw);
    var id = idm ? hexToU8(idm[1]) : new Uint8Array(0);
    var p = parseInt((/\/P\s+(-?\d+)/.exec(dict) || [])[1], 10);
    if (isNaN(p)) return null;
    var buf = [], i;
    for (i = 0; i < 32; i++) buf.push(PAD[i]);
    for (i = 0; i < 32; i++) buf.push(O[i]);
    buf.push(p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff);
    for (i = 0; i < Math.min(16, id.length); i++) buf.push(id[i]);
    if (R >= 4 && /\/EncryptMetadata\s+false/.test(dict)) buf.push(0xff, 0xff, 0xff, 0xff);
    var key = md5(new Uint8Array(buf));
    if (R >= 3) {
      for (i = 0; i < 50; i++) key = md5(key.subarray(0, n));
    }
    return { key: key.subarray(0, n), aes: /\/AESV2\b/.test(dict) };
  }

  /** 密钥 + 对象号 + 代号（AES 还要加 sAlT）派生该对象的密钥 */
  function objectKey(crypt, num, gen) {
    var buf = [], i;
    for (i = 0; i < crypt.key.length; i++) buf.push(crypt.key[i]);
    buf.push(num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff);
    buf.push(gen & 0xff, (gen >> 8) & 0xff);
    if (crypt.aes) buf.push(0x73, 0x41, 0x6c, 0x54);
    var h = md5(new Uint8Array(buf));
    return h.subarray(0, Math.min(16, crypt.key.length + 5));
  }

  function decryptStream(ctx, o, data) {
    if (!ctx.crypt) return data;
    var k = objectKey(ctx.crypt, o.num, o.gen);
    if (ctx.crypt.aes) return aesCbcDecrypt(k, data);
    return rc4(k, data);
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 去掉汉字之间的空白。
   * 很多 PDF（Word / WPS 导出）为两端对齐把标题逐字定位，取出来是「内 部」，
   * 按普通子串搜「内部」就永远搜不到。只处理「汉字 + 空白 + 汉字」这一种形态：
   * 英文单词之间的空格、中文与数字之间的空格都保留，不制造跨词误报。
   */
  function compactCjk(text) {
    return text.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  }

  /**
   * 提取 PDF 正文。
   * @param {Uint8Array} bytes
   * @returns {{text:string, pages:number, encrypted:boolean, chars:number}|null}
   */
  function extract(bytes, options) {
    if (!bytes || bytes.length < 16) return null;
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) return null;
    var ctx = {
      raw: bytesToLatin1(bytes),
      objs: null,
      budget: { used: 0, limit: LIMITS.maxInflate },
      fonts: new Map(),
      crypt: null,
      hasImage: false
    };
    ctx.objs = parseObjects(ctx.raw);
    // 加密必须在展开对象流之前生效：/ObjStm 本身也是加密流
    ctx.crypt = setupCrypt(ctx);
    expandObjStms(ctx);

    var pages = [];
    ctx.objs.forEach(function (o) {
      if (/\/Type\s*\/Page\b/.test(o.dict || '')) pages.push(o);
    });
    if (!pages.length) {
      // 目录损坏、缺 /Type 的 PDF：退化成「带 /Contents 的对象」
      ctx.objs.forEach(function (o) {
        if (/\/Contents\s+(?:\d+\s+\d+\s+R|\[)/.test(o.dict || '')) pages.push(o);
      });
    }
    if (pages.length > LIMITS.maxPages) pages = pages.slice(0, LIMITS.maxPages);

    var inherit = null;
    for (var i = 0; i < pages.length; i++) {
      var t0 = fontsOf(ctx.objs, pages[i]);
      if (t0) inherit = t0;
    }

    var text = '';
    for (var p = 0; p < pages.length; p++) {
      if (options && typeof options.shouldCancel === 'function' && options.shouldCancel()) {
        return {
          cancelled: true,
          pagesDone: p,
          pagesTotal: pages.length
        };
      }
      if (options && typeof options.onProgress === 'function') {
        options.onProgress({
          page: p + 1,
          pagesTotal: pages.length
        });
      }
      var fonts = resolveFonts(ctx, pageFonts(ctx, pages[p]) || inherit);
      var refs = contentRefs(ctx.objs, pages[p]);
      for (var r = 0; r < refs.length; r++) {
        if (text.length >= LIMITS.maxText) break;
        var txt = streamText(ctx, ctx.objs.get(refs[r]));
        if (txt) text += decodeContent(ctx, txt, pages[p], fonts, 0, {}) + '\n';
      }
    }

    return {
      text: compactCjk(text),
      pages: pages.length,
      encrypted: ctx.raw.indexOf('/Encrypt') >= 0,
      chars: text.length,
      imageOnly: compactCjk(text).trim() === '' && countImages(ctx) > 0
    };
  }

  /** 页面里有没有图片流（用于把「只有图片、没文本层」的扫描件标出来） */
  function countImages(ctx) {
    var n = 0;
    ctx.objs.forEach(function (o) {
      if (/\/Subtype\s*\/Image\b/.test(o.dict || '')) n++;
    });
    return n;
  }

  global.DWRPdf = {
    extract: extract,
    LIMITS: LIMITS
  };
})(typeof window !== 'undefined' ? window : globalThis);
