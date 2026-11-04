#!/usr/bin/env node
// The servers the history e2e test needs, in one process tree:
//   - a git repo `acme/widgets` holding the dotfiles sample's paths over three commits,
//   - server/scripts/fake-github.mjs serving it (GitHub's API and OAuth pages) with the branch
//     head one commit back, until a test moves it (POST /__head) to see a history go stale,
//   - server/scripts/local-worker.mjs, the real history Worker with KV in memory,
//   - the app built with VITE_HISTORY_URL and VITE_GITHUB_API pointing at them, on vite preview.
//
//   node e2e/history-stack.mjs <app port> <worker port> <fake port>
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [app = '4176', worker = '4177', fake = '4178'] = process.argv.slice(2);
const DAY = 24 * 60 * 60 * 1000;

const sample = JSON.parse(
  gunzipSync(readFileSync('public/samples/mathiasbynens-dotfiles.json.gz')).toString(),
);
const paths = sample.tree.tree
  .filter((/** @type {{ type: string }} */ e) => e.type === 'blob')
  .map((/** @type {{ path: string }} */ e) => e.path);
// A fixed place per port, cleared first, so a run that was killed leaves nothing behind for long.
const dir = join(tmpdir(), `history-e2e-${app}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
const git = (/** @type {string[]} */ args, at = 0) =>
  execFileSync('git', ['-C', dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: new Date(at).toISOString(),
      GIT_COMMITTER_DATE: new Date(at).toISOString(),
    },
  });
git(['init', '-q', '-b', sample.repo.default_branch]);
const now = Date.now();
// Each commit holds a growing share of the paths, dated so many days ago.
[
  { share: 0.4, daysAgo: 700 },
  { share: 0.8, daysAgo: 200 },
  { share: 1, daysAgo: 3 },
].forEach(({ share, daysAgo }, i) => {
  for (const path of paths.slice(0, Math.ceil(paths.length * share))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${path} ${i}\n`);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', `step ${i}`], now - daysAgo * DAY);
});

// GitHub starts one commit behind: the newest is "pushed" later (POST /__head) to make the
// shared history out of date.
const behind = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
const children = [
  spawn('node', ['server/scripts/fake-github.mjs', fake, `acme/widgets=${dir}@${behind}`], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_REMAINING: '100000' },
  }),
  spawn('node', ['server/scripts/local-worker.mjs', worker], {
    stdio: 'inherit',
    env: { ...process.env, FAKE_URL: `http://localhost:${fake}` },
  }),
];
const out = `dist-history-${app}`;
execFileSync('node', ['node_modules/vite/bin/vite.js', 'build', '--outDir', out, '--emptyOutDir'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_HISTORY_URL: `http://localhost:${worker}`,
    VITE_GITHUB_API: `http://localhost:${fake}`,
  },
});
children.push(
  spawn(
    'node',
    ['node_modules/vite/bin/vite.js', 'preview', '--outDir', out, '--port', app, '--strictPort'],
    {
      stdio: 'inherit',
    },
  ),
);

const stop = (code = 0) => {
  for (const child of children) child.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  process.exit(code);
};
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
// A server that dies (a port someone else holds, say) takes the stack down with it.
for (const child of children) child.on('exit', () => stop(1));
