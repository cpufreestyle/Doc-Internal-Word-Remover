import assert from 'node:assert/strict';
import { compareReleaseTags, synchronize, uploadTimeoutMs, buildMultipartBody } from './tools/release-sync.mjs';

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
      name: assetName,
      browser_download_url: `https://assets.test/${tag}.zip`,
    }],
  };
}

function mockFetch({ github, gitee, githubAsset = 'same', giteeAsset = 'same' }) {
  const calls = [];
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
      if (value.includes('/releases/99/attach_files') && method === 'POST') {
        return Response.json({ name: 'Doc-Internal-Word-Remover-v1.0.0.zip' }, { status: 201 });
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
  assert.ok(uploadTimeoutMs(1000 * MB) <= 1800000, '超时要有上限，不能无限长');
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

console.log('release sync: 9/9 passed');
