(/**
 * dircache.js —— 目录授权记忆（IndexedDB，跨会话复用）
 * 被 app.js 通过 window.DWRDirCache 引用
 */
(function (root) {
  'use strict';

  /* ---------------- 目录授权记忆（IndexedDB，跨会话复用） ----------------
     扫描文件夹 / 导入报告的盘符根目录 / 输出目录都不必每次重新选；
     句柄直接存 IndexedDB（FileSystemHandle 可结构化克隆），权限失效时自动退回选择框。
     从 app.js 抽出：纯 IndexedDB 存取，不依赖 DOM 与应用状态。 */

  var DIR_DB_NAME = 'dwr-dir-cache';
  var DIR_DB_STORE = 'dirs';

  function dirCacheAvailable() {
    try {
      return typeof root.indexedDB !== 'undefined' && !!root.indexedDB
        && typeof root.indexedDB.open === 'function';
    } catch (e) { return false; }
  }

  /**
   * 单事务跑一次目录缓存操作：开库 → 开事务 → 交给 fn → 等回调。
   * 开库 / 事务都可能卡住（别的标签页占着库、权限弹窗没关），统一 4 秒兜底并当失败。
   * @param {function(Database, function(*))} fn 收到库对象与 finish 回调
   * @param {*} giveUp 超时 / 异常时返回什么（读是 null，写是 false）
   */
  function idbRun(fn, giveUp) {
    return new Promise(function (resolve) {
      if (!dirCacheAvailable()) return resolve(giveUp);
      var done = false, timer = null;
      var finish = function (v) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      timer = setTimeout(function () { finish(giveUp); }, 4000);
      var req;
      try { req = root.indexedDB.open(DIR_DB_NAME, 1); } catch (e) { return finish(giveUp); }
      req.onerror = function () { finish(giveUp); };
      req.onblocked = function () { finish(giveUp); };
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore(DIR_DB_STORE); } catch (e) {}
      };
      req.onsuccess = function () {
        try { fn(req.result, finish); } catch (e) { finish(giveUp); }
      };
    });
  }

  /** IndexedDB 里取一个记住的目录句柄；任何一步失败都当没有（降级为弹选择框） */
  function dirCacheGet(key) {
    return idbRun(function (db, finish) {
      var g = db.transaction(DIR_DB_STORE, 'readonly').objectStore(DIR_DB_STORE).get(key);
      g.onsuccess = function () { finish(g.result || null); };
      g.onerror = function () { finish(null); };
    }, null);
  }

  function dirCachePut(key, handle) {
    if (!handle) return Promise.resolve(false);
    return idbRun(function (db, finish) {
      var tx = db.transaction(DIR_DB_STORE, 'readwrite');
      tx.objectStore(DIR_DB_STORE).put(handle, key);
      tx.oncomplete = function () { finish(true); };
      tx.onerror = function () { finish(false); };
      tx.onabort = function () { finish(false); };
    }, false);
  }

  function dirCacheDel(key) {
    return idbRun(function (db, finish) {
      var tx = db.transaction(DIR_DB_STORE, 'readwrite');
      tx.objectStore(DIR_DB_STORE).delete(key);
      tx.oncomplete = function () { finish(true); };
      tx.onerror = function () { finish(false); };
      tx.onabort = function () { finish(false); };
    }, false);
  }

  /** 清空全部记住的目录（换机器 / 换盘后句柄失效时用） */
  function dirCacheClear() {
    return idbRun(function (db, finish) {
      var tx = db.transaction(DIR_DB_STORE, 'readwrite');
      tx.objectStore(DIR_DB_STORE).clear();
      tx.oncomplete = function () { finish(true); };
      tx.onerror = function () { finish(false); };
      tx.onabort = function () { finish(false); };
    }, false);
  }

  root.DWRDirCache = {
    get: dirCacheGet,
    put: dirCachePut,
    del: dirCacheDel,
    clear: dirCacheClear
  };
}))(typeof window !== 'undefined' ? window : this);
