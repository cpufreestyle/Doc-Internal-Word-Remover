#!/usr/bin/env node
/**
 * tools/run-e2e.mjs —— 浏览器端冒烟测试的统一入口
 *
 * 为什么单独一个入口：
 *   ① 自带静态服务器，不依赖 python / python3（Windows、CI、UOS 上都跑得起来）；
 *   ② playwright 的版本写在这里，CI 与发版流程共用同一份，不会各写各的；
 *   ③ 需要时自动安装 playwright，不必在 YAML 里重复「装依赖 → 起服务 → 跑测试」三段。
 *
 * 用法：
 *   node tools/run-e2e.mjs            # 缺 playwright 时自动装
 *   node tools/run-e2e.mjs --keep     # 结束后保留服务器（调试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* playwright 版本唯一事实源：package.json 的 devDependencies。
   CI 与发版流程都从这里取（--print-version），不会各写一份、各漂移。 */
const PLAYWRIGHT_VERSION = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const v = pkg.devDependencies && pkg.devDependencies.playwright;
  if (!v) {
    console.error('[E2E] package.json 的 devDependencies 里没有 playwright');
    process.exit(1);
  }
  // 只保留版本号本身（去掉 ^ / ~ 前缀）
  return String(v).replace(/^[\^~>=<\s]+/, '');
})();

/* Windows 上 npm / npx 是 .cmd 批处理，spawnSync 不带 shell 时必须显式指向它 */
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** 极简静态服务器：只服务仓库根目录下的文件 */
function startServer(port) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.join(ROOT, rel);
    // 防目录穿越
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel);
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** playwright 没装就装一份（版本以本文件为准） */
function ensurePlaywright() {
  const probe = spawnSync(process.execPath, ['-e',
    "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))"],
  { cwd: ROOT, encoding: 'utf8' });
  if (probe.status === 0) return;
  console.log('[E2E] 安装 playwright@' + PLAYWRIGHT_VERSION + ' …');
  const r = spawnSync(NPM, [
    'install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
    'playwright@' + PLAYWRIGHT_VERSION,
  ], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) {
    console.error('[E2E] playwright 安装失败');
    process.exit(1);
  }
}

function ensureChromium() {
  const r = spawnSync(NPX, ['playwright', 'install', 'chromium'],
    { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', shell: IS_WIN });
  if (r.status !== 0) {
    console.error('[E2E] chromium 安装失败');
    process.exit(1);
  }
}

const keep = process.argv.includes('--keep');
const port = Number(process.env.E2E_PORT || 8080);

/* 让工作流从本文件取版本，避免两处各写一份、各漂移：
   PW_VER=$(node tools/run-e2e.mjs --print-version) */
if (process.argv.includes('--print-version')) {
  process.stdout.write(PLAYWRIGHT_VERSION + '\n');
  process.exit(0);
}

ensurePlaywright();
ensureChromium();

const server = await startServer(port);
const base = `http://127.0.0.1:${port}/index.html`;
console.log('[E2E] 静态服务已启动：' + base);

/* 必须用异步 spawn：spawnSync 会把本进程的事件循环卡住，
   同进程里的静态服务器就完全没法响应请求，浏览器只会等到超时。 */
const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'test-e2e.mjs')], {
    cwd: ROOT,
    env: { ...process.env, BASE_URL: base },
    stdio: 'inherit',
  });
  child.on('exit', (c) => resolve(c === null ? 1 : c));
  child.on('error', () => resolve(1));
});

if (!keep) server.close();
console.log('E2E exit=' + code);
process.exit(code === 0 ? 0 : 1);
