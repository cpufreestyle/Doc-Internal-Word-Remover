import assert from 'node:assert/strict';
import { synchronize } from './tools/release-sync.mjs';

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

console.log('release sync: 4/4 passed');
