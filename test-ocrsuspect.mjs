#!/usr/bin/env node
/**
 * test-ocrsuspect.mjs —— OCR 结果可信度判定回归测试
 *
 * 背景：图上的密级标识正文层里没有，只能靠 OCR 认。OCR 认错时的后果比
 * 「多报一个」严重得多——认错就报 0 命中，文件被当成干净文件，而外部保密
 * 检查软件照样会把它报出来。这里固定住判定口径：
 *
 *   1) 汉字里混进非白名单拉丁串（「内部文件 ULE」里的 ULE）→ 不可靠；
 *   2) 一个汉字都没认出来 / 只认出 1 个 → 不可靠；
 *   3) 中文文档里常见的英文缩写（PDF / OA / IP…）→ 不算不可靠，别误报；
 *   4) 正常中文（含密级词）→ 可靠。
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS [' + name + ']'); }
  else { fail++; console.log('FAIL [' + name + '] ' + String(detail === undefined ? '' : detail)); }
}

/* ---------- 载入被测模块 ---------- */
const src = fs.readFileSync(path.join(__dirname, 'js', 'ocrsuspect.js'), 'utf8');
const ctx = { TextEncoder, TextDecoder, Uint8Array, Array, Object, String, RegExp, Math, JSON, console };
ctx.window = ctx;
ctx.global = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const F = ctx.window.DWROcrSuspect;

check('模块导出 check 函数', !!(F && typeof F.check === 'function'));
if (!F) { console.log('PASS: ' + pass + '  FAIL: ' + fail); process.exit(1); }

/* ---------- 1. 正常中文：可靠 ---------- */
let r = F.check('内部文件 机密');
check('正常中文判为可靠', r.ok === true, JSON.stringify(r.reasons));

r = F.check('绝密 内部 秘密');
check('多个密级词判为可靠', r.ok === true, JSON.stringify(r.reasons));

r = F.check('机密');
check('只有两个字也判为可靠（两个字够用）', r.ok === true, JSON.stringify(r.reasons));

/* ---------- 2. 汉字里混进拉丁串：不可靠 ---------- */
r = F.check('内部文件 ULE');
check('汉字里的拉丁串判为不可靠', r.ok === false && r.reasons.some((x) => x.kind === 'latin'),
  JSON.stringify(r.reasons));

r = F.check('绝密 ULE');
check('密级词旁边的拉丁串也判为不可靠', r.ok === false && r.reasons.some((x) => x.kind === 'latin'),
  JSON.stringify(r.reasons));

/* ---------- 3. 认不出汉字：不可靠 ---------- */
r = F.check('');
check('空文本判为不可靠', r.ok === false && r.reasons.some((x) => x.kind === 'empty'),
  JSON.stringify(r.reasons));

r = F.check('ULE');
check('只认出拉丁串判为不可靠', r.ok === false && r.reasons.some((x) => x.kind === 'latin-only'),
  JSON.stringify(r.reasons));

r = F.check('密');
check('只认出一个汉字判为不可靠', r.ok === false, JSON.stringify(r.reasons));

/* ---------- 4. 常见英文缩写不误报 ---------- */
r = F.check('请用 PDF 格式导出，附件见 OA 系统');
check('常见缩写 PDF / OA 不算不可靠', r.ok === true, JSON.stringify(r.reasons));

r = F.check('扫描件 PDF 与 IP 地址核对');
check('中文里的 PDF / IP 不算不可靠', r.ok === true, JSON.stringify(r.reasons));

/* ---------- 5. 计数与辅助函数 ---------- */
check('汉字计数正确', F.cjkCount('内部abc机密') === 4, String(F.cjkCount('内部abc机密')));
check('拉丁串提取正确', JSON.stringify(F.latinRuns('内部 PDF 机密 ULE')) === JSON.stringify(['PDF', 'ULE']),
  JSON.stringify(F.latinRuns('内部 PDF 机密 ULE')));
check('贴着汉字的拉丁串能找出来（缩写除外）',
  JSON.stringify(F.latinNearCjk('内部 PDF 机密 ULE')) === JSON.stringify(['ULE']),
  JSON.stringify(F.latinNearCjk('内部 PDF 机密 ULE')));

console.log('');
console.log('PASS: ' + pass + '  FAIL: ' + fail);
if (fail) process.exit(1);
