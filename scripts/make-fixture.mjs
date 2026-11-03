#!/usr/bin/env node
// Usage: node scripts/make-fixture.mjs <owner/repo> <out.json | out.json.gz> [--slim]
// Shallow-clones a public repo and writes { repo, tree } shaped like the GitHub REST
// responses of GET /repos/{o}/{r} and GET /repos/{o}/{r}/git/trees/{branch}?recursive=1.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { toTreeResponse } from './ls-tree.mjs';

const MIN_FREE_BYTES = 2 * 1024 ** 3;

const [fullName = '', out = '', flag] = process.argv.slice(2);
const [owner, repo] = fullName.split('/');
if (!owner || !repo || !out) {
  console.error('usage: make-fixture.mjs <owner/repo> <out.json | out.json.gz> [--slim]');
  process.exit(1);
}

const { bavail, bsize } = statfsSync(tmpdir());
if (bavail * bsize < MIN_FREE_BYTES) {
  console.error(`less than ${MIN_FREE_BYTES / 1024 ** 3} GiB free in ${tmpdir()}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'make-fixture-'));
try {
  // --no-checkout skips the working tree. ls-tree reads sizes straight from the pack.
  execFileSync('git', [
    'clone',
    '--quiet',
    '--depth=1',
    '--single-branch',
    '--no-checkout',
    `https://github.com/${owner}/${repo}.git`,
    dir,
  ]);
  /** @param {string[]} args */
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1024 ** 3 });

  const fixture = {
    repo: {
      name: repo,
      full_name: fullName,
      owner: { login: owner },
      default_branch: git('symbolic-ref', '--short', 'HEAD').trim(),
    },
    tree: toTreeResponse(git('ls-tree', '-r', '-t', '-l', '-z', 'HEAD'), {
      fullName,
      treeSha: git('rev-parse', 'HEAD^{tree}').trim(),
      slim: flag === '--slim',
    }),
  };
  const json = JSON.stringify(fixture);
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, out.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json);
  renameSync(tmp, out);
  const files = fixture.tree.tree.filter((e) => e.type === 'blob').length;
  console.log(`${out}: ${files} files, ${fixture.tree.tree.length} entries`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
