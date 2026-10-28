#!/usr/bin/env node
/** Fail when the tracked public tree contains likely secrets or internal identifiers. */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' });
if (listed.status !== 0) {
  console.error('Unable to list tracked files');
  process.exit(1);
}

const files = listed.stdout.toString('utf8').split('\0').filter(Boolean);
const forbiddenNames = /(^|\/)(HANDOVER(?:-log)?\.md|design-qa\.md|ui-benchmark-findings\.md|\.env(?:\.|$)|[^/]+\.(?:pem|key|p12|pfx))$/i;
const binaryExt = /\.(?:png|ico|jpg|jpeg|gif|webp|woff2?|zip|gz|exe|mp4|pdf)$/i;
const workstationPath = new RegExp(
  ['C:', '\\\\', 'Users', '\\\\'].join('') + '|' + ['D:', '\\\\', 'workspace', '\\\\'].join(''),
  'i'
);
const rules = [
  ['workstation path', workstationPath],
  ['local scan artifact', /\bZ:\\(?!\\server)|Z-(?:w4|core4?|new|scan|fix)/i],
  ['GitHub token', /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['GitLab token', /glpat-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];

const findings = [];
for (const rel of files) {
  if (forbiddenNames.test(rel)) {
    findings.push(rel + ': forbidden filename');
    continue;
  }
  if (binaryExt.test(rel)) continue;
  const full = path.join(root, rel);
  let buf;
  try { buf = fs.readFileSync(full); } catch (e) { continue; }
  if (buf.includes(0)) continue;
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [name, re] of rules) {
      if (re.test(lines[i])) findings.push(rel + ':' + (i + 1) + ' ' + name);
    }
  }
}

if (findings.length) {
  console.error('Public tree check failed:');
  findings.slice(0, 50).forEach((f) => console.error('  ' + f));
  if (findings.length > 50) console.error('  ... and ' + (findings.length - 50) + ' more');
  process.exit(1);
}

console.log('Public tree check passed: ' + files.length + ' tracked files scanned.');
