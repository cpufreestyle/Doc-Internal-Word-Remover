#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import https from 'node:https';
import http from 'node:http';

const PER_PAGE = 100;
const ZIP_PREFIX = 'Doc-Internal-Word-Remover-';

function parseArgs(argv) {
  const options = { dryRun: false, tag: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--update-body') options.updateBody = true;
    else if (arg === '--replace-asset') options.replaceAsset = true;
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
 * Actions 的 runner 在美西、目标在 Gitee。实测这段链路分两块时间：
 *   ① 把字节推上去（受带宽限制，10MB 约 2–4 分钟）；
 *   ② 推完之后服务端落盘、生成附件，才回响应——静默期可达 5 分钟以上。
 * 所以上限 = 固定开销 45 秒 + 每 MB 60 秒 + 服务端处理余量 300 秒；
 * 10MB 约 15.6 分钟，封顶 45 分钟。
 */
function uploadTimeoutMs(byteLength) {
  const mb = (Number(byteLength) || 0) / (1024 * 1024);
  return Math.min(2700000, Math.max(120000, Math.ceil(45000 + mb * 60000 + 300000)));
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
      // fetch 的报错常常只有一句「fetch failed」，真正的原因在 cause 里
      // （ECONNRESET / UND_ERR_SOCKET / ETIMEDOUT / 证书错误…）。
      // 不把 cause 带出来，事后只看日志根本判断不了是网络、代理还是请求体问题。
      const cause = error && error.cause;
      const detail = cause
        ? [cause.code, cause.message].filter(Boolean).join(' ') || String(cause)
        : '';
      lastError = new Error(`${label}失败：${error.message}` + (detail ? `（${detail}）` : ''), { cause: error });
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
export { uploadTimeoutMs, buildMultipartBody, fetchTransport, httpsPostBuffer };

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

/**
 * 手工拼 multipart/form-data 请求体。
 *
 * 为什么不用 FormData：undici 发 FormData 时走 chunked 传输、不带
 * Content-Length。跨境上传 10MB 到 Gitee 时这种「长度未知」的请求
 * 会被中间层重置（实测报 `fetch failed`，5 分钟就断）。
 * 自己拼成 Buffer 后长度是已知的，undici 会带上 Content-Length，
 * 接收端能按声明长度读满再回包，稳定性明显更好。
 */
function buildMultipartBody(fieldName, fileName, fileBuffer, contentType) {
  const boundary = '----DocInternalWordRemover' + Date.now().toString(16) +
    Math.random().toString(16).slice(2, 10);
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, Buffer.from(fileBuffer), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function uploadGiteeAsset(owner, repo, token, release, name, buffer, log = console.log,
  retryDelayMs = 15000, transport = httpsPostBuffer) {
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}/attach_files`;
  const { body, contentType } = buildMultipartBody('file', name, buffer, 'application/zip');
  const headers = authHeaders(token, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
  });
  const label = `上传 Gitee 附件 ${name}`;
  const post = async () => {
    try {
      return await transport(url, headers, body, uploadTimeoutMs(buffer.length), label);
    } catch (e) {
      throw new Error(`${label}失败：${e.message}`);
    }
  };

  // 跨境上传 10MB 实测会出现「跑到四五分钟连接被重置」的情况
  // （不是我们的超时，底层报 ECONNRESET / UND_ERR_SOCKET），而同一条链路
  // 重试有时就能过。这里最多试 2 次；每次失败后先查一次附件列表——
  // 万一其实传成功了只是响应没回来，直接按成功处理，不会出现同名重复附件。
  const ATTEMPTS = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await post();
      return;
    } catch (error) {
      lastError = error;
      const releases = await listGiteeReleases(owner, repo, token).catch(() => []);
      const found = releases
        .map((r) => findExpectedAsset(r, release.tag_name))
        .find(Boolean);
      if (found) {
        log(`上传 Gitee 附件 ${name} 报错，但附件已存在，按成功处理`);
        return;
      }
      if (attempt < ATTEMPTS) {
        log(`上传 Gitee 附件 ${name} 第 ${attempt} 次失败，15 秒后重试：${error.message}`);
        if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError;
}

/**
 * 删除 Gitee 上的旧附件。
 *
 * 用途只有一个：发版重跑时 GitHub 会重新构建 zip（哈希必然变化），
 * 而 Gitee 上还挂着上一轮的文件。此时「两边都有附件」但内容不一致，
 * 光校验只能报错，镜像会一直停在旧版本。删掉旧的再传新的，
 * 需要显式传 --replace-asset —— 默认仍然中止，避免误删人工上传的附件。
 */
async function deleteGiteeAsset(owner, repo, token, release, asset) {
  const assetId = asset && asset.id;
  if (!assetId) throw new Error(`Gitee 附件 ${asset && asset.name} 缺少 id，无法替换`);
  const url = `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/${release.id}/attach_files/${assetId}`;
  await request(url, {
    method: 'DELETE',
    headers: authHeaders(token),
  }, `删除旧 Gitee 附件 ${asset.name}`);
}

/**
 * 用 node:https 直传一段固定长度的请求体。
 *
 * 为什么不用 fetch：undici 的 fetch 有一个内部默认值 `headersTimeout = 300s`
 * ——从请求发出到**收到响应头**超过 5 分钟就报 `UND_ERR_HEADERS_TIMEOUT`。
 * Gitee 的 attach_files 要等服务端把 10MB 收完并落盘才回响应，跨境上传
 * 正好卡在 5 分钟上下，于是每次都失败；这个值无法通过 fetch 参数调整。
 * node:https 没有这个内部上限，只有我们自己设的总时长上限（按包体大小给出）。
 * 注意不要在 socket 上设「停滞」超时：字节可能几秒内就全部进了内核缓冲，
 * 之后要静默等 Gitee 落盘并回响应，这段静默是正常的。
 */
function httpsPostBuffer(url, headers, body, totalTimeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // 测试里用本地 http 服务验证这条通道；线上是 https。
    const mod = u.protocol === 'http:' ? http : https;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      fn(arg);
    };
    const req = mod.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) { req.destroy(new Error('响应体过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const code = res.statusCode || 0;
        if (code >= 200 && code < 300) finish(resolve, text);
        else finish(reject, new Error(`HTTP ${code}：${text.slice(0, 300)}`));
      });
      res.on('error', (e) => finish(reject, e));
    });
    const totalTimer = setTimeout(() => {
      req.destroy(new Error(`上传超过 ${Math.round(totalTimeoutMs / 1000)} 秒未完成`));
    }, totalTimeoutMs);
    // 不设 socket 级「停滞」超时：上传字节可能几秒内就全进了内核缓冲，
    // 之后要静默等 Gitee 落盘并回响应（实测可达 5 分钟以上）。
    // 这段静默是正常的，用 120 秒的停滞判定会把正常上传误杀。
    // 真正失控的情况由上面的总时长上限兜底。
    req.setTimeout(0);
    req.on('error', (e) => finish(reject, e));
    req.end(body);
  });
}

/**
 * 供测试注入的 fetch 版传输通道（单元测试里 mock 的是全局 fetch）。
 * 线上默认走 httpsPostBuffer——fetch 的 5 分钟响应头限制对 Gitee 上传是硬伤。
 */
function fetchTransport(url, headers, body, timeoutMs, label) {
  return request(url, { method: 'POST', headers, body }, label, timeoutMs, false);
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
  replaceAsset = false,
  retryDelayMs = 15000,
  giteeUploadTransport = httpsPostBuffer,
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
      await uploadGiteeAsset(giteeOwner, giteeRepo, giteeToken, giteeRelease, assetName, buffer, log, retryDelayMs, giteeUploadTransport);
      changes += 1;
    } else {
      log(`校验：${currentTag} 附件 SHA256`);
      try {
        await verifyAssetPair(currentTag, githubAsset, giteeAsset);
      } catch (error) {
        // 发版重跑会重建 zip，哈希必然变；Gitee 上还是上一轮的文件。
        // 默认把不一致当错误上报（不擅自删除已有附件），
        // 只有显式 --replace-asset 才以 GitHub 为准替换。
        if (!replaceAsset) throw error;
        log(`附件不一致，按 GitHub 为准替换 Gitee 附件：${currentTag}`);
        if (dryRun) {
          changes += 1;
          continue;
        }
        const buffer = await download(githubAsset.browser_download_url, `下载 GitHub 附件 ${currentTag}`);
        await deleteGiteeAsset(giteeOwner, giteeRepo, giteeToken, giteeRelease, giteeAsset);
        await uploadGiteeAsset(giteeOwner, giteeRepo, giteeToken, giteeRelease, assetName, buffer, log, retryDelayMs, giteeUploadTransport);
        changes += 1;
      }
    }
  }

  return { checked: tags.length, changes, dryRun };
}

function usage() {
  return [
    '用法：node tools/release-sync.mjs [--tag vX.Y.Z] [--dry-run] [--update-body] [--replace-asset]',
    '',
    '  --update-body  两边正文不一致时，把 Gitee 正文对齐 GitHub。',
    '                 默认不传：发现不一致就中止，避免覆盖人工编辑。',
    '  --replace-asset 两边附件 SHA256 不一致时，以 GitHub 为准替换 Gitee 附件。',
    '                 默认不传：发现不一致就报错，不擅自删除已有附件。',
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
    replaceAsset: Boolean(options.replaceAsset),
  });
  console.log(`完成：检查 ${result.checked} 个 Release，${result.dryRun ? '预计' : '实际'}变更 ${result.changes} 个。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`同步失败：${error.message}`);
    process.exitCode = 1;
  });
}
