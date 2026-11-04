#!/usr/bin/env node
// A stand-in for the parts of the GitHub REST API the history job reads, answered from local
// git repositories. Tests import `gitHubFetch`; run it as a script to serve it over HTTP:
//   node scripts/fake-github.mjs <port> <owner/repo>=<git dir>[@<head sha>] ...
// Every request is logged to stderr as `<status> <path>`.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

const FIELDS = ['%H', '%T', '%P', '%an', '%cI', '%aI'].join('%x00');

/**
 * @typedef {{ dir: string, branch?: string, head?: string }} FakeRepo
 * @typedef {{ maxEntries?: number, remaining?: number, log?: (line: string) => void }} FakeOptions
 */

/**
 * A fetch function that answers GitHub API paths from git repositories.
 * @param {Record<string, FakeRepo>} repos keyed by owner/repo
 * @param {FakeOptions} [options] maxEntries: recursive trees truncate past it (GitHub: 100k)
 */
export function gitHubFetch(repos, options = {}) {
  const maxEntries = options.maxEntries ?? 100_000;
  const state = { remaining: options.remaining ?? 5000, requests: 0 };

  /** @param {string | URL | Request} input */
  const fetchFn = async (input, init = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : 'url' in input ? input.url : input.href,
    );
    state.requests++;
    const headers = new Headers(/** @type {HeadersInit} */ (init.headers ?? {}));
    const res = answer(url, headers);
    options.log?.(`${res.status} ${url.pathname}${url.search}`);
    return res;
  };

  /** @param {unknown} body @param {number} status */
  const json = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...limits(state) },
    });

  /** @param {URL} url @param {Headers} headers */
  function answer(url, headers) {
    if (state.remaining <= 0) return json({ message: 'API rate limit exceeded' }, 403);
    state.remaining--;
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const name = m ? `${m[1]}/${m[2]}` : '';
    const repo = Object.entries(repos).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (!m || !repo) return json({ message: 'Not Found' }, 404);
    const [fullName, config] = repo;
    const git = (/** @type {string[]} */ ...args) =>
      execFileSync('git', ['-C', config.dir, ...args], { maxBuffer: 1 << 30, encoding: 'utf8' });
    const branch = config.branch ?? 'main';
    const rest = m[3] ?? '';
    const q = url.searchParams;
    try {
      if (rest === '') return json({ full_name: fullName, default_branch: branch }, 200);
      const ref = /^\/commits\/(.+)$/.exec(rest);
      if (ref && headers.get('accept') === 'application/vnd.github.sha') {
        const name = decodeURIComponent(ref[1] ?? '');
        const sha =
          name === branch && config.head
            ? config.head
            : git('rev-parse', '--verify', `${name}^{commit}`).trim();
        return new Response(sha, { headers: limits(state) });
      }
      if (rest === '/commits') {
        const start = q.get('sha') ?? config.head ?? branch;
        const per = Math.min(100, Number(q.get('per_page') ?? 30));
        const page = Number(q.get('page') ?? 1);
        const until = q.get('until');
        const range = [start, ...(until ? [`--until=${until}`] : [])];
        const out = git(
          'log',
          ...range,
          `--skip=${(page - 1) * per}`,
          `-n${per}`,
          `--format=${FIELDS}`,
        );
        const commits = out
          .split('\n')
          .filter(Boolean)
          .map((line) => toCommit(line, fullName));
        const total = Number(git('rev-list', '--count', ...range).trim());
        const last = Math.max(1, Math.ceil(total / per));
        const res = json(commits, 200);
        if (last > 1) {
          const link = new URL(url);
          link.searchParams.set('page', String(last));
          res.headers.set('link', `<${link.href}>; rel="last"`);
        }
        return res;
      }
      if (ref) {
        const sha = git(
          'rev-parse',
          '--verify',
          `${decodeURIComponent(ref[1] ?? '')}^{commit}`,
        ).trim();
        const line = git('log', '-1', sha, `--format=${FIELDS}`).trim();
        const commit = toCommit(line, fullName);
        const files =
          commit.parents.length > 1
            ? []
            : git('diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', sha)
                .split('\0')
                .filter(Boolean)
                .reduce(
                  toFiles,
                  /** @type {{ out: object[], pending: string[] }} */ ({ out: [], pending: [] }),
                ).out;
        return json({ ...commit, files }, 200);
      }
      const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
      if (tree) {
        const recursive = q.get('recursive') === '1';
        const out = git('ls-tree', ...(recursive ? ['-r', '-t'] : []), '-z', tree[1] ?? '');
        let entries = out
          .split('\0')
          .filter(Boolean)
          .map((record) => {
            const tab = record.indexOf('\t');
            const [mode = '', type = '', sha = ''] = record.slice(0, tab).split(/ +/);
            return { path: record.slice(tab + 1), mode, type, sha };
          });
        const truncated = recursive && entries.length > maxEntries;
        if (truncated) entries = entries.slice(0, maxEntries);
        return json({ sha: tree[1], tree: entries, truncated }, 200);
      }
      const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
      if (blob) {
        const bytes = execFileSync('git', ['-C', config.dir, 'cat-file', 'blob', blob[1] ?? '']);
        return json(
          { sha: blob[1], encoding: 'base64', content: bytes.toString('base64') },
          200,
          url,
        );
      }
    } catch {
      return json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'Not Found' }, 404);
  }

  return Object.assign(fetchFn, { state });
}

/** @param {string} line @param {string} fullName */
function toCommit(line, fullName) {
  const [sha = '', tree = '', parents = '', name = '', committed = '', authored = ''] =
    line.split('\0');
  return {
    sha,
    url: `https://api.github.com/repos/${fullName}/commits/${sha}`,
    commit: {
      author: { name, date: authored },
      committer: { name, date: committed },
      tree: { sha: tree },
    },
    author: null,
    parents: parents
      .split(' ')
      .filter(Boolean)
      .map((p) => ({ sha: p })),
  };
}

const STATUS = /** @type {Record<string, string>} */ ({
  A: 'added',
  D: 'removed',
  M: 'modified',
  T: 'changed',
  C: 'copied',
  R: 'renamed',
});

/**
 * Folds `git diff-tree --name-status -z` fields into GitHub's files list.
 * @param {{ out: object[], pending: string[] }} acc
 * @param {string} field
 */
function toFiles(acc, field) {
  acc.pending.push(field);
  const [code = ''] = acc.pending;
  const kind = code[0] ?? '';
  const need = kind === 'R' || kind === 'C' ? 3 : 2;
  if (acc.pending.length < need) return acc;
  const [, a = '', b] = acc.pending;
  acc.out.push(
    b === undefined
      ? { filename: a, status: STATUS[kind] ?? 'modified' }
      : { filename: b, previous_filename: a, status: STATUS[kind] ?? 'modified' },
  );
  acc.pending = [];
  return acc;
}

/** @param {{ remaining: number }} state */
function limits(state) {
  return {
    'x-ratelimit-remaining': String(Math.max(0, state.remaining)),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port = '8787', ...specs] = process.argv.slice(2);
  /** @type {Record<string, FakeRepo>} */
  const repos = {};
  for (const spec of specs) {
    const [name = '', target = ''] = spec.split('=');
    const [dir = '', head] = target.split('@');
    const branch = execFileSync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    repos[name] = head ? { dir, branch, head } : { dir, branch };
  }
  const handle = gitHubFetch(repos, { log: (line) => console.error(line) });
  createServer(async (req, res) => {
    const reply = await handle(`http://localhost${req.url}`, {
      headers: /** @type {Record<string, string>} */ (req.headers),
    });
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    res.end(Buffer.from(await reply.arrayBuffer()));
  }).listen(Number(port), () =>
    console.error(`fake GitHub on :${port} for ${Object.keys(repos).join(', ')}`),
  );
}
