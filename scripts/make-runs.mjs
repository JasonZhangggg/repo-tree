#!/usr/bin/env node
// Usage: node scripts/make-runs.mjs <owner/repo> <branch> <out.json>
// Writes the repo's last 20 finished GitHub Actions runs on <branch>, shaped like
// GET /repos/{o}/{r}/actions/runs and trimmed to the fields the app reads. Set GITHUB_TOKEN for a
// higher rate limit.
import { renameSync, writeFileSync } from 'node:fs';

const [fullName = '', branch = '', out = ''] = process.argv.slice(2);
if (!fullName.includes('/') || !branch || !out) {
  console.error('usage: make-runs.mjs <owner/repo> <branch> <out.json>');
  process.exit(1);
}

const KEEP = [
  'id',
  'name',
  'head_branch',
  'event',
  'status',
  'conclusion',
  'run_started_at',
  'updated_at',
];
const query = new URLSearchParams({ branch, status: 'completed', per_page: '20' });
/** @type {Record<string, string>} */
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const res = await fetch(`https://api.github.com/repos/${fullName}/actions/runs?${query}`, {
  headers,
});
if (res.status === 404) {
  write({ total_count: 0, workflow_runs: [] });
} else if (!res.ok) {
  console.error(`${fullName}: GitHub answered ${res.status}`);
  process.exit(1);
} else {
  /** @type {{ total_count: number; workflow_runs: Record<string, unknown>[] }} */
  const body = await res.json();
  write({
    total_count: body.total_count,
    workflow_runs: body.workflow_runs.map((run) =>
      Object.fromEntries(KEEP.map((key) => [key, run[key]])),
    ),
  });
}

/** @param {unknown} body */
function write(body) {
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, out);
  console.log(`${out}: ${/** @type {any} */ (body).workflow_runs.length} runs`);
}
