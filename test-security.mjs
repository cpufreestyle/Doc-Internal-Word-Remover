#!/usr/bin/env node
/**
 * Security regression tests for report path authorization, ZIP/OOXML budgets,
 * loopback-only startup, and public-tree hygiene.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('PASS [' + name + ']');
  } else {
    failed++;
    console.log('FAIL [' + name + '] ' + String(detail || ''));
  }
}

function loadEngine() {
  const files = ['js/zip.js', 'js/rules.js', 'js/ooxml.js'];
  const code = files.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  const ctx = {
    TextEncoder, TextDecoder,
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    Blob: globalThis.Blob, Response: globalThis.Response,
    Uint8Array, DataView, Array, Object, String, RegExp, Math, JSON, Promise, console
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

function findSig(bytes, signature) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (dv.getUint32(i, true) === signature) return i;
  }
  return -1;
}

async function makeZip(D, text) {
  const blob = await D.DWRZip.pack([{ name: 'word/document.xml', data: text }]);
  return new Uint8Array(await blob.arrayBuffer());
}

async function makeNestedOffice(D, levels) {
  let bytes = await makeZip(D, '<w:document><w:body><w:p><w:t>sample</w:t></w:p></w:body></w:document>');
  for (let i = 0; i < levels; i++) {
    const blob = await D.DWRZip.pack([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body/></w:document>' },
      { name: 'word/embeddings/nested' + i + '.docx', data: bytes }
    ]);
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  return bytes;
}

const D = loadEngine();
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dwr-security-'));
const scan = path.join(__dirname, 'scan.mjs');
const run = (args) => spawnSync(process.execPath, [scan, ...args], {
  cwd: __dirname,
  encoding: 'utf8'
});

try {
  const bomb = await makeZip(D, 'A'.repeat(128 * 1024));
  const bombBuf = bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.byteLength);
  const central = findSig(bomb, 0x02014b50);
  const local = findSig(bomb, 0x04034b50);
  const dv = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  dv.setUint32(central + 24, 100, true);
  dv.setUint32(local + 22, 100, true);
  let bombRejected = false;
  try {
    const zip = await D.DWRZip.load(bombBuf, { maxEntryBytes: 1024, maxArchiveBytes: 4096 });
    await zip.getBytes('word/document.xml');
  } catch (e) {
    bombRejected = /安全上限/.test(String(e && e.message));
  }
  check('zip-streaming-budget', bombRejected);

  const malformed = await makeZip(D, '<w:document/>');
  const malformedBuf = malformed.buffer.slice(malformed.byteOffset, malformed.byteOffset + malformed.byteLength);
  const malformedCentral = findSig(malformed, 0x02014b50);
  new DataView(malformedBuf).setUint32(malformedCentral + 42, malformed.length + 4096, true);
  let boundsRejected = false;
  try {
    await D.DWRZip.load(malformedBuf);
  } catch (e) {
    boundsRejected = /越界/.test(String(e && e.message));
  }
  check('zip-offset-bounds', boundsRejected);

  const nested = await makeNestedOffice(D, 4);
  const engine = D.DWRRules.createEngine({ rules: [{ text: '内部', type: 'text', enabled: true }], scope: 'all' });
  let depthRejected = false;
  try {
    await D.DWRDoc.scanOffice(
      nested.buffer.slice(nested.byteOffset, nested.byteOffset + nested.byteLength),
      engine
    );
  } catch (e) {
    depthRejected = /递归超过安全深度/.test(String(e && e.message));
  }
  check('ooxml-embed-depth-budget', depthRejected);

  const allowed = path.join(base, 'allowed');
  const sibling = path.join(base, 'allowed-other');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(sibling);
  fs.mkdirSync(outside);
  const insideFile = path.join(allowed, 'inside.txt');
  const outsideFile = path.join(outside, 'outside.txt');
  const siblingFile = path.join(sibling, 'sibling.txt');
  fs.writeFileSync(insideFile, '内部资料\n正文\n', 'utf8');
  fs.writeFileSync(outsideFile, '内部资料\n正文\n', 'utf8');
  fs.writeFileSync(siblingFile, '内部资料\n正文\n', 'utf8');

  const reportOf = (name, files) => {
    const p = path.join(base, name);
    fs.writeFileSync(p, JSON.stringify(files.map((file) => ({ file, hits: 1, matched: ['内部'] }))), 'utf8');
    return p;
  };

  const outsideReport = reportOf('outside.json', [outsideFile]);
  const outsideRun = run([
    '--from-report', outsideReport, '--authorized-root', allowed,
    '--out', path.join(base, 'out-outside')
  ]);
  check('report-rejects-outside-root',
    outsideRun.status !== 0 && /不在授权根内/.test(outsideRun.stderr));

  const siblingReport = reportOf('sibling.json', [siblingFile]);
  const siblingRun = run([
    '--from-report', siblingReport, '--authorized-root', allowed,
    '--out', path.join(base, 'out-sibling')
  ]);
  check('report-rejects-prefix-collision',
    siblingRun.status !== 0 && /不在授权根内/.test(siblingRun.stderr));

  const missingRoot = run([
    '--from-report', reportOf('inside.json', [insideFile]),
    '--out', path.join(base, 'out-missing-root')
  ]);
  check('report-requires-explicit-root',
    missingRoot.status !== 0 && /--authorized-root/.test(missingRoot.stderr));

  const goodOut = path.join(base, 'out-good');
  const goodRun = run([
    '--from-report', reportOf('inside-good.json', [insideFile]),
    '--authorized-root', allowed, '--out', goodOut
  ]);
  check('report-allows-authorized-root',
    goodRun.status === 0 && fs.existsSync(path.join(goodOut, 'inside.txt')));

  const deleteFile = path.join(allowed, 'delete-me.txt');
  fs.writeFileSync(deleteFile, '内部资料\n正文\n', 'utf8');
  const deleteReport = reportOf('delete.json', [deleteFile]);
  const dryRun = run([
    '--from-report', deleteReport, '--authorized-root', allowed, '--delete'
  ]);
  check('report-delete-defaults-to-dry-run',
    dryRun.status === 0 && fs.existsSync(deleteFile) && /\[安全模式\]/.test(dryRun.stdout));
  const confirmed = run([
    '--from-report', deleteReport, '--authorized-root', allowed, '--delete', '--confirm-delete'
  ]);
  check('report-delete-requires-confirmation',
    confirmed.status === 0 && !fs.existsSync(deleteFile));

  const unc = '\\\\server\\share\\sample.txt';
  const uncReport = reportOf('unc.json', [unc]);
  const uncRun = run([
    '--from-report', uncReport, '--authorized-root', allowed, '--delete-dry-run'
  ]);
  check('report-rejects-unc-by-default',
    uncRun.status !== 0 && /网络路径/.test(uncRun.stderr));

  try {
    const link = path.join(allowed, 'escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedFile = path.join(link, 'outside.txt');
    const linkedReport = reportOf('linked.json', [linkedFile]);
    const linkedRun = run([
      '--from-report', linkedReport, '--authorized-root', allowed,
      '--out', path.join(base, 'out-linked')
    ]);
    check('report-rejects-symlink-escape',
      linkedRun.status !== 0 && /不在授权根内/.test(linkedRun.stderr));
  } catch (e) {
    console.log('SKIP [report-rejects-symlink-escape] ' + String(e && e.message));
  }

  const bat = fs.readFileSync(path.join(__dirname, 'Start.bat'), 'utf8');
  const sh = fs.readFileSync(path.join(__dirname, 'Start.sh'), 'utf8');
  check('startup-loopback-bind',
    /--bind 127\.0\.0\.1/.test(bat) && /tcp:\/\/127\.0\.0\.1/.test(bat) &&
    /--bind 127\.0\.0\.1/.test(sh) && /tcp:\/\/127\.0\.0\.1/.test(sh));
  check('startup-no-python2-fallback',
    !/SimpleHTTPServer/.test(sh) && !/start "" python -m http\.server/.test(bat));
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* test cleanup */ }
}

console.log('\n==== security summary ====');
console.log('PASS: ' + passed + '  FAIL: ' + failed);
if (failed) process.exit(1);
