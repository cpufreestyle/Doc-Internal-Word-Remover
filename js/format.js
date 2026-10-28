/* v2.87: 从 app.js 抽出的无依赖格式化函数。
   app.js 单文件 3600+ 行，这些纯函数不碰 DOM、不依赖模块状态，
   抽到这里便于单独测试与复用；挂在 window.DWRFormat 上与引擎风格一致。 */
(function (root) {
  'use strict';

  /* 转义 HTML 五个字符（表格 / 徽章 / tooltip 渲染共用） */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 文件大小：B / KB / MB 三档 */
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* 日志时间戳 HH:MM:SS */
  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  root.DWRFormat = { escapeHtml: escapeHtml, fmtSize: fmtSize, stamp: stamp };
})(typeof window !== 'undefined' ? window : globalThis);
