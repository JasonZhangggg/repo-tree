#!/usr/bin/env node
// Usage: node scripts/save-history.mjs <api url> <owner/repo> <branch> <out.history.json.gz> [token]
// Computes a repo's history with the in-browser engine (src/core/engine.ts) and writes it
// gzipped, the way public/samples/<id>.history.json.gz is made: point <api url> at
// scripts/fake-github.mjs serving full-history clones pinned to each sample's commit.
import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { gzipSync } from 'node:zlib';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(s, c, next) {
  try { return await next(s, c); } catch (e) {
    if (s.startsWith('.') && !/\\.[cm]?[jt]s$/.test(s)) return next(s + '.ts', c);
    throw e;
  }
}`),
);
process.removeAllListeners('warning');

const [api = '', repo = '', branch = '', out = '', token = process.env.HISTORY_TOKEN] =
  process.argv.slice(2);
if (!api || !repo.includes('/') || !branch || !out) {
  console.error(
    'usage: save-history.mjs <api url> <owner/repo> <branch> <out.history.json.gz> [token]',
  );
  process.exit(1);
}

const { computeHistory } = await import('../src/core/engine.ts');
const h = await computeHistory({
  fetch: (input, init) => fetch(input, init),
  api,
  ...(token ? { token } : {}),
  repo,
  branch,
  onProgress: (p) => process.stdout.write(`\r${Math.round(p * 100)}%`),
});
const json = JSON.stringify(h);
writeFileSync(out, gzipSync(json, { level: 9 }));
console.log(
  `\n${out}: ${h.snapshots.length} snapshots, ${h.files.path.length} files, gaps ${JSON.stringify(h.gaps)}, ${json.length} bytes`,
);
