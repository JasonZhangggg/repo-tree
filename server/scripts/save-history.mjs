#!/usr/bin/env node
// Usage: node scripts/save-history.mjs <worker url> <owner/repo> <out.history.json.gz> [token]
// Polls a running history Worker until the repo's history is ready and writes it gzipped, the
// way public/samples/<id>.history.json.gz is made. The bundled samples come from `wrangler dev`
// pointed at scripts/fake-github.mjs over full-history clones pinned to each sample's commit.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const [base = '', repo = '', out = '', token = process.env.HISTORY_TOKEN] = process.argv.slice(2);
if (!base || !repo.includes('/') || !out) {
  console.error('usage: save-history.mjs <worker url> <owner/repo> <out.history.json.gz> [token]');
  process.exit(1);
}

const headers = token ? { Authorization: `Bearer ${token}` } : {};
for (;;) {
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/history/${repo}`, { headers });
  const reply = await res.json();
  if (reply.status === 'ready') {
    const json = JSON.stringify(reply.history);
    writeFileSync(out, gzipSync(json, { level: 9 }));
    const h = reply.history;
    console.log(
      `${out}: ${h.snapshots.length} snapshots, ${h.files.path.length} files, gaps ${JSON.stringify(h.gaps)}, ${json.length} bytes`,
    );
    break;
  }
  if (reply.status !== 'pending' && !(reply.status === 'error' && reply.error === 'rate-limited')) {
    console.error(JSON.stringify(reply));
    process.exit(1);
  }
  process.stdout.write(`${reply.status} ${reply.progress ?? ''}\n`);
  await new Promise((r) => setTimeout(r, (reply.retryAfter ?? 2) * 1000));
}
