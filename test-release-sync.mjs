import assert from 'node:assert/strict';
import http from 'node:http';
import {
  compareReleaseTags, synchronize, uploadTimeoutMs, buildMultipartBody, fetchTransport, httpsPostBuffer,
} from './tools/release-sync.mjs';

function release(tag, body = 'michaelqiu 出品') {
  const assetName = `Doc-Internal-Word-Remover-${tag}.zip`;
  return {
    id: tag.charCodeAt(1),
    tag_name: tag,
    name: tag,
    body,
    target_commitish: 'main',
    prerelease: false,
    assets: [{
      // Gitee 侧替换附件要靠这个 id（真实 API 会返回）
      id: 1000 + tag.charCodeAt(1),
      name: assetName,
      browser_download_url: `https://assets.test/${tag}.zip`,
    }],
  };
}

function mockFetch({ github, gitee, githubAsset = 'same', giteeAsset = 'same', attachFailures = 0 }) {
  const calls = [];
  let attachAttempts = 0;
  return {
    calls,
    fetch: async (url, options = {}) => {
      const value = String(url);
      const method = (options.method || 'GET').toUpperCase();
      calls.push({ url: value, method });
      if (value === 'https://gitee.com/api/v5/repos/o/r/releases' && method === 'POST') {
        return Response.json({ ...release('v1.0.0'), id: 99, assets: [] }, { status: 201 });
      }
      if (value.includes('/releases/') && method === 'PATCH') {
        // 保留原有附件列表：更新正文不应影响附件
        const existing = release('v1.0.0', 'github body');
        existing.id = 49;
        return Response.json(existing, { status: 200 });
      }
      // 任意 release 的附件上传（缺失时创建的是 99，替换已有附件时是 49）
      if (value.includes('/attach_files') && method === 'POST') {
        attachAttempts += 1;
        if (attachAttempts <= attachFailures) {
          // 模拟跨境上传中途被重置：undici 抛 TypeError('fetch failed')，原因在 cause
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'socket hang up' } });
        }
        return Response.json({ name: 'Doc-Internal-Word-Remover-v1.0.0.zip' }, { status: 201 });
      }
      // 删除旧附件（替换附件时才走到）
      if (value.includes('/attach_files/') && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (value.includes('api.github.com/repos/o/r/releases?')) {
        return Response.json(github);
      }
      if (value.includes('gitee.com/api/v5/repos/o/r/releases?')) {
        return Response.json(gitee);
      }
      if (value.startsWith('https://assets.test/')) {
        return new Response(value.includes('github') ? githubAsset : giteeAsset);
      }
      throw new Error(`unexpected request: ${value}`);
    },
  };
}

const common = {
  githubOwner: 'o',
  githubRepo: 'r',
  giteeOwner: 'o',
  giteeRepo: 'r',
  githubToken: 'x',
  giteeToken: 'y',
  // 线上默认走 node:https（fetch 有 5 分钟响应头限制）；测试里注入 fetch 通道，
  // 这样下面的全局 fetch mock 仍然能接管上传请求。
  giteeUploadTransport: fetchTransport,
  log: () => {},
};

{
  const a = release('v1.0.0');
  const b = structuredClone(a);
  a.assets[0].browser_download_url = 'https://assets.test/github-v1.zip';
  b.assets[0].browser_download_url = 'https://assets.test/gitee-v1.zip';
  const fake = mockFetch({ github: [a], gitee: [b] });
  globalThis.fetch = fake.fetch;
  const result = await synchronize(common);
  assert.deepEqual(result, { checked: 1, changes: 0, dryRun: false });
  assert.equal(fake.calls.some((call) => call.method !== 'GET'), false);
}

{
  const a = release('v1.0.0');
  const fake = mockFetch({ github: [a], gitee: [] });
  globalThis.fetch = fake.fetch;
  const result = await synchronize({ ...common, dryRun: true });
  assert.equal(result.changes, 1);
  assert.equal(fake.calls.some((call) => call.method !== 'GET'), false);
}

{
  const a = release('v1.0.0');
  a.assets[0].browser_download_url = 'https://assets.test/github-v1.zip';
  const fake = mockFetch({ github: [a], gitee: [] });
  globalThis.fetch = fake.fetch;
  const result = await synchronize(common);
  assert.equal(result.changes, 2);
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 2);
}

{
  const a = release('v1.0.0', 'github body');
  const b = release('v1.0.0', 'gitee body');
  globalThis.fetch = mockFetch({ github: [a], gitee: [b] }).fetch;
  await assert.rejects(() => synchronize(common), /正文不一致/);
}

// v4.98：正文不一致时，默认必须中止（防覆盖人工修改）；
//   显式传 updateBody 才允许把 Gitee 正文对齐 GitHub。
//   典型场景：上一次发版中途失败，Gitee 上留下旧的自动生成正文，
//   而 GitHub 上已被新一轮发布更新过。
{
  const a = release('v1.0.0', 'github body');
  const b = release('v1.0.0', 'gitee body');
  const fake = mockFetch({ github: [a], gitee: [b] });
  globalThis.fetch = fake.fetch;
  await assert.rejects(() => synchronize({ ...common, updateBody: false }), /正文不一致/);
}
{
  const a = release('v1.0.0', 'github body');
  const b = release('v1.0.0', 'gitee body');
  const fake = mockFetch({ github: [a], gitee: [b] });
  globalThis.fetch = fake.fetch;
  // 显式授权后：应发出一次 PATCH 更新 Gitee 正文，且不再抛「正文不一致」
  const result = await synchronize({ ...common, updateBody: true });
  assert.equal(result.changes, 1);
  const patch = fake.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, '没有发出更新 Gitee 正文的 PATCH 请求');
  assert.ok(patch.url.includes('/releases/'), 'PATCH 地址不对：' + patch.url);
}

assert.deepEqual(
  ['history-v4.10', 'v4.78.1', 'history-v2.10', 'history-v4.9', 'history-v2.9'].sort(compareReleaseTags),
  ['history-v2.9', 'history-v2.10', 'history-v4.9', 'history-v4.10', 'v4.78.1'],
);

// v4.98：发布包因随包分发 OCR 识别模型从约 1MB 涨到约 10MB，
// 写死 45 秒的超时会卡在边上，表现为「上传 Gitee 附件…超时」。
// 超时必须随包体大小增长。
{
  const MB = 1024 * 1024;
  assert.ok(uploadTimeoutMs(1 * MB) >= 45000, '小包也应有 45 秒保底');
  assert.ok(uploadTimeoutMs(10 * MB) > uploadTimeoutMs(1 * MB), '大包的超时必须更长');
  // 跨境实测只有几十 KB/s：10MB 必须给到分钟级，200 秒不够（曾三次各 4 分钟全超时）
  assert.ok(uploadTimeoutMs(10 * MB) >= 500000, '10MB 的包超时至少 500 秒');
  // 服务端落盘还要静默等 5 分钟以上，10MB 至少要给到 12 分钟
  assert.ok(uploadTimeoutMs(10 * MB) >= 720000, '10MB 的包要覆盖服务端处理静默期');
  assert.ok(uploadTimeoutMs(1000 * MB) <= 2700000, '超时要有上限，不能无限长');
}

// v4.98：Gitee 大附件必须带 Content-Length。
//   undici 发 FormData 时走 chunked、不带长度，跨境传 10MB 会被中间层重置
//   （实测报 fetch failed）。这里锁住手工拼的 multipart：
//   长度可预知、边界闭合、文件字节原样嵌入。
{
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
  const { body, contentType } = buildMultipartBody('file', 'a-b.zip', payload, 'application/zip');
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const text = body.toString('latin1');
  assert.ok(body.length > payload.length, 'multipart 体应包含头尾');
  assert.ok(text.startsWith('--' + boundary + '\r\n'), '必须以边界开头');
  assert.ok(text.endsWith('\r\n--' + boundary + '--\r\n'), '必须以闭合边界结尾');
  assert.ok(text.includes('name="file"'), '字段名丢了');
  assert.ok(text.includes('filename="a-b.zip"'), '文件名丢了');
  assert.ok(body.includes(payload), '文件字节必须原样嵌入（二进制不能被转码）');
}

// v4.98：发版重跑会重建 zip，哈希必然变，而 Gitee 上还是上一轮的文件。
//   默认必须报错（不擅自删除已有附件）；显式 --replace-asset 时，
//   才以 GitHub 为准删旧传新。
{
  const a = release('v1.0.0');
  a.assets[0].browser_download_url = 'https://assets.test/github-v1.zip';
  const b = release('v1.0.0');
  b.assets[0].browser_download_url = 'https://assets.test/gitee-v1.zip';
  globalThis.fetch = mockFetch({ github: [a], gitee: [b], githubAsset: 'NEW', giteeAsset: 'OLD' }).fetch;
  await assert.rejects(() => synchronize(common), /附件内容不一致/);
}
{
  const a = release('v1.0.0');
  a.assets[0].browser_download_url = 'https://assets.test/github-v1.zip';
  const b = release('v1.0.0');
  b.assets[0].browser_download_url = 'https://assets.test/gitee-v1.zip';
  const fake = mockFetch({ github: [a], gitee: [b], githubAsset: 'NEW', giteeAsset: 'OLD' });
  globalThis.fetch = fake.fetch;
  const result = await synchronize({ ...common, replaceAsset: true });
  assert.equal(result.changes, 1);
  assert.ok(fake.calls.some((c) => c.method === 'DELETE'), '没有删除旧 Gitee 附件');
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.url.includes('/attach_files')),
    '没有重新上传附件');
}
{
  // dry-run 只报告不删除
  const a = release('v1.0.0');
  a.assets[0].browser_download_url = 'https://assets.test/github-v1.zip';
  const b = release('v1.0.0');
  b.assets[0].browser_download_url = 'https://assets.test/gitee-v1.zip';
  const fake = mockFetch({ github: [a], gitee: [b], githubAsset: 'NEW', giteeAsset: 'OLD' });
  globalThis.fetch = fake.fetch;
  const result = await synchronize({ ...common, replaceAsset: true, dryRun: true });
  assert.equal(result.changes, 1);
  assert.equal(fake.calls.some((c) => c.method === 'DELETE' || c.method === 'POST'), false,
    'dry-run 不得真的删除或上传');
}

// v4.98.1：跨境上传 10MB 实测会有「跑到四五分钟被重置」的情况（ECONNRESET），
//   同一条链路重试有时就能过。上传失败后必须自动重试一次，
//   并且错误信息要带上底层原因（否则日志里只有一句 fetch failed，没法判断）。
{
  const a = release('v1.0.0');
  const fake = mockFetch({ github: [a], gitee: [], attachFailures: 1 });
  globalThis.fetch = fake.fetch;
  const result = await synchronize({ ...common, retryDelayMs: 0 });
  // 变更数 2 = 补建 Gitee Release + 上传附件（与前面的「两边都缺」用例同口径）
  assert.equal(result.changes, 2, '重试成功后应计为 2 个变更');
  assert.equal(fake.calls.filter((c) => c.method === 'POST' && c.url.includes('/attach_files')).length, 2,
    '应在第一次失败后重试一次');
}
{
  // 两次都失败时必须抛错，且信息里带底层原因
  const a = release('v1.0.0');
  globalThis.fetch = mockFetch({ github: [a], gitee: [], attachFailures: 5 }).fetch;
  await assert.rejects(() => synchronize({ ...common, retryDelayMs: 0 }), /ECONNRESET/);
}

// v4.98.1：Gitee 上传改走 node:https 直传。
//   起因是 undici 的 fetch 有内部 headersTimeout=300s：服务端收完 10MB
//   才回响应头，跨境上传正好卡在 5 分钟，于是每次都被中断。
//   这里用本地真实 HTTP 服务验证这条通道：超大请求体 + 服务端延迟响应，
//   仍然完整送达并拿到结果。
{
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x42);
  for (let i = 0; i < payload.length; i += 8192) payload[i] = i % 251;
  const { body, contentType } = buildMultipartBody('file', 'big.zip', payload, 'application/zip');

  let received = 0;
  let declared = '';
  const server = http.createServer((req, res) => {
    declared = String(req.headers['content-length'] || '');
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => {
      received = n;
      // 模拟 Gitee：收完之后再想一会儿才回响应头
      setTimeout(() => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 300);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const text = await httpsPostBuffer(`http://127.0.0.1:${port}/upload`, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
  }, body, 60000);
  server.close();

  assert.equal(declared, String(body.length), 'Content-Length 与实际体长不一致');
  assert.equal(received, body.length, '服务端没有收全');
  assert.match(text, /"ok":true/, '没有拿到正常响应体');
}

console.log('release sync: 15/15 passed');
