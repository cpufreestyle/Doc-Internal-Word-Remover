/* ocrsuspect.js —— OCR 结果可信度判定（零依赖，浏览器与命令行共用）
 *
 * 背景：图上的密级标识正文层里根本没有，只能靠 OCR 认。OCR 会认错，
 * 而且错法有规律：中文被识成拉丁字母（「机密」→「ULE」「机客」），
 * 或者整段认不出来。认错的时候如果照常把文件算成「干净」，
 * 外部保密检查软件照样会把它报出来——这是最容易漏的一类。
 *
 * 这里只回答一个问题：**这份 OCR 文本能不能用来断言「图上没有密级标识」**。
 * 不能，就把它交给人工复核（记进未检查清单），而不是静默放过。
 *
 * 判定口径（宁可多提示，不可静默漏）：
 *   1) 一个汉字都没认出来 / 只认出不到 2 个汉字 → 认不动，文本不可用；
 *   2) 中文段落里紧挨着汉字出现连续拉丁字母 → 多半是中文被误识；
 *   3) 整段只有拉丁字符、认不出汉字 → 图可能是外文或识别失败，文本不可用。
 */
(function (global) {
  'use strict';

  var CJK_RE = /[\u4e00-\u9fff]/g;
  var CJK_ONE = /[\u4e00-\u9fff]/;
  var LATIN_RE = /[A-Za-z]{2,}/g;

  /* 中文文档里真正常见的英文缩写：它们出现在汉字旁边是正常的，
     不能因为「汉字旁边有拉丁串」就当成 OCR 认错。
     没进这张表的拉丁串（例如把「机密」认成的 ULE / 机客）才值得怀疑。 */
  var COMMON_ACRONYM = {
    PDF: 1, DOC: 1, DOCX: 1, XLS: 1, XLSX: 1, PPT: 1, PPTX: 1, EXCEL: 1, WORD: 1,
    POWERPOINT: 1, OFFICE: 1, WPS: 1, OA: 1, ERP: 1, IP: 1, PC: 1, USB: 1, ID: 1,
    URL: 1, HTTP: 1, HTTPS: 1, HTML: 1, XML: 1, JSON: 1, API: 1, UI: 1, AI: 1,
    JPG: 1, JPEG: 1, PNG: 1, GIF: 1, TIF: 1, TIFF: 1, QQ: 1, OK: 1, GB: 1, MB: 1,
    KB: 1, ISO: 1, SQL: 1, CAD: 1, CA: 1, VOIP: 1, LAN: 1, WAN: 1, DNS: 1, CPU: 1,
    USB3: 1, SIM: 1, PIN: 1, MAC: 1, APP: 1, GPS: 1, LED: 1, LCD: 1, POS: 1
  };

  /** 文本里有多少个汉字 */
  function cjkCount(text) {
    var m = String(text || '').match(CJK_RE);
    return m ? m.length : 0;
  }

  /** 文本里所有连续拉丁字母串（长度 >= 2） */
  function latinRuns(text) {
    var t = String(text || '');
    var m = t.match(LATIN_RE);
    return m || [];
  }

  /**
   * 拉丁串是否紧挨着汉字——挨着才说明「中文被认成了拉丁」，而不是原文就是英文。
   * 常见缩写（PDF / OA / IP…）不算，它们在中文文档里本来就该出现。
   */
  function latinNearCjk(text) {
    var t = String(text || '');
    var out = [];
    var re = /[A-Za-z]{2,}/g;
    var m;
    while ((m = re.exec(t)) !== null) {
      // 前后隔了空格也算挨着：「内部文件 ULE」里的 ULE 同样是中文被认错
      var before = neighbour(t, m.index - 1, -1);
      var after = neighbour(t, m.index + m[0].length, 1);
      if ((CJK_ONE.test(before) || CJK_ONE.test(after)) && !COMMON_ACRONYM[m[0].toUpperCase()]) {
        out.push(m[0]);
      }
    }
    return out;
  }

  /** 从某个位置往左/右找最近的「实义」字符（跳过空格与常见标点） */
  function neighbour(text, from, step) {
    var t = String(text || '');
    for (var i = from; i >= 0 && i < t.length; i += step) {
      var c = t.charAt(i);
      if (!c) continue;
      if (/[\s ]/.test(c)) continue;
      if (/[，。、；：！？（）()[\]{}<>《》"'`,.!?;:\-—_/\\]/.test(c)) continue;
      return c;
    }
    return '';
  }

  /**
   * 判定一份 OCR 文本能不能用来断言「图上没有密级标识」。
   * @param {string} text OCR 识别出来的文本
   * @returns {{ok:boolean, cjk:number, reasons:Array<{kind:string,detail:string}>}}
   */
  function check(text) {
    var t = String(text || '');
    var reasons = [];
    var cjk = cjkCount(t);

    if (!t.trim()) {
      reasons.push({ kind: 'empty', detail: 'OCR 未识别出任何文字' });
      return { ok: false, cjk: 0, reasons: reasons };
    }

    var near = latinNearCjk(t);
    if (near.length) {
      reasons.push({
        kind: 'latin',
        detail: '中文里出现拉丁串「' + near.join('、') + '」，可能是密级标识被误识',
        runs: near
      });
    } else if (cjk < 2) {
      var runs = latinRuns(t);
      var unknown = runs.filter(function (r) { return !COMMON_ACRONYM[r.toUpperCase()]; });
      if (unknown.join('').length >= 3) {
        reasons.push({
          kind: 'latin-only',
          detail: '只认出拉丁字符「' + unknown.join('、') + '」，没有认出汉字',
          runs: unknown
        });
      } else if (!runs.length) {
        reasons.push({ kind: 'weak', detail: '只认出 ' + cjk + ' 个汉字，识别不可靠' });
      }
    }

    return { ok: reasons.length === 0, cjk: cjk, reasons: reasons };
  }

  global.DWROcrSuspect = {
    check: check,
    cjkCount: cjkCount,
    latinRuns: latinRuns,
    latinNearCjk: latinNearCjk
  };
})(typeof window !== 'undefined' ? window : globalThis);
