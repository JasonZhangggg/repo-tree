#!/usr/bin/env node
// A stand-in for the parts of the GitHub REST API that history reads, answered from local git
// repositories. Tests and scripts/measure.mjs import `gitHubFetch`; run it as a script to serve
// it over HTTP:
//   node scripts/fake-github.mjs <port> <owner/repo>=<git dir>[@<head sha>] ...
// Every request is logged to stderr as `<status> <path>`.
//
// It mimics what costs requests and bytes on the real API, so measurements against it are honest:
// - Bodies are shaped like GitHub's, bulky fields included: every tree entry carries its `url`
//   (and `size` for blobs), every commit its node id, urls, verification and user objects.
// - Bodies are gzipped the way GitHub serves them; `state.bytes` counts the gzipped bytes, by
//   request kind in `state.kinds`. The HTTP server sends them gzipped when the client accepts it.
// - A recursive tree stops after 100,000 entries or 7 MB of tree data with `truncated: true`,
//   listing entries in git's order (each folder before its contents, by path).
// - Optionally (`network`), each answer is delayed by a round trip plus its transfer time on one
//   shared link, so concurrency shows in wall time the way it would on a phone or a laptop.
// Known gaps: clones made with --filter=blob:none have no blobs, so blob `size` is a stand-in
// derived from the sha (33 B to 22 KB, log-uniform), and /commits/{sha} files carry no `patch`
// (real ones do, so real per-commit bodies are larger than these).
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const SEP = '\x01';
const FIELDS = ['%H', '%T', '%P', '%an', '%ae', '%cn', '%ce', '%cI', '%aI', '%B'].join('%x01');

/**
 * @typedef {{ dir: string, branch?: string, head?: string, private?: boolean }} FakeRepo
 * @typedef {{ rttMs: number, bytesPerMs: number }} Network
 * @typedef {{ maxEntries?: number, maxTreeBytes?: number, remaining?: number, tokens?: string[],
 *   log?: (line: string) => void, network?: Network, gzipLevel?: number }} FakeOptions
 * @typedef {{ requests: number, bytes: number, raw: number }} Tally
 * @typedef {{ mode: string, type: 'blob' | 'tree' | 'commit', name: string, sha: string }} RawEntry
 */

/**
 * A fetch function that answers GitHub API paths from git repositories.
 * @param {Record<string, FakeRepo>} repos keyed by owner/repo
 * @param {FakeOptions} [options] maxEntries / maxTreeBytes: where recursive trees truncate
 *   (GitHub: 100k entries, 7 MB of tree data); tokens: when given, API calls need
 *   `Authorization: Bearer <one of them>` (else 401).
 *   It also plays github.com's OAuth endpoints: any authorize request comes back with code
 *   `fake-code`, which trades for the token `gho_fakefakefakefakefake`.
 */
export function gitHubFetch(repos, options = {}) {
  const maxEntries = options.maxEntries ?? 100_000;
  const maxTreeBytes = options.maxTreeBytes ?? 7 * 1024 * 1024;
  const gzipLevel = options.gzipLevel ?? 6;
  const state = {
    remaining: options.remaining ?? 5000,
    requests: 0,
    /** Gzipped body bytes, as they would cross the wire. */
    bytes: 0,
    /** Uncompressed body bytes. */
    raw: 0,
    /** @type {Record<string, Tally>} */
    kinds: {},
    /** Most requests in flight at once. */
    peakInFlight: 0,
    inFlight: 0,
  };
  /** @type {Map<string, GitObjects>} */
  const objects = new Map();
  const network = options.network;
  let linkFreeAt = 0;

  /** @param {string | URL | Request} input @param {RequestInit} [init] */
  const fetchFn = async (input, init = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : 'url' in input ? input.url : input.href,
    );
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    state.requests++;
    state.inFlight++;
    state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
    try {
      const headers = new Headers(/** @type {HeadersInit} */ (init.headers ?? {}));
      const { status, body, kind, type, extra } = url.pathname.startsWith('/login/oauth/')
        ? oauth(url, String(init.body ?? ''))
        : await answer(url, headers);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const gz = text ? gzipSync(text, { level: gzipLevel }) : Buffer.alloc(0);
      const tally = (state.kinds[kind] ??= { requests: 0, bytes: 0, raw: 0 });
      tally.requests++;
      tally.bytes += gz.length;
      tally.raw += Buffer.byteLength(text);
      state.bytes += gz.length;
      state.raw += Buffer.byteLength(text);
      options.log?.(`${status} ${url.pathname}${url.search.replace(/code=[^&]*/, 'code=…')}`);
      if (network) await delay(gz.length, signal);
      const res = new Response(status === 302 ? null : text, {
        status,
        headers: {
          ...(type ? { 'content-type': type } : {}),
          ...limits(state),
          ...extra,
          'x-fake-gzip-bytes': String(gz.length),
        },
      });
      return res;
    } finally {
      state.inFlight--;
    }
  };

  /** Waits a round trip, then for the body's turn on the shared link. */
  function delay(/** @type {number} */ bytes, /** @type {AbortSignal | undefined} */ signal) {
    const { rttMs, bytesPerMs } = /** @type {Network} */ (network);
    const now = performance.now();
    const start = Math.max(now + rttMs, linkFreeAt);
    linkFreeAt = start + bytes / bytesPerMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, linkFreeAt - now);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /** @param {URL} url @param {string} body */
  function oauth(url, body) {
    if (url.pathname === '/login/oauth/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', 'fake-code');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      return { status: 302, body: '', kind: 'oauth', extra: { location: back.href } };
    }
    const { code } = JSON.parse(body || '{}');
    return reply(
      code === 'fake-code'
        ? { access_token: 'gho_fakefakefakefakefake', token_type: 'bearer', scope: '' }
        : { error: 'bad_verification_code' },
      200,
      'oauth',
    );
  }

  /**
   * @param {unknown} body @param {number} status @param {string} kind
   * @param {Record<string, string>} [extra]
   */
  const reply = (body, status, kind, extra = {}) => ({
    status,
    body: /** @type {object | string} */ (body),
    kind,
    type: 'application/json; charset=utf-8',
    extra,
  });

  /** @param {URL} url @param {Headers} headers */
  async function answer(url, headers) {
    const auth = headers.get('authorization') ?? '';
    if (options.tokens && !options.tokens.some((t) => auth === `Bearer ${t}`)) {
      return reply({ message: 'Bad credentials' }, 401, 'error');
    }
    if (state.remaining <= 0) return reply({ message: 'API rate limit exceeded' }, 403, 'error');
    state.remaining--;
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const name = m ? `${m[1]}/${m[2]}` : '';
    const repo = Object.entries(repos).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (!m || !repo) return reply({ message: 'Not Found' }, 404, 'error');
    const [fullName, config] = repo;
    let objs = objects.get(config.dir);
    if (!objs) objects.set(config.dir, (objs = new GitObjects(config.dir)));
    const git = (/** @type {string[]} */ ...args) => run(config.dir, args);
    const branch = config.branch ?? 'main';
    const rest = m[3] ?? '';
    const q = url.searchParams;
    const base = `${API}/repos/${fullName}`;
    try {
      if (rest === '') {
        return reply(
          { full_name: fullName, default_branch: branch, private: config.private ?? false },
          200,
          'repo',
        );
      }
      const ref = /^\/commits\/(.+)$/.exec(rest);
      if (ref && headers.get('accept') === 'application/vnd.github.sha') {
        const name = decodeURIComponent(ref[1] ?? '');
        const sha =
          name === branch && config.head
            ? config.head
            : (await git('rev-parse', '--verify', `${name}^{commit}`)).trim();
        return { status: 200, body: sha, kind: 'ref', type: 'text/plain', extra: {} };
      }
      if (rest === '/commits') {
        const start = q.get('sha') ?? config.head ?? branch;
        const per = Math.min(100, Number(q.get('per_page') ?? 30));
        const page = Number(q.get('page') ?? 1);
        const until = q.get('until');
        const range = [start, ...(until ? [`--until=${until}`] : [])];
        const out = await git(
          'log',
          '-z',
          ...range,
          `--skip=${(page - 1) * per}`,
          `-n${per}`,
          `--format=${FIELDS}`,
        );
        const commits = out
          .split('\0')
          .filter(Boolean)
          .map((line) => toCommit(line, fullName));
        // Counting is slow on big histories, and only one-per-page listings have their Link read.
        const total = per === 1 ? Number((await git('rev-list', '--count', ...range)).trim()) : 0;
        const last = Math.max(1, Math.ceil(total / per));
        const extra = /** @type {Record<string, string>} */ ({});
        if (last > 1) {
          const link = new URL(url);
          link.searchParams.set('page', String(last));
          extra.link = `<${link.href}>; rel="last"`;
        }
        return reply(commits, 200, 'commits', extra);
      }
      if (ref) {
        const sha = (
          await git('rev-parse', '--verify', `${decodeURIComponent(ref[1] ?? '')}^{commit}`)
        ).trim();
        const line = (await git('log', '-z', '-1', sha, `--format=${FIELDS}`)).replace(/\0$/, '');
        const commit = toCommit(line, fullName);
        const files = commit.parents.length > 1 ? [] : await changedFiles(config.dir, sha, base);
        return reply(
          { ...commit, stats: { total: 0, additions: 0, deletions: 0 }, files },
          200,
          'commit',
        );
      }
      const tree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
      if (tree) {
        const sha = tree[1] ?? '';
        const recursive =
          q.has('recursive') && q.get('recursive') !== '0' && q.get('recursive') !== 'false';
        const top = await objs.tree(sha);
        if (!top) return reply({ message: 'Not Found' }, 404, 'error');
        const listing = recursive
          ? await walk(objs, sha, maxEntries, maxTreeBytes)
          : { entries: top.map((e) => ({ ...e, path: e.name })), truncated: false };
        const entries = listing.entries.map((e) => treeEntry(e, base));
        return reply(
          { sha, url: `${base}/git/trees/${sha}`, tree: entries, truncated: listing.truncated },
          200,
          recursive ? 'tree-recursive' : 'tree',
        );
      }
      const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
      if (blob) {
        const found = await objs.read(blob[1] ?? '');
        if (!found || found.type !== 'blob') return reply({ message: 'Not Found' }, 404, 'blob');
        return reply(
          {
            sha: blob[1],
            node_id: nodeId('B', blob[1] ?? ''),
            size: found.data.length,
            url: `${base}/git/blobs/${blob[1]}`,
            content: found.data.toString('base64').replace(/.{60}/g, '$&\n'),
            encoding: 'base64',
          },
          200,
          'blob',
        );
      }
    } catch {
      return reply({ message: 'Not Found' }, 404, 'error');
    }
    return reply({ message: 'Not Found' }, 404, 'error');
  }

  return Object.assign(fetchFn, {
    state,
    /** Ends the git processes the fake keeps open. */
    close() {
      for (const o of objects.values()) o.close();
      objects.clear();
    },
  });
}

/** @param {string} dir @param {string[]} args @returns {Promise<string>} */
function run(dir, args) {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['-C', dir, ...args],
      { maxBuffer: 1 << 30, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

/**
 * One `git cat-file --batch` per repository, with parsed trees cached by sha.
 */
class GitObjects {
  /** @param {string} dir */
  constructor(dir) {
    this.proc = spawn('git', ['-C', dir, 'cat-file', '--batch'], {
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // An idle fake never holds the process open; a pending read does (see `hold`).
    this.proc.unref();
    this.hold(false);
    /** @type {{ resolve: (v: { type: string, data: Buffer } | null) => void }[]} */
    this.waiting = [];
    this.buffer = Buffer.alloc(0);
    /** @type {Map<string, RawEntry[] | null>} */
    this.trees = new Map();
    this.proc.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    });
  }

  /** @param {boolean} on */
  hold(on) {
    for (const pipe of [this.proc.stdin, this.proc.stdout]) {
      const socket = /** @type {{ ref?: () => void, unref?: () => void }} */ (
        /** @type {unknown} */ (pipe)
      );
      if (on) socket.ref?.();
      else socket.unref?.();
    }
  }

  drain() {
    for (;;) {
      const nl = this.buffer.indexOf(10);
      if (nl < 0) return;
      const header = this.buffer.subarray(0, nl).toString();
      const parts = header.split(' ');
      if (parts[1] === 'missing' || parts.length < 3) {
        this.buffer = this.buffer.subarray(nl + 1);
        this.waiting.shift()?.resolve(null);
        if (this.waiting.length === 0) this.hold(false);
        continue;
      }
      const size = Number(parts[2]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const data = Buffer.from(this.buffer.subarray(nl + 1, nl + 1 + size));
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.waiting.shift()?.resolve({ type: parts[1] ?? '', data });
      if (this.waiting.length === 0) this.hold(false);
    }
  }

  /** @param {string} sha @returns {Promise<{ type: string, data: Buffer } | null>} */
  read(sha) {
    return new Promise((resolve) => {
      if (this.waiting.length === 0) this.hold(true);
      this.waiting.push({ resolve });
      this.proc.stdin.write(`${sha}\n`);
    });
  }

  /** @param {string} sha @returns {Promise<RawEntry[] | null>} */
  async tree(sha) {
    const known = this.trees.get(sha);
    if (known !== undefined) return known;
    const found = await this.read(sha);
    const entries = found && found.type === 'tree' ? parseTree(found.data) : null;
    this.trees.set(sha, entries);
    return entries;
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

/** @param {Buffer} data @returns {RawEntry[]} */
function parseTree(data) {
  /** @type {RawEntry[]} */
  const out = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(32, i);
    const nul = data.indexOf(0, space);
    const mode = data.subarray(i, space).toString();
    const name = data.subarray(space + 1, nul).toString();
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    i = nul + 21;
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    out.push({ mode: mode.padStart(6, '0'), type, name, sha });
  }
  return out;
}

/**
 * A recursive listing in git's order (`git ls-tree -r -t`), cut after `maxEntries` entries or
 * `maxBytes` of tree data (each entry as git stores it: mode, name and a 20-byte id).
 * @param {GitObjects} objs @param {string} sha @param {number} maxEntries @param {number} maxBytes
 */
async function walk(objs, sha, maxEntries, maxBytes) {
  /** @type {(RawEntry & { path: string })[]} */
  const entries = [];
  let bytes = 0;
  let truncated = false;
  /** @param {string} treeSha @param {string} prefix */
  const visit = async (treeSha, prefix) => {
    for (const e of (await objs.tree(treeSha)) ?? []) {
      bytes += e.mode.replace(/^0/, '').length + e.name.length + 22;
      if (entries.length >= maxEntries || bytes > maxBytes) {
        truncated = true;
        return;
      }
      entries.push({ ...e, path: prefix + e.name });
      if (e.type === 'tree') await visit(e.sha, `${prefix}${e.name}/`);
      if (truncated) return;
    }
  };
  await visit(sha, '');
  return { entries, truncated };
}

/** A blob size stand-in for clones without blobs: 33 B to 22 KB, log-uniform, fixed per sha. */
const sizeOf = (/** @type {string} */ sha) =>
  Math.round(Math.exp(3.5 + (6.5 * parseInt(sha.slice(0, 8), 16)) / 2 ** 32));

/** @param {RawEntry & { path: string }} e @param {string} base */
function treeEntry(e, base) {
  if (e.type === 'tree') {
    return {
      path: e.path,
      mode: e.mode,
      type: e.type,
      sha: e.sha,
      url: `${base}/git/trees/${e.sha}`,
    };
  }
  if (e.type === 'commit') return { path: e.path, mode: e.mode, type: e.type, sha: e.sha };
  return {
    path: e.path,
    mode: e.mode,
    type: e.type,
    sha: e.sha,
    size: sizeOf(e.sha),
    url: `${base}/git/blobs/${e.sha}`,
  };
}

/** A GraphQL-style node id, the length GitHub's are. @param {string} prefix @param {string} sha */
const nodeId = (prefix, sha) =>
  `${prefix}_kwDO${Buffer.from(sha.slice(0, 24), 'hex').toString('base64url')}${sha.slice(24, 32)}`;

/** A user object as GitHub nests it in commits, for a login. @param {string} login */
function user(login) {
  let id = 0;
  for (const c of login) id = (id * 31 + c.charCodeAt(0)) >>> 0;
  const url = `${API}/users/${encodeURIComponent(login)}`;
  return {
    login,
    id,
    node_id: `MDQ6VXNlcj${Buffer.from(String(id)).toString('base64')}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url,
    html_url: `${WEB}/${encodeURIComponent(login)}`,
    followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`,
    gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`,
    subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`,
    repos_url: `${url}/repos`,
    events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

/** A /commits list entry, shaped like GitHub's. @param {string} line @param {string} fullName */
function toCommit(line, fullName) {
  const [
    sha = '',
    tree = '',
    parents = '',
    an = '',
    ae = '',
    cn = '',
    ce = '',
    committed = '',
    authored = '',
    message = '',
  ] = line.split(SEP);
  const base = `${API}/repos/${fullName}`;
  return {
    sha,
    node_id: nodeId('C', sha),
    commit: {
      author: { name: an, email: ae, date: authored },
      committer: { name: cn, email: ce, date: committed },
      message: message.replace(/\n+$/, ''),
      tree: { sha: tree, url: `${base}/git/trees/${tree}` },
      url: `${base}/git/commits/${sha}`,
      comment_count: 0,
      verification: {
        verified: false,
        reason: 'unsigned',
        signature: null,
        payload: null,
        verified_at: null,
      },
    },
    url: `${base}/commits/${sha}`,
    html_url: `${WEB}/${fullName}/commit/${sha}`,
    comments_url: `${base}/commits/${sha}/comments`,
    // The login stands in as the author's name, as the core reads it.
    author: user(an),
    committer: user(cn),
    parents: parents
      .split(' ')
      .filter(Boolean)
      .map((p) => ({
        sha: p,
        url: `${base}/commits/${p}`,
        html_url: `${WEB}/${fullName}/commit/${p}`,
      })),
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
 * The files list of /commits/{sha}, from `git diff-tree --raw`. No patches (see the header).
 * @param {string} dir @param {string} sha @param {string} base
 */
async function changedFiles(dir, sha, base) {
  const args = ['diff-tree', '--root', '--no-commit-id', '-r', '--raw', '-z'];
  const out = await run(dir, [...args, '-M', sha]).catch(() => run(dir, [...args, sha]));
  const fields = out.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i] ?? '';
    if (!meta.startsWith(':')) continue;
    const [, , , dst = '', code = ''] = meta.slice(1).split(' ');
    const kind = code[0] ?? 'M';
    const two = kind === 'R' || kind === 'C';
    const a = fields[++i] ?? '';
    const b = two ? (fields[++i] ?? '') : undefined;
    const filename = b ?? a;
    const blobSha = kind === 'D' ? '0'.repeat(40) : dst;
    const file = {
      sha: blobSha,
      filename,
      status: STATUS[kind] ?? 'modified',
      additions: 0,
      deletions: 0,
      changes: 0,
      blob_url: `${WEB}/${base.slice(API.length + 7)}/blob/${sha}/${encodeURI(filename)}`,
      raw_url: `${WEB}/${base.slice(API.length + 7)}/raw/${sha}/${encodeURI(filename)}`,
      contents_url: `${base}/contents/${encodeURI(filename)}?ref=${sha}`,
      ...(b !== undefined ? { previous_filename: a } : {}),
    };
    files.push(file);
  }
  return files;
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
    const branch = (await run(dir, ['symbolic-ref', '--short', 'HEAD'])).trim();
    repos[name] = head ? { dir, branch, head } : { dir, branch };
  }
  const handle = gitHubFetch(repos, { log: (line) => console.error(line) });
  createServer(async (req, res) => {
    if (req.url === '/__stats') {
      // What scripts/measure.mjs --remote reads before and after a run.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handle.state));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = await handle(`http://localhost${req.url}`, {
      method: req.method,
      headers: /** @type {Record<string, string>} */ (req.headers),
      ...(req.method === 'GET' || req.method === 'HEAD'
        ? {}
        : { body: Buffer.concat(chunks).toString() }),
    });
    const body = Buffer.from(await reply.arrayBuffer());
    const headers = Object.fromEntries(reply.headers);
    delete headers['x-fake-gzip-bytes'];
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && body.length > 0;
    res.writeHead(reply.status, {
      ...headers,
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'link, x-ratelimit-remaining, x-ratelimit-reset',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(gzip ? gzipSync(body) : body);
  }).listen(Number(port), () =>
    console.error(`fake GitHub on :${port} for ${Object.keys(repos).join(', ')}`),
  );
}
