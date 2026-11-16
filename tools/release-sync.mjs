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
    else if (arg === '--update-body') options.updateBody = true;
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

/**
 * 按包体大小给上传类请求留足时间。
 *
 * 发布包从约 1MB 涨到约 10MB（随包分发的 OCR 识别模型），而 GitHub
 * Actions 的 runner 在美西、目标在 Gitee，10MB 走一趟要四十多秒——
 * 固定 45 秒的写死超时刚好卡在边上，表现为「上传 Gitee 附件…超时」。
 * 按字节数给上限：每 MB 额外给 20 秒，最低 45 秒、封顶 10 分钟。
 */
function uploadTimeoutMs(byteLength) {
  const mb = (Number(byteLength) || 0) / (1024 * 1024);
  return Math.min(600000, Math.max(45000, Math.ceil(45000 + mb * 20000)));
}

async function request(url, options = {}, label = 'API 请求', timeoutMs = 45000, allowRetry = false) {
  let lastError;
  const method = String(options.method || 'GET').toUpperCase();
  const canRetry = method === 'GET' || method === 'HEAD' || allowRetry;
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

/** 上传类请求的超时上限：按包体大小给（每 MB 额外 20 秒），
 *  供回归测试直接验证，避免以后又被改回写死的 45 秒。 */
export { uploadTimeoutMs };

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

/** 更新已存在的 Gitee Release 的正文。
 *  默认不同步工具发现两边正文不一致就会中止（避免覆盖人工编辑），
 *  只有显式传 --update-body 时才会调这个函数把 Gitee 正文对齐 GitHub。 */
async function updateGiteeReleaseBody(owner, repo, token, release, body, name) {
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}`;
  const payload = {
    tag_name: release.tag_name,
    name: release.name || release.tag_name,
    body: body || '',
    target_commitish: release.target_commitish || 'main',
    prerelease: Boolean(release.prerelease),
  };
  const response = await request(url, {
    method: 'PATCH',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }, `更新 Gitee Release 正文 ${release.tag_name}`);
  return readJson(response, `更新 Gitee Release 正文 ${release.tag_name}`);
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
  }, `上传 GitHub 附件 ${name}`, uploadTimeoutMs(buffer.length));
}

async function uploadGiteeAsset(owner, repo, token, release, name, buffer, log = console.log) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/zip' }), name);
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}/attach_files`;
  // FormData 是一次性的：重试时必须重新构造，否则第二次发的是空 body。
  const post = () => {
    const f = new FormData();
    f.append('file', new Blob([buffer], { type: 'application/zip' }), name);
    return request(url, {
      method: 'POST',
      headers: authHeaders(token),
      body: f,
    }, `上传 Gitee 附件 ${name}`, uploadTimeoutMs(buffer.length), true);
  };
  try {
    await post();
  } catch (error) {
    // 超时不一定等于「没传上去」——也可能是传完了但响应没回来。
    // 先查一次附件列表：已经在就别重传（避免出现同名重复附件）。
    const releases = await listGiteeReleases(owner, repo, token);
    const found = releases
      .map((r) => findExpectedAsset(r, release.tag_name))
      .find(Boolean);
    if (found) {
      log(`上传 Gitee 附件 ${name} 报超时，但附件已存在，按成功处理`);
      return;
    }
    throw error;
  }
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
  updateBody = false,
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

    // 正文不一致时默认中止（防止覆盖人工编辑）。
    // 显式传 --update-body 才允许把 Gitee 正文对齐 GitHub——
    // 典型场景：上一次发版中途失败，Gitee 上留下的是旧的自动生成正文，
    // 而 GitHub 上已被新一轮发布更新过。
    if (githubRelease && giteeRelease &&
        normalizeBody(githubRelease.body) !== normalizeBody(giteeRelease.body)) {
      if (!updateBody) {
        throw new Error(`${currentTag} 的 Release 正文不一致；为避免覆盖人工修改，已停止自动同步`);
      }
      log(`对齐 Gitee Release 正文：${currentTag}`);
      if (dryRun) {
        // 只报告不写入：正文并没有真的对齐，跳过后面的正文一致性断言
        changes += 1;
        continue;
      }
      giteeRelease = await updateGiteeReleaseBody(
        giteeOwner, giteeRepo, giteeToken, giteeRelease, githubRelease.body);
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
      await uploadGiteeAsset(giteeOwner, giteeRepo, giteeToken, giteeRelease, assetName, buffer, log);
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
    '用法：node tools/release-sync.mjs [--tag vX.Y.Z] [--dry-run] [--update-body]',
    '',
    '  --update-body  两边正文不一致时，把 Gitee 正文对齐 GitHub。',
    '                 默认不传：发现不一致就中止，避免覆盖人工编辑。',
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
    updateBody: Boolean(options.updateBody),
  });
  console.log(`完成：检查 ${result.checked} 个 Release，${result.dryRun ? '预计' : '实际'}变更 ${result.changes} 个。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`同步失败：${error.message}`);
    process.exitCode = 1;
  });
}
