#!/usr/bin/env node
// Usage: node scripts/make-releases.mjs <owner/repo> <out.json>
// Writes every tag of the repo with its date, newest first, as [{ tag, at }] (at: ISO time), the
// shape src/repo/releases.ts reads for a bundled sample. It reads the tags with git, not GitHub's
// API, so it needs no token and sees every tag, not the 100 newest: a shallow, treeless fetch of
// the tagged commits only. An annotated tag dates from its tagger, a plain one from its commit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [fullName = '', out = ''] = process.argv.slice(2);
if (!fullName.includes('/') || !out) {
  console.error('usage: make-releases.mjs <owner/repo> <out.json>');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'releases-'));
try {
  /** @param {string[]} args */
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '--bare');
  const url = `https://github.com/${fullName}.git`;
  // A repo with no tags has nothing to fetch, and git fails on an empty fetch.
  const any = git('ls-remote', '--tags', url).trim() !== '';
  if (any) git('fetch', '-q', '--filter=tree:0', '--depth=1', url, '+refs/tags/*:refs/tags/*');
  const rows = git(
    'for-each-ref',
    'refs/tags',
    '--format=%(refname:short)|%(taggerdate:iso-strict)|%(committerdate:iso-strict)|%(*committerdate:iso-strict)',
  );
  /** @type {{ tag: string; at: string }[]} */
  const tags = [];
  for (const row of rows.split('\n')) {
    const [tag, tagger, commit, peeled] = row.split('|');
    const when = tagger || commit || peeled;
    if (!tag || !when) continue; // A tag of a tree or a blob has no date.
    tags.push({ tag, at: new Date(when).toISOString() });
  }
  tags.sort((a, b) => b.at.localeCompare(a.at) || a.tag.localeCompare(b.tag));
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tags)}\n`);
  renameSync(tmp, out);
  console.log(`${fullName}: ${tags.length} tags`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
