// worker.js —— 在后台线程执行文档脱敏，避免大文件处理阻塞主线程 UI
// 注意：worker 文件位于 js/ 目录，importScripts 使用同目录相对路径。
self.window = self; // 让引擎的 IIFE（以 window 为全局）在 Worker 中可用
importScripts('zip.js', 'rules.js', 'ooxml.js');

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== 'process') return;
  try {
    var Doc = self.DWRDoc;
    var Rules = self.DWRRules;
    var engine = Rules.createEngine(msg.config);
    var name = msg.name;
    var buf = msg.buf;

    if (Doc.isTextFile(name)) {
      var dec = Doc.decodeText(new Uint8Array(buf));
      var r = Doc.processText(dec.text, engine, dec.encoding);
      var bytes = r.touched ? Doc.encodeText(r.text, dec.bom, dec.encoding).buffer : null;
      self.postMessage(
        { type: 'result', id: msg.id, changed: r.touched, bytes: bytes, hits: r.hits, matched: r.matched },
        bytes ? [bytes] : []
      );
      return;
    }

    if (Doc.isOfficeFile(name)) {
      Doc.processOffice(buf, engine, function (d, t) {
        self.postMessage({ type: 'progress', id: msg.id, done: d, total: t });
      }).then(function (res) {
        if (!res.touched) {
          self.postMessage({ type: 'result', id: msg.id, changed: false, bytes: null, hits: 0, matched: [], vba: res.vba, thumb: res.thumb, renamed: res.renamed || [], removed: res.removed || [] });
          return;
        }
        res.blob.arrayBuffer().then(function (ab) {
          self.postMessage(
            { type: 'result', id: msg.id, changed: true, bytes: ab, hits: res.hits, matched: res.matched, vba: res.vba, thumb: res.thumb, renamed: res.renamed || [], removed: res.removed || [] },
            [ab]
          );
        }).catch(function (e) {
          self.postMessage({ type: 'error', id: msg.id, error: String(e && e.message || e) });
        });
      }).catch(function (e) {
        self.postMessage({ type: 'error', id: msg.id, error: String(e && e.message || e) });
      });
      return;
    }

    self.postMessage({ type: 'result', id: msg.id, changed: false, bytes: null, hits: 0, matched: [] });
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, error: String(e && e.message || e) });
  }
};
