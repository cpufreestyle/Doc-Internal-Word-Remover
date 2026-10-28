/*
 * v3.4 一键撤销：in-place 写回前记录批次，撤销时把 .bak 内容写回原路径。
 * 只存路径与时间，不存文件内容；批次上限 5 批，超出丢弃最旧的。
 */
(function (global) {
  'use strict';

  var KEY = 'dwr.undo.v1';
  var MAX_BATCH = 5;

  function read() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function write(arr) {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(arr.slice(-MAX_BATCH)));
      return true;
    } catch (e) { return false; }
  }

  /** 记录一批 in-place 写回；entries: [{path,size,bak}]。bak 是本次实际写入的备份名 */
  function record(entries) {
    if (!entries || !entries.length) return;
    var arr = read();
    arr.push({
      at: Date.now(),
      count: entries.length,
      items: entries.map(function (e) { return { path: e.path, size: e.size, bak: e.bak }; })
    });
    write(arr);
  }

  /** 最近一批；null 表示没有可撤销的 */
  function latest() {
    var arr = read();
    return arr.length ? arr[arr.length - 1] : null;
  }

  function dropLatest() {
    var arr = read();
    if (!arr.length) return null;
    var b = arr.pop();
    write(arr);
    return b;
  }

  function count() { return read().length; }

  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      // Invalid Date 不抛错，只会让每个取值都变成 NaN——必须显式拦，
      // 否则 UI 上会渲染出 "NaN-NaN-NaN NaN:NaN"（v4.32 实测）
      if (isNaN(d.getTime())) return '';
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  global.DWRUndo = {
    key: KEY,
    max: MAX_BATCH,
    record: record,
    latest: latest,
    dropLatest: dropLatest,
    count: count,
    fmtTime: fmtTime
  };
})(typeof window !== 'undefined' ? window : globalThis);
