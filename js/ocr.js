/* OCR 图片文字检查
 *
 * 对齐外部保密检查系统的「图片文字检查」：文档里插的截图、扫描件 PDF 里的整页图，
 * 正文层根本没有文字，密级标识却写在图上——按正文口径这是干净文件，
 * 检查软件照样会把它报出来。这里用 tesseract.js 在本地跑 OCR，
 * 把识别出来的文字再送进同一套词库、同一套命中口径。
 *
 * 识别模型随工具一起分发（assets/ocr，约 12MB），全程不出本机、不联网。
 */
(function (global) {
  'use strict';

  var MAX_IMAGE_BYTES = 12 * 1024 * 1024;  // 单张图超过 12MB 不做 OCR
  var DEFAULT_TIMEOUT = 30000;              // 单张图 30 秒兜底
  var MAX_PIXELS = 12 * 1000 * 1000;        // 超过 1200 万像素先缩再识别

  var cfg = {
    base: 'assets/ocr/',
    langs: 'chi_sim+eng',
    worker: null,
    workerPromise: null,
    queue: Promise.resolve(),
    lastError: '',
    onProgress: null
  };

  /** WASM SIMD 支持检测：老浏览器没有 SIMD 时换用不带 SIMD 的核心 */
  function simdSupported() {
    try {
      return typeof WebAssembly !== 'undefined' && !!WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) {
      return false;
    }
  }

  function coreFile() {
    return simdSupported()
      ? 'core/tesseract-core-simd-lstm.wasm.js'
      : 'core/tesseract-core-lstm.wasm.js';
  }

  function isBrowser() {
    return typeof document !== 'undefined' && typeof document.createElement === 'function';
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('无法加载 OCR 组件：' + src)); };
      document.head.appendChild(el);
    });
  }

  /** 浏览器端：加载随包分发的 tesseract.js，建立可复用的 worker */
  function browserWorker() {
    var lib = global.Tesseract
      ? Promise.resolve(global.Tesseract)
      : loadScript(cfg.base + 'tesseract.min.js').then(function () {
          if (!global.Tesseract) throw new Error('OCR 组件加载失败：未取得 Tesseract');
          return global.Tesseract;
        });
    return lib.then(function (T) {
      return T.createWorker(cfg.langs, 1, {   // 1 = LSTM_ONLY
        workerPath: cfg.base + 'worker.min.js',
        corePath: cfg.base + coreFile(),
        langPath: cfg.base + 'lang/',
        gzip: true,
        logger: function (m) {
          if (cfg.onProgress) { try { cfg.onProgress(m); } catch (e) { /* 进度回调不影响识别 */ } }
        },
        errorHandler: function (e) {
          cfg.lastError = String((e && e.message) || e);
        }
      });
    });
  }

  function ensureWorker() {
    if (cfg.worker) return Promise.resolve(cfg.worker);
    if (cfg.workerPromise) return cfg.workerPromise;
    var p;
    if (global.__DWR_OCR_IMPL) {
      // 命令行端注入的实现（scan.mjs 用 Node 版 tesseract.js）
      p = Promise.resolve(global.__DWR_OCR_IMPL(cfg));
    } else if (isBrowser()) {
      p = browserWorker();
    } else {
      p = Promise.reject(new Error('当前环境没有可用的 OCR 引擎'));
    }
    cfg.workerPromise = p.then(function (w) {
      cfg.worker = w;
      return w;
    }, function (e) {
      cfg.workerPromise = null;
      cfg.lastError = String((e && e.message) || e);
      throw e;
    });
    return cfg.workerPromise;
  }

  /** 灰度/RGB 原始采样 → 画布（浏览器） */
  function rasterize(source) {
    var w = source.width | 0, h = source.height | 0;
    if (!w || !h || !source.samples || !source.samples.length) return Promise.resolve(null);
    var ch = source.channels || 1;
    var data = new Uint8ClampedArray(w * h * 4);
    var s = source.samples;
    for (var i = 0, p = 0; i < w * h; i++, p += ch) {
      var r, g, b;
      if (ch >= 3) { r = s[p]; g = s[p + 1]; b = s[p + 2]; }
      else { r = g = b = s[p]; }
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
    }
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var ctx = out.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    ctx.putImageData(new ImageData(data, w, h), 0, 0);
    return Promise.resolve(out);
  }

  /** 图片字节 → 画布（统一转成 PNG，PDF 里的 JBIG2 / 图像掩模等格式浏览器解不了就跳过） */
  function decodeToCanvas(source) {
    if (!isBrowser()) return Promise.resolve(null);
    if (source.canvas) return Promise.resolve(source.canvas);
    if (source.samples) return rasterize(source);
    if (!source.bytes || !source.bytes.length) return Promise.resolve(null);
    var mime = source.mime || 'image/png';
    var blob;
    try {
      blob = new Blob([source.bytes], { type: mime });
    } catch (e) {
      return Promise.resolve(null);
    }
    if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return createImageBitmap(blob).then(function (bmp) {
      var scale = 1;
      var px = bmp.width * bmp.height;
      if (px > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / px);
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0, w, h);
      if (typeof bmp.close === 'function') bmp.close();
      return cv;
    }, function () {
      return null;   // 浏览器解不了的格式（tiff / 特殊编码）直接跳过
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('OCR 超时'));
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }, function (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * 识别一张图。
   * @param {{bytes?:Uint8Array, mime?:string, samples?:Uint8Array, width?:number, height?:number, channels?:number}} source
   * @param {{timeout?:number, maxBytes?:number}} [opts]
   * @returns {Promise<{text:string, confidence:number, ms:number, error?:string, skipped?:string}>}
   */
  function recognize(source, opts) {
    opts = opts || {};
    var started = Date.now();
    if (!source) return Promise.resolve({ text: '', confidence: 0, ms: 0 });
    var size = source.bytes ? source.bytes.length : (source.samples ? source.samples.length : 0);
    if (!size) return Promise.resolve({ text: '', confidence: 0, ms: 0, skipped: '空图片' });
    if (size > (opts.maxBytes || MAX_IMAGE_BYTES)) {
      return Promise.resolve({ text: '', confidence: 0, ms: 0, skipped: '图片过大' });
    }
    // 同一个 worker 不能并发识别，扫描又是多线程并行的——这里排成一条队
    var task = cfg.queue.then(function () { return runRecognize(source, opts, started); });
    cfg.queue = task.then(function () { }, function () { });
    return task;
  }

  function runRecognize(source, opts, started) {
    return ensureWorker().then(function (worker) {
      return decodeToCanvas(source).then(function (canvas) {
        var image = canvas || source.bytes;
        if (!image) throw new Error('图片无法解码');
        return withTimeout(
          worker.recognize(image, { text: true }, { text: true, blocks: false }),
          opts.timeout || DEFAULT_TIMEOUT
        );
      });
    }).then(function (r) {
      var data = (r && r.data) || {};
      return {
        text: String(data.text || ''),
        confidence: data.confidence || 0,
        ms: Date.now() - started
      };
    }, function (e) {
      cfg.lastError = String((e && e.message) || e);
      return { text: '', confidence: 0, ms: Date.now() - started, error: cfg.lastError };
    });
  }

  function terminate() {
    var w = cfg.worker;
    cfg.worker = null;
    cfg.workerPromise = null;
    cfg.queue = Promise.resolve();
    if (w && typeof w.terminate === 'function') {
      try { w.terminate(); } catch (e) { /* 忽略 */ }
    }
  }

  global.DWROcr = {
    configure: function (opts) {
      opts = opts || {};
      if (opts.base) cfg.base = opts.base;
      if (opts.langs) cfg.langs = opts.langs;
      if ('onProgress' in opts) cfg.onProgress = opts.onProgress;
      return cfg;
    },
    status: function () {
      return {
        available: !!(global.__DWR_OCR_IMPL || isBrowser()),
        ready: !!cfg.worker,
        langs: cfg.langs,
        core: coreFile(),
        lastError: cfg.lastError
      };
    },
    warmup: function () {
      return ensureWorker().then(function () { return true; });
    },
    recognize: recognize,
    terminate: terminate,
    /** 供测试与命令行复用：当前是否走浏览器端实现 */
    isBrowser: isBrowser
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
