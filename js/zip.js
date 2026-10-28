/**
 * zip.js —— 零依赖 ZIP 读写
 * 基于浏览器原生 DecompressionStream / CompressionStream（Chrome 80+ / Edge 80+）
 * 用于读写 Office Open XML（.docx / .xlsx / .pptx）以及导出处理结果。
 */
(function (global) {
  'use strict';

  var SIG_LOCAL = 0x04034b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_EOCD = 0x06054b50;
  var DEFAULT_LIMITS = {
    maxEntryBytes: 256 * 1024 * 1024,
    maxArchiveBytes: 512 * 1024 * 1024,
    maxEntries: 10000
  };

  /* ---------------- CRC32 ---------------- */

  var _crcTable = null;
  function crcTable() {
    if (_crcTable) return _crcTable;
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c >>> 0;
    }
    _crcTable = t;
    return t;
  }

  function crc32(buf) {
    var t = crcTable();
    var c = 0xffffffff;
    for (var i = 0; i < buf.length; i++) {
      c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------- 原生压缩 / 解压 ---------------- */

  function isSupported() {
    return typeof global.DecompressionStream !== 'undefined' &&
           typeof global.CompressionStream !== 'undefined';
  }

  function inflateRaw(data, options) {
    options = options || {};
    var maxBytes = options.maxBytes > 0 ? options.maxBytes : DEFAULT_LIMITS.maxEntryBytes;
    var budget = options.budget || null;
    var ds = new global.DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(total);
          var at = 0;
          chunks.forEach(function (chunk) {
            out.set(chunk, at);
            at += chunk.length;
          });
          return out;
        }
        var chunk = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value);
        if (total + chunk.length > maxBytes) {
          throw new Error('ZIP 单个条目解压后超过安全上限（' + Math.round(maxBytes / 1048576) + ' MB）');
        }
        if (budget && budget.used + chunk.length > budget.limit) {
          throw new Error('ZIP 累计解压数据超过安全上限（' + Math.round(budget.limit / 1048576) + ' MB）');
        }
        if (budget) budget.used += chunk.length;
        chunks.push(chunk);
        total += chunk.length;
        return pump();
      });
    }
    return pump().then(function (out) {
      return out;
    }, function (err) {
      try { reader.cancel(); } catch (e) {}
      throw err;
    });
  }

  function deflateRaw(data) {
    var cs = new global.CompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(cs);
    return new Response(stream).arrayBuffer().then(function (ab) {
      return new Uint8Array(ab);
    });
  }

  /* ---------------- 读取 ---------------- */

  function findEocd(dv) {
    var min = Math.max(0, dv.byteLength - 22 - 0xffff);
    for (var i = dv.byteLength - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  /**
   * 解析 ZIP 目录，返回条目数组（不解压数据）
   * entry: { name, method, flags, crc, compSize, uncompSize, offset, compData }
   */
  function parseDirectory(buffer, limits) {
    limits = limits || DEFAULT_LIMITS;
    var dv = new DataView(buffer);
    if (dv.byteLength < 22) throw new Error('不是有效的 ZIP/OOXML 文件（文件过短）');
    var eocd = findEocd(dv);
    if (eocd < 0) throw new Error('不是有效的 ZIP/OOXML 文件（未找到结束记录）');

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    if (count > limits.maxEntries) {
      throw new Error('ZIP 条目数超过安全上限（' + limits.maxEntries + '）');
    }
    if (cdOffset > eocd || cdOffset + 4 > dv.byteLength) {
      throw new Error('ZIP 中央目录偏移越界');
    }
    var entries = [];
    var p = cdOffset;

    for (var i = 0; i < count; i++) {
      if (p + 46 > dv.byteLength || p + 46 > eocd) throw new Error('ZIP 中央目录条目越界');
      if (dv.getUint32(p, true) !== SIG_CENTRAL) break;

      var flags = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var crc = dv.getUint32(p + 16, true);
      var compSize = dv.getUint32(p + 20, true);
      var uncompSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);

      var nameStart = p + 46;
      var directoryEnd = nameStart + nameLen + extraLen + commentLen;
      if (directoryEnd > dv.byteLength || directoryEnd > eocd) {
        throw new Error('ZIP 中央目录名称或扩展字段越界');
      }
      var name = decodeName(new Uint8Array(buffer, nameStart, nameLen), flags);

      // ZIP64 扩展字段
      var extraStart = nameStart + nameLen;
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        var ex = readZip64Extra(dv, extraStart, extraLen);
        if (uncompSize === 0xffffffff) uncompSize = ex.uncompSize;
        if (compSize === 0xffffffff) compSize = ex.compSize;
        if (localOffset === 0xffffffff) localOffset = ex.offset;
      }

      // 定位本地文件头，计算真实数据起点
      var lp = localOffset;
      if (lp + 30 > dv.byteLength) throw new Error('ZIP 本地文件头偏移越界: ' + name);
      if (dv.getUint32(lp, true) !== SIG_LOCAL) throw new Error('ZIP 本地文件头签名无效: ' + name);
      var lNameLen = dv.getUint16(lp + 26, true);
      var lExtraLen = dv.getUint16(lp + 28, true);
      var dataStart = lp + 30 + lNameLen + lExtraLen;
      if (dataStart > dv.byteLength || dataStart + compSize > dv.byteLength) {
        throw new Error('ZIP 条目数据越界: ' + name);
      }
      if (uncompSize > limits.maxEntryBytes) {
        throw new Error('ZIP 条目声明解压后超过安全上限: ' + name);
      }
      if (compSize > dv.byteLength) throw new Error('ZIP 条目压缩大小异常: ' + name);

      entries.push({
        name: name,
        method: method,
        flags: flags,
        crc: crc,
        compSize: compSize,
        uncompSize: uncompSize,
        dataStart: dataStart,
        compData: null,
        raw: null,
        dirty: false
      });

      p = directoryEnd;
    }
    return { entries: entries, buffer: buffer };
  }

  function readZip64Extra(dv, start, len) {
    var out = { uncompSize: 0, compSize: 0, offset: 0 };
    if (start < 0 || len < 0 || start + len > dv.byteLength) throw new Error('ZIP64 扩展字段越界');
    var p = start;
    var end = start + len;
    while (p + 4 <= end) {
      var id = dv.getUint16(p, true);
      var size = dv.getUint16(p + 2, true);
      var body = p + 4;
      if (body + size > end) throw new Error('ZIP64 扩展字段长度异常');
      if (id === 0x0001) {
        var o = 0;
        if (size >= o + 8) { out.uncompSize = readU64(dv, body + o); o += 8; }
        if (size >= o + 8) { out.compSize = readU64(dv, body + o); o += 8; }
        if (size >= o + 8) { out.offset = readU64(dv, body + o); o += 8; }
        break;
      }
      p += 4 + size;
    }
    return out;
  }

  function readU64(dv, pos) {
    if (pos < 0 || pos + 8 > dv.byteLength) throw new Error('ZIP64 数值越界');
    var lo = dv.getUint32(pos, true);
    var hi = dv.getUint32(pos + 4, true);
    return hi * 4294967296 + lo;
  }

  function decodeName(bytes, flags) {
    try {
      // 优先 UTF-8（Office 生成的文件名均为 ASCII，UTF-8 解码安全）
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch (e) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  /* ---------------- ZipArchive ---------------- */

  function ZipArchive(entries, buffer, limits) {
    this._buffer = buffer;
    this._limits = limits || DEFAULT_LIMITS;
    this._budget = { used: 0, limit: this._limits.maxArchiveBytes };
    this._map = {};
    this.entries = [];
    var self = this;
    entries.forEach(function (e) {
      if (!e.name) return;
      if (/\/$/.test(e.name)) return; // 目录条目，导出时按路径自动重建
      var prev = self._map[e.name];
      if (prev) {
        // v4.69：重名条目只保留读者实际取用的最后一份（zip 读取器按中央目录后者优先）。
        // 两份都留在 entries 里时，setText 按名只改到 _map 那份，另一份按原始字节原样导出，
        // 敏感词留在包内，而 getText 与清除后自检都看不到它——假阴性里最难发现的一类。
        var at = self.entries.indexOf(prev);
        if (at >= 0) self.entries.splice(at, 1);
      }
      self._map[e.name] = e;
      self.entries.push(e);
    });
  }

  ZipArchive.prototype.has = function (name) {
    return Object.prototype.hasOwnProperty.call(this._map, name);
  };

  ZipArchive.prototype.names = function () {
    return this.entries.map(function (e) { return e.name; });
  };

  /** 读取条目的原始字节（未解压） */
  ZipArchive.prototype._compDataOf = function (entry) {
    if (entry.compData) return entry.compData;
    if (entry.method === 0) {
      entry.compData = new Uint8Array(this._buffer, entry.dataStart, entry.compSize);
      entry.raw = entry.compData;
    } else if (entry.method === 8) {
      entry.compData = new Uint8Array(this._buffer, entry.dataStart, entry.compSize);
    } else {
      throw new Error('不支持的压缩算法（method=' + entry.method + '）：' + entry.name);
    }
    return entry.compData;
  };

  /** 获取解压后的字节；未修改的条目不会重复解压 */
  ZipArchive.prototype.getBytes = function (name) {
    var e = this._map[name];
    if (!e) return Promise.resolve(null);
    if (e.raw) return Promise.resolve(e.raw);
    if (e.pending) return e.pending;
    // v4.64 getBytes 契约：一律返回 Promise，不同步抛。
    //   _compDataOf 对 method 非 0/8 的条目是同步 throw，而 ooxml.js 有十处
    //   `zip.getBytes(x).then(...)` 且没有 .catch()——其中两处还在 entries.forEach
    //   回调里同步调用，异常会直接穿透 processOffice / scanOffice，
    //   网页端那四处 `.then()` 链接到的是未捕获异常而不是 rejection。
    //   真实 Office 文件只用 deflate/store，但 zip.load 能解析任意 ZIP，
    //   用户拖入「改名成 .docx 的其它压缩算法 zip」就会撞上。
    var comp, self = this;
    try { comp = this._compDataOf(e); } catch (err) { return Promise.reject(err); }
    if (e.method === 0) {
      if (e.compSize > self._limits.maxEntryBytes ||
          self._budget.used + e.compSize > self._budget.limit) {
        return Promise.reject(new Error('ZIP 累计解压数据超过安全上限：' + e.name));
      }
      self._budget.used += e.compSize;
      e.raw = comp;
      return Promise.resolve(e.raw);
    }
    e.pending = inflateRaw(comp, {
      maxBytes: self._limits.maxEntryBytes,
      budget: self._budget
    }).then(function (raw) {
      e.raw = raw;
      e.pending = null;
      return raw;
    }, function (err) {
      e.pending = null;
      throw err;
    });
    return e.pending;
  };

  ZipArchive.prototype.getText = function (name) {
    return this.getBytes(name).then(function (raw) {
      if (!raw) return null;
      return new TextDecoder('utf-8').decode(raw);
    });
  };

  /** 写入文本（标记 dirty，导出时重新压缩） */
  ZipArchive.prototype.setText = function (name, text) {
    var e = this._map[name];
    if (!e) return false;
    e.raw = new TextEncoder().encode(text);
    e.dirty = true;
    e.compData = null;
    return true;
  };

  /** 写入二进制字节（标记 dirty，用于回写递归处理后的内嵌文档） */
  ZipArchive.prototype.setBytes = function (name, u8) {
    var e = this._map[name];
    if (!e) return false;
    e.raw = u8;
    e.dirty = true;
    e.compData = null;
    e.uncompSize = u8.length;
    return true;
  };

  /** 重命名条目（内容字节不变，仅改包内路径名）：
   *  ZIP 的本地文件头 / 中央目录里条目名是明文，保密检查软件解包前就能检索到，
   *  因此条目名脱敏必须连名一起改（引用由调用方同步修正） */
  ZipArchive.prototype.rename = function (name, newName) {
    var e = this._map[name];
    if (!e || !newName || newName === name || this._map[newName]) return false;
    delete this._map[name];
    e.name = newName;
    this._map[newName] = e;
    return true;
  };

  /** 移除条目（整个部件从包内删除，用于缩略图等无法改写的内容） */
  ZipArchive.prototype.remove = function (name) {
    var e = this._map[name];
    if (!e) return false;
    delete this._map[name];
    this.entries = this.entries.filter(function (x) { return x !== e; });
    return true;
  };

  /** 打包为新的 ZIP：未修改条目原样复制，修改条目重新 deflate */
  ZipArchive.prototype.toBlob = function () {
    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var self = this;

    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    var chain = Promise.resolve();
    this.entries.forEach(function (e) {
      chain = chain.then(function () {
        return self._serializeEntry(e, enc, dosTime, dosDate).then(function (out) {
          parts.push(out.local);
          out.dataParts.forEach(function (d) { parts.push(d); });
          central.push(out.central);
          offset += out.local.length + out.compSize;
        });
      });
    });

    return chain.then(function () {
      // 重新生成中央目录（含正确偏移）
      var centralParts = [];
      var cdSize = 0;
      var off = 0;
      for (var i = 0; i < central.length; i++) {
        var c = central[i];
        var rebuild = self._buildCentral(c, off);
        centralParts.push(rebuild);
        cdSize += rebuild.length;
        off += c.localLength + c.compSize;
      }

      var eocd = new Uint8Array(22);
      var dv = new DataView(eocd.buffer);
      dv.setUint32(0, SIG_EOCD, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, central.length, true);
      dv.setUint16(10, central.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, off, true);
      dv.setUint16(20, 0, true);

      return new Blob(parts.concat(centralParts, [eocd]));
    });
  };

  ZipArchive.prototype._serializeEntry = function (e, enc, dosTime, dosDate) {
    var nameBuf = enc.encode(e.name);
    var self = this;
    var method, comp, crc;

    function finish() {
      var local = new Uint8Array(30 + nameBuf.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, SIG_LOCAL, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // UTF-8 文件名
      dv.setUint16(8, method, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, comp.length, true);
      dv.setUint32(22, e.raw ? e.raw.length : e.uncompSize, true);
      dv.setUint16(26, nameBuf.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBuf, 30);

      return {
        local: local,
        dataParts: [comp],
        compSize: comp.length,
        localLength: local.length,
        central: {
          name: nameBuf,
          method: method,
          crc: crc,
          compSize: comp.length,
          uncompSize: e.raw ? e.raw.length : e.uncompSize,
          localLength: local.length
        }
      };
    }

    function finishWith(c) {
      comp = c;
      return finish();
    }

    // 未修改的条目：直接从原 buffer 切片，不解压、不重压、不重算 CRC
    // （修复：原逻辑只在 compData 已填充时才复用原压缩字节，导致所有未被读取过的条目
    //  ——包括全部图片/媒体——在导出时被解压再重压，既浪费 CPU 又可能使输出体积膨胀）
    if (!e.dirty) {
      this._compDataOf(e);
      comp = e.compData;
      method = e.method;
      crc = e.crc;
      return Promise.resolve(finish());
    }

    // 需要（重新）压缩的条目（被改写过）
    return (e.raw ? Promise.resolve(e.raw) : this.getBytes(e.name)).then(function (raw) {
      return deflateRaw(raw).then(function (deflated) {
        if (deflated.length >= raw.length) {
          comp = raw;
          method = 0;
        } else {
          comp = deflated;
          method = 8;
        }
        crc = crc32(raw);
        return finishWith(comp);
      });
    });
  };

  ZipArchive.prototype._buildCentral = function (c, localOffset) {
    var buf = new Uint8Array(46 + c.name.length);
    var dv = new DataView(buf.buffer);
    dv.setUint32(0, SIG_CENTRAL, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, c.method, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.compSize, true);
    dv.setUint32(24, c.uncompSize, true);
    dv.setUint16(28, c.name.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, localOffset, true);
    buf.set(c.name, 46);
    return buf;
  };

  /* ---------------- 打包（导出用） ---------------- */

  /** files: [{ name, data(Uint8Array|string) }] -> Blob */
  function pack(files) {
    var enc = new TextEncoder();
    var parts = [];
    var central = [];
    var offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        var data = (typeof f.data === 'string') ? enc.encode(f.data) : f.data;
        var nameBuf = enc.encode(f.name);
        return deflateRaw(data).then(function (deflated) {
          var comp = deflated, method = 8;
          if (comp.length >= data.length) { comp = data; method = 0; }
          var crc = crc32(data);

          var local = new Uint8Array(30 + nameBuf.length);
          var dv = new DataView(local.buffer);
          dv.setUint32(0, SIG_LOCAL, true);
          dv.setUint16(4, 20, true);
          dv.setUint16(6, 0x0800, true);
          dv.setUint16(8, method, true);
          dv.setUint16(10, dosTime, true);
          dv.setUint16(12, dosDate, true);
          dv.setUint32(14, crc, true);
          dv.setUint32(18, comp.length, true);
          dv.setUint32(22, data.length, true);
          dv.setUint16(26, nameBuf.length, true);
          dv.setUint16(28, 0, true);
          local.set(nameBuf, 30);

          parts.push(local);
          parts.push(comp);
          central.push({
            name: nameBuf, method: method, crc: crc,
            compSize: comp.length, uncompSize: data.length,
            offset: offset, localLength: local.length
          });
          offset += local.length + comp.length;
        });
      });
    });

    return chain.then(function () {
      var cdSize = 0;
      var centralParts = central.map(function (c) {
        var buf = new Uint8Array(46 + c.name.length);
        var dv = new DataView(buf.buffer);
        dv.setUint32(0, SIG_CENTRAL, true);
        dv.setUint16(4, 20, true);
        dv.setUint16(6, 20, true);
        dv.setUint16(8, 0x0800, true);
        dv.setUint16(10, c.method, true);
        dv.setUint16(12, 0, true);
        dv.setUint16(14, 0, true);
        dv.setUint32(16, c.crc, true);
        dv.setUint32(20, c.compSize, true);
        dv.setUint32(24, c.uncompSize, true);
        dv.setUint16(28, c.name.length, true);
        dv.setUint16(30, 0, true);
        dv.setUint16(32, 0, true);
        dv.setUint16(34, 0, true);
        dv.setUint16(36, 0, true);
        dv.setUint32(38, 0, true);
        dv.setUint32(42, c.offset, true);
        buf.set(c.name, 46);
        cdSize += buf.length;
        return buf;
      });

      var eocd = new Uint8Array(22);
      var dv = new DataView(eocd.buffer);
      dv.setUint32(0, SIG_EOCD, true);
      dv.setUint16(4, 0, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, central.length, true);
      dv.setUint16(10, central.length, true);
      dv.setUint32(12, cdSize, true);
      dv.setUint32(16, offset, true);
      dv.setUint16(20, 0, true);

      return new Blob(parts.concat(centralParts, [eocd]), { type: 'application/zip' });
    });
  }

  function load(arrayBuffer, options) {
    if (!isSupported()) {
      return Promise.reject(new Error('当前浏览器不支持原生 ZIP 流，请使用 Chrome / Edge 80 以上版本'));
    }
    var limits = {
      maxEntryBytes: options && options.maxEntryBytes > 0 ? options.maxEntryBytes : DEFAULT_LIMITS.maxEntryBytes,
      maxArchiveBytes: options && options.maxArchiveBytes > 0 ? options.maxArchiveBytes : DEFAULT_LIMITS.maxArchiveBytes,
      maxEntries: options && options.maxEntries > 0 ? options.maxEntries : DEFAULT_LIMITS.maxEntries
    };
    var parsed = parseDirectory(arrayBuffer, limits);
    return Promise.resolve(new ZipArchive(parsed.entries, parsed.buffer, limits));
  }

  global.DWRZip = {
    load: load,
    pack: pack,
    crc32: crc32,
    inflateRaw: inflateRaw,
    deflateRaw: deflateRaw,
    isSupported: isSupported
  };
})(window);
