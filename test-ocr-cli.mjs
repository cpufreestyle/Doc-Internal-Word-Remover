#!/usr/bin/env node
/**
 * test-ocr-cli.mjs —— 命令行 `--ocr` 参数的端到端回归测试
 *
 * 覆盖此前完全缺失的一段：scan.mjs 的 `--ocr` 只有「README 里提过这个词」
 * 这类间接断言，参数解析本身、开关语义、依赖缺失时的降级行为都没有测过。
 * 一旦有人把 `else if (a === '--ocr')` 那行改坏，测试照样全绿——这正是
 * 「命令行的 OCR 开关形同虚设」这类问题能溜过 CI 的原因。
 *
 * 本测试以子进程方式跑真实的 scan.mjs（它没有导出，无法 import），
 * 断言三件事：
 *   ① `--ocr` 能被正确解析并真正启用（日志里出现「已启用图片文字检查」）；
 *   ② 不传 `--ocr` 时 OCR 不启用（默认关闭，不能偷偷打开）；
 *   ③ 缺依赖时降级是「提示 + 继续跑」，不是整轮崩掉。
 *
 * 与 test-revision-ocr.mjs 里的 cli-ocr 用例的区别：那几条是对 scan.mjs
 * 源码做正则静态断言（看代码里有没有某几行），这里是**真跑一遍子进程**
 * 看实际行为——静态断言挡不住「代码在、但开关没接到实际流程上」这类问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('PASS [' + name + ']');
  } else {
    failed++;
    console.log('FAIL [' + name + '] ' + String(detail === undefined ? '' : detail));
  }
}

/* ---------- 造一个最小可扫目录 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-ocr-cli-'));
fs.writeFileSync(path.join(tmp, '普通材料.txt'), '这是一份普通材料\n第二行普通内容\n', 'utf8');

function runCli(args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'scan.mjs')].concat(args), {
    // 在临时目录里跑：scan.mjs 会把 scan-report.csv / .json / .html 写进当前工作目录，
    // 直接用仓库根目录当 cwd 会在工作区里留下垃圾文件。
    cwd: tmp,
    encoding: 'utf8',
    timeout: 120000,
  });
  return {
    code: r.status,
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
    all: String(r.stdout || '') + String(r.stderr || ''),
  };
}

/* ---------- ① 参数解析：--ocr 能被识别且真的启用 ---------- */
{
  const r = runCli(['--dir', tmp, '--scope', 'all', '--words', '内部', '--ocr']);
  // 依赖齐全时应出现「已启用图片文字检查（本地识别，不联网）」
  const enabled = /已启用图片文字检查/.test(r.all);
  if (enabled) {
    check('cli-ocr-参数解析：--ocr 真正启用 OCR', true);
  } else {
    // 依赖缺失时走降级分支：必须是「提示」而不是崩溃
    const degraded = /需要本机已安装 tesseract\.js/.test(r.all);
    check('cli-ocr-参数解析：--ocr 真正启用 OCR', degraded,
      '既没启用也没降级提示。stdout=' + r.out.slice(0, 300) + ' stderr=' + r.err.slice(0, 300));
    check('cli-ocr-依赖缺失时降级为提示而非崩溃', degraded && r.code !== 1,
      'code=' + r.code + ' stderr=' + r.err.slice(0, 300));
    check('cli-ocr-降级时仍提示需人工复核', /仍需人工复核/.test(r.all),
      r.all.slice(0, 300));
  }
  check('cli-ocr-扫描流程在 OCR 分支下正常收尾', r.code === 0 || r.code === 2,
    'exit=' + r.code + ' stderr=' + r.err.slice(0, 300));
}

/* ---------- ② 默认关闭：不传 --ocr 时不得启用 OCR ---------- */
{
  const r = runCli(['--dir', tmp, '--scope', 'all', '--words', '内部']);
  check('cli-ocr-默认不启用 OCR（不传 --ocr）', !/已启用图片文字检查/.test(r.all),
    '不该出现启用日志：' + r.all.slice(0, 300));
  check('cli-ocr-默认路径不输出 OCR 依赖缺失提示',
    !/需要本机已安装 tesseract\.js/.test(r.all),
    '未启用 OCR 时不该要求装 tesseract.js：' + r.all.slice(0, 300));
}

/* ---------- ③ 参数解析的静态契约：开关确实存在于 parseArgs ---------- */
{
  const src = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  check('cli-ocr-parseArgs 里有 --ocr 分支', /else if \(a === '--ocr'\) o\.ocr = true;/.test(src),
    'scan.mjs 里找不到 --ocr 的解析分支');
  check('cli-ocr-ocr 默认值为 false', /ocr:\s*false/.test(src),
    'parseArgs 的默认值里没有 ocr: false');
  // o.ocr 必须真的被消费，否则又是一个「解析了但没用」的假开关
  check('cli-ocr-o.ocr 被真正消费（不只是解析）', /if \(o\.ocr\)/.test(src),
    'scan.mjs 里找不到 if (o.ocr)');
}

/* ---------- ④ README 与 --help 文本都交代了 --ocr ---------- */
{
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  check('cli-ocr-README 交代了 --ocr', readme.indexOf('--ocr') >= 0,
    'README.md 里没找到 --ocr');
  const src = fs.readFileSync(path.join(__dirname, 'scan.mjs'), 'utf8');
  check('cli-ocr-用法注释交代了 --ocr', /--ocr\s+对文档插图/.test(src),
    'scan.mjs 头部用法注释没提到 --ocr');
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) { /* 清理失败不影响结论 */ }

console.log('');
console.log(failed === 0 ? '==== 全部通过 ====' : '==== 存在失败 ====');
console.log('PASS: ' + passed + '  FAIL: ' + failed);
if (failed) process.exit(1);
