#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PER_PAGE = 100;
const ZIP_PREFIX = 'Doc-Internal-Word-Remover-';

function parseArgs(argv) {
  const options = { dryRun: false, tag: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--tag') {
      options.tag = argv[i + 1] || '';
      i += 1;
      if (!options.tag) throw new Error('--tag 需要版本号');
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function repoConfig() {
  const [defaultOwner, defaultRepo] = (process.env.GITHUB_REPOSITORY || '').split('/');
  return {
    githubOwner: process.env.GITHUB_OWNER || defaultOwner || 'cpufreestyle',
    githubRepo: process.env.GITHUB_REPO || defaultRepo || 'Doc-Internal-Word-Remover',
    giteeOwner: process.env.GITEE_OWNER || defaultOwner || 'cpufreestyle',
    giteeRepo: process.env.GITEE_REPO || defaultRepo || 'Doc-Internal-Word-Remover',
  };
}

function authHeaders(token, extra = {}) {
  if (!token) throw new Error('缺少访问令牌');
  return { Authorization: `token ${token}`, ...extra };
}

async function request(url, options = {}, label = 'API 请求', timeoutMs = 45000) {
  let lastError;
  const method = String(options.method || 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        ...options,
        headers: {
          'User-Agent': 'Doc-Internal-Word-Remover-release-sync/1.0',
          ...options.headers,
        },
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 500);
      lastError = new Error(`${label}失败（HTTP ${response.status}）：${detail}`);
      if (!canRetry || (response.status < 500 && response.status !== 429)) break;
    } catch (error) {
      lastError = new Error(`${label}失败：${error.message}`, { cause: error });
      if (!canRetry) break;
    }
    if (canRetry && attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
  }
  throw lastError;
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}返回了无效 JSON`);
  }
}

async function listGithubReleases(owner, repo, token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    const response = await request(url, {
      headers: authHeaders(token, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
    }, '读取 GitHub Releases');
    const batch = await readJson(response, '读取 GitHub Releases');
    releases.push(...batch.filter((release) => !release.draft));
    if (batch.length < PER_PAGE) break;
  }
  return releases;
}

async function listGiteeReleases(owner, repo, token) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    const response = await request(url, { headers: authHeaders(token) }, '读取 Gitee Releases');
    const batch = await readJson(response, '读取 Gitee Releases');
    releases.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return releases;
}

function expectedAssetName(tag) {
  return `${ZIP_PREFIX}${tag}.zip`;
}

function findExpectedAsset(release, tag) {
  const expected = expectedAssetName(tag);
  return (release.assets || []).find((asset) => asset.name === expected);
}

function normalizeBody(body) {
  return String(body || '').replace(/\r\n/g, '\n').trimEnd();
}

export function compareReleaseTags(left, right) {
  const leftIsHistory = left.startsWith('history-');
  const rightIsHistory = right.startsWith('history-');
  if (leftIsHistory !== rightIsHistory) return leftIsHistory ? -1 : 1;
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex').toUpperCase();
}

async function download(url, label) {
  const response = await request(url, {
    headers: {
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
    },
  }, label, 90000);
  return Buffer.from(await response.arrayBuffer());
}

async function createGiteeRelease(owner, repo, token, githubRelease) {
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases`;
  const payload = {
    tag_name: githubRelease.tag_name,
    name: githubRelease.name || githubRelease.tag_name,
    body: githubRelease.body || '',
    target_commitish: githubRelease.target_commitish || 'main',
    prerelease: Boolean(githubRelease.prerelease),
  };
  const response = await request(url, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, `创建 Gitee Release ${githubRelease.tag_name}`);
  return readJson(response, `创建 Gitee Release ${githubRelease.tag_name}`);
}

async function createGithubRelease(owner, repo, token, giteeRelease) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases`;
  const payload = {
    tag_name: giteeRelease.tag_name,
    name: giteeRelease.name || giteeRelease.tag_name,
    body: giteeRelease.body || '',
    target_commitish: giteeRelease.target_commitish || 'main',
    prerelease: Boolean(giteeRelease.prerelease),
    draft: false,
  };
  const response = await request(url, {
    method: 'POST',
    headers: authHeaders(token, {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    }),
    body: JSON.stringify(payload),
  }, `创建 GitHub Release ${giteeRelease.tag_name}`);
  return readJson(response, `创建 GitHub Release ${giteeRelease.tag_name}`);
}

async function uploadGithubAsset(owner, repo, token, release, name, buffer) {
  const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ''));
  uploadUrl.searchParams.set('name', name);
  await request(uploadUrl, {
    method: 'POST',
    headers: authHeaders(token, {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/zip',
      'Content-Length': String(buffer.length),
      'X-GitHub-Api-Version': '2022-11-28',
    }),
    body: buffer,
  }, `上传 GitHub 附件 ${name}`);
}

async function uploadGiteeAsset(owner, repo, token, release, name, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/zip' }), name);
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}/attach_files`;
  await request(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  }, `上传 Gitee 附件 ${name}`);
}

async function verifyAssetPair(tag, githubAsset, giteeAsset) {
  const giteeBuffer = await download(giteeAsset.browser_download_url, `下载 Gitee 附件 ${tag}`);
  const giteeHash = sha256(giteeBuffer);
  let githubHash = String(githubAsset.digest || '').replace(/^sha256:/i, '').toUpperCase();
  if (!githubHash) {
    const githubBuffer = await download(githubAsset.browser_download_url, `下载 GitHub 附件 ${tag}`);
    githubHash = sha256(githubBuffer);
  }
  if (githubHash !== giteeHash) {
    throw new Error(`${tag} 附件内容不一致：GitHub ${githubHash}，Gitee ${giteeHash}`);
  }
}

function assertMatchingMetadata(tag, githubRelease, giteeRelease) {
  if (Boolean(githubRelease.prerelease) !== Boolean(giteeRelease.prerelease)) {
    throw new Error(`${tag} 的 prerelease 状态不一致`);
  }
  if (normalizeBody(githubRelease.body) !== normalizeBody(giteeRelease.body)) {
    throw new Error(`${tag} 的 Release 正文不一致；为避免覆盖人工修改，已停止自动同步`);
  }
}

export async function synchronize({
  githubOwner,
  githubRepo,
  giteeOwner,
  giteeRepo,
  githubToken,
  giteeToken,
  tag = '',
  dryRun = false,
  log = console.log,
}) {
  const [githubReleases, giteeReleases] = await Promise.all([
    listGithubReleases(githubOwner, githubRepo, githubToken),
    listGiteeReleases(giteeOwner, giteeRepo, giteeToken),
  ]);
  const githubByTag = new Map(githubReleases.map((release) => [release.tag_name, release]));
  const giteeByTag = new Map(giteeReleases.map((release) => [release.tag_name, release]));
  // Gitee lists releases by creation time. Recreate missing history in version
  // order so filling a gap cannot put v2.9 after v2.10 or obscure the latest release.
  const tags = tag ? [tag] : [...new Set([...githubByTag.keys(), ...giteeByTag.keys()])].sort(compareReleaseTags);

  if (tag && !githubByTag.has(tag) && !giteeByTag.has(tag)) {
    throw new Error(`两个平台都没有 Release ${tag}`);
  }

  let changes = 0;
  for (const currentTag of tags) {
    let githubRelease = githubByTag.get(currentTag);
    let giteeRelease = giteeByTag.get(currentTag);
    const assetName = expectedAssetName(currentTag);

    if (!githubRelease && giteeRelease) {
      log(`缺失：GitHub Release ${currentTag}`);
      if (dryRun) {
        changes += 1;
        continue;
      }
      githubRelease = await createGithubRelease(githubOwner, githubRepo, githubToken, giteeRelease);
      githubByTag.set(currentTag, githubRelease);
      changes += 1;
    }

    if (!giteeRelease && githubRelease) {
      log(`缺失：Gitee Release ${currentTag}`);
      if (dryRun) {
        changes += 1;
        continue;
      }
      giteeRelease = await createGiteeRelease(giteeOwner, giteeRepo, giteeToken, githubRelease);
      giteeByTag.set(currentTag, giteeRelease);
      changes += 1;
    }

    assertMatchingMetadata(currentTag, githubRelease, giteeRelease);
    let githubAsset = findExpectedAsset(githubRelease, currentTag);
    let giteeAsset = findExpectedAsset(giteeRelease, currentTag);

    if (!githubAsset && !giteeAsset) {
      log(`跳过 ${currentTag}：没有项目附件 ${assetName}`);
      continue;
    }
    if (!githubAsset && giteeAsset) {
      log(`缺失：GitHub 附件 ${assetName}`);
      if (dryRun) {
        changes += 1;
        continue;
      }
      const buffer = await download(giteeAsset.browser_download_url, `下载 Gitee 附件 ${currentTag}`);
      await uploadGithubAsset(githubOwner, githubRepo, githubToken, githubRelease, assetName, buffer);
      changes += 1;
    } else if (githubAsset && !giteeAsset) {
      log(`缺失：Gitee 附件 ${assetName}`);
      if (dryRun) {
        changes += 1;
        continue;
      }
      const buffer = await download(githubAsset.browser_download_url, `下载 GitHub 附件 ${currentTag}`);
      await uploadGiteeAsset(giteeOwner, giteeRepo, giteeToken, giteeRelease, assetName, buffer);
      changes += 1;
    } else {
      log(`校验：${currentTag} 附件 SHA256`);
      await verifyAssetPair(currentTag, githubAsset, giteeAsset);
    }
  }

  return { checked: tags.length, changes, dryRun };
}

function usage() {
  return [
    '用法：node tools/release-sync.mjs [--tag vX.Y.Z] [--dry-run]',
    '',
    '环境变量：GITHUB_TOKEN、GITEE_TOKEN',
    '可选变量：GITHUB_OWNER、GITHUB_REPO、GITEE_OWNER、GITEE_REPO',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const repos = repoConfig();
  const result = await synchronize({
    ...repos,
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    giteeToken: process.env.GITEE_TOKEN,
    tag: options.tag,
    dryRun: options.dryRun,
  });
  console.log(`完成：检查 ${result.checked} 个 Release，${result.dryRun ? '预计' : '实际'}变更 ${result.changes} 个。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`同步失败：${error.message}`);
    process.exitCode = 1;
  });
}
