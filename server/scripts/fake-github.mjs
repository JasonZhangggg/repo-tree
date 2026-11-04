#!/usr/bin/env node
// A stand-in for the parts of the GitHub REST API that history reads, answered from local git
// repositories. Tests and scripts/measure.mjs import `gitHubFetch`; run it as a script to serve
// it over HTTP:
//   node scripts/fake-github.mjs <port> <owner/repo>=<git dir>[@<head sha>] ...
// Every request is logged to stderr as `<status> <path>`. POST /__head {repo, sha} moves a
// branch head (null: back to the git repo's), as a push would.
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
// - Optionally (`latency`), each answer also takes GitHub's own time to make, which does not
//   hold the link: `GITHUB_LATENCY` models what real runs show (REST 150 to 400 ms, a recursive
//   tree more by its size; GraphQL 0.8 to 3 s for 100 trees, by how many entries they hold).
// - REST and GraphQL keep separate budgets (`remaining`, `graphqlRemaining`), each answer naming
//   its own in x-ratelimit-resource. GraphQL fails the ways GitHub's does: a spent budget is 200
//   with a RATE_LIMITED error; secondary limits come as 403 or as 200 with their message; a query
//   past the time limit is 200 with an error, or a 502 or 504 (`graphqlTimeoutStatus`); a reply
//   can be partial, some objects null beside errors. `graphqlFaults` plays them in order.
// - It serves git's smart HTTP fetch too (POST /<owner>/<repo>.git/git-upload-pack, protocol
//   v2), from `git upload-pack --stateless-rpc` on the local clone, the pack streamed back at
//   link speed after GitHub's time to make it (`GITHUB_LATENCY.packMs` and `packPerMBMs`).
//   FAKE_GIT_CACHE keeps made packs on disk by request, as git takes 17 s over Linux's.
// Known gaps: clones made with --filter=blob:none have no blobs, so blob `size` is a stand-in
// derived from the sha (33 B to 22 KB, log-uniform), and /commits/{sha} files carry no `patch`
// (real ones do, so real per-commit bodies are larger than these).
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const SEP = '\x01';
const FIELDS = ['%H', '%T', '%P', '%an', '%ae', '%cn', '%ce', '%cI', '%aI', '%B'].join('%x01');

/**
 * @typedef {{ dir: string, branch?: string, head?: string, private?: boolean }} FakeRepo
 * @typedef {{ rttMs: number, bytesPerMs: number }} Network
 * @typedef {{ restMs: [number, number], restPerItemMs: number, graphqlMs: number,
 *   graphqlPerObjectMs: number, graphqlPerEntryMs: number, jitter: [number, number],
 *   packMs?: number, packPerMBMs?: number, seed?: number }} Latency
 * @typedef {{ maxEntries?: number, maxTreeBytes?: number, remaining?: number, tokens?: string[],
 *   graphqlMaxEntries?: number, login?: string, graphqlRemaining?: number,
 *   graphqlTimeoutStatus?: 200 | 502 | 504, graphqlFaults?: GraphQLFault[], resetInS?: number,
 *   inject?: (url: URL, init: RequestInit) => Promise<{ status: number, body: unknown, kind: string, type?: string, extra: Record<string, string> } | undefined> | undefined,
 *   log?: (line: string) => void, network?: Network, latency?: Latency, gzipLevel?: number }} FakeOptions
 * @typedef {{ requests: number, bytes: number, raw: number }} Tally
 * @typedef {{ mode: string, type: 'blob' | 'tree' | 'commit', name: string, sha: string }} RawEntry
 * @typedef {'rate-limited' | 'secondary-403' | 'secondary-200' | 'timeout-200' | 'timeout-502'
 *   | 'timeout-504' | 'partial'} GraphQLFault
 */

/**
 * GitHub's time to answer, as real runs from a browser show it: REST 150 to 400 ms (a recursive
 * listing of Linux, 90k entries, about 2 s more); GraphQL about 0.8 s for 100 small trees and 3 s
 * for 100 that hold 100k entries between them, each give or take a fifth. A git fetch answers
 * its shallow lines after 300 ms and starts the pack after about 106 ms per MB of it (measured
 * from this sandbox, 2026-11: supabase, 51 commits, 5.3 MB: pack at 0.93 s, done 1.25 s;
 * Linux, 65 commits, 47 MB: pack at 5.3 s, done 8.1 s).
 * @type {Latency}
 */
export const GITHUB_LATENCY = {
  restMs: [150, 400],
  restPerItemMs: 0.02,
  graphqlMs: 400,
  graphqlPerObjectMs: 4,
  graphqlPerEntryMs: 0.022,
  jitter: [0.8, 1.2],
  packMs: 300,
  packPerMBMs: 106,
};

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
    graphqlRemaining: options.graphqlRemaining ?? 5000,
    /** When the budgets reset, in seconds (GitHub: an hour from the first request). */
    resetAt: Math.floor(Date.now() / 1000) + (options.resetInS ?? 3600),
    /** GraphQL faults still to play, one per query. */
    faults: [...(options.graphqlFaults ?? [])],
    requests: 0,
    /** Gzipped body bytes, as they would cross the wire. */
    bytes: 0,
    /** Uncompressed body bytes. */
    raw: 0,
    /** Request body bytes sent up (GraphQL queries), uncompressed as browsers send them. */
    up: 0,
    /** @type {Record<string, Tally>} */
    kinds: {},
    /** Most requests in flight at once. */
    peakInFlight: 0,
    /** Tree entries answered over GraphQL. */
    graphqlEntries: 0,
    /** GitHub's modelled time making answers (`latency`), summed over requests. */
    serverMs: 0,
    inFlight: 0,
  };
  /** @type {Map<string, GitObjects>} */
  const objects = new Map();
  const network = options.network;
  const latency = options.latency;
  let linkFreeAt = 0;
  // A seeded generator, so a measured run is repeatable.
  let seed = latency?.seed ?? 1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  /** How long GitHub takes to make an answer of this kind and size, in ms. */
  function serverMs(/** @type {string} */ kind, /** @type {unknown} */ body) {
    if (!latency) return 0;
    const b = /** @type {any} */ (body);
    const [lo, hi] = latency.jitter;
    const jitter = lo + (hi - lo) * random();
    if (kind === 'graphql') {
      const objects = Object.values(b?.data?.repository ?? {});
      const entries = objects.reduce(
        (n, o) =>
          n +
          (Array.isArray(/** @type {any} */ (o)?.entries)
            ? /** @type {any} */ (o).entries.length
            : 0),
        0,
      );
      return (
        jitter *
        (latency.graphqlMs +
          latency.graphqlPerObjectMs * objects.length +
          latency.graphqlPerEntryMs * entries)
      );
    }
    const [min, max] = latency.restMs;
    const items = Array.isArray(b?.tree)
      ? b.tree.length
      : Array.isArray(b?.files)
        ? b.files.length
        : Array.isArray(b)
          ? b.length
          : 0;
    return min + (max - min) * random() + latency.restPerItemMs * items;
  }

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
      if (url.pathname.endsWith('.git/git-upload-pack'))
        return await uploadPack(url, headers, init);
      const { status, body, kind, type, extra } = url.pathname.startsWith('/login/oauth/')
        ? oauth(url, String(init.body ?? ''))
        : ((await options.inject?.(url, init)) ??
          (await answer(url, headers, String(init.body ?? ''))));
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const gz = text ? gzipSync(text, { level: gzipLevel }) : Buffer.alloc(0);
      const tally = (state.kinds[kind] ??= { requests: 0, bytes: 0, raw: 0 });
      tally.requests++;
      tally.bytes += gz.length;
      tally.raw += Buffer.byteLength(text);
      const sent = init.body ? Buffer.byteLength(String(init.body)) : 0;
      tally.up = (tally.up ?? 0) + sent;
      state.up += sent;
      state.bytes += gz.length;
      state.raw += Buffer.byteLength(text);
      options.log?.(`${status} ${url.pathname}${url.search.replace(/code=[^&]*/, 'code=…')}`);
      const made = serverMs(kind, body);
      state.serverMs = (state.serverMs ?? 0) + made;
      if (network || made > 0) await delay(gz.length, signal, made);
      const res = new Response(status === 302 ? null : text, {
        status,
        headers: {
          ...(type ? { 'content-type': type } : {}),
          ...limits(state, kind === 'graphql' ? 'graphql' : 'core'),
          ...extra,
          'x-fake-gzip-bytes': String(gz.length),
        },
      });
      return res;
    } finally {
      state.inFlight--;
    }
  };

  /**
   * git's smart HTTP fetch, protocol v2, as github.com answers it: the shallow lines after a
   * round trip and GitHub's 300 ms, then the pack after its making time, at link speed.
   * @param {URL} url @param {Headers} headers @param {RequestInit} init
   */
  async function uploadPack(url, headers, init) {
    const signal = init.signal ?? undefined;
    const m = /^\/([^/]+)\/([^/]+)\.git\/git-upload-pack$/.exec(url.pathname);
    const name = m ? `${m[1]}/${m[2]}` : '';
    const found = Object.entries(repos).find(([k]) => k.toLowerCase() === name.toLowerCase());
    const auth = headers.get('authorization') ?? '';
    const basic = auth.startsWith('Basic ')
      ? (Buffer.from(auth.slice(6), 'base64').toString().split(':')[1] ?? '')
      : '';
    const fail = (/** @type {number} */ status, /** @type {string} */ text) => {
      options.log?.(`${status} ${url.pathname}`);
      return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
    };
    if (options.tokens && !options.tokens.includes(basic)) return fail(401, 'Bad credentials');
    if (!found || (found[1].private && !basic)) return fail(404, 'Repository not found.');
    if (headers.get('git-protocol') !== 'version=2') return fail(400, 'protocol v2 only');
    const body = Buffer.from(
      typeof init.body === 'string' ? init.body : /** @type {Uint8Array} */ (init.body ?? []),
    );
    const out = await packFor(found[1].dir, body);
    const tally = (state.kinds.pack ??= { requests: 0, bytes: 0, raw: 0 });
    tally.requests++;
    tally.bytes += out.length;
    tally.raw += out.length;
    tally.up = (tally.up ?? 0) + body.length;
    state.up += body.length;
    state.bytes += out.length;
    state.raw += out.length;
    options.log?.(`200 ${url.pathname}`);
    // The sections up to `packfile`, then the pack's side band.
    const mark = out.indexOf('000dpackfile\n');
    const at = mark >= 0 ? mark + 13 : 0;
    const head = out.subarray(0, at);
    const rest = out.subarray(at);
    const made = latency
      ? (latency.packMs ?? 0) + ((latency.packPerMBMs ?? 0) * rest.length) / 1e6
      : 0;
    state.serverMs = (state.serverMs ?? 0) + made;
    const first = latency ? (latency.packMs ?? 0) : 0;
    // The shallow lines come first, then the pack once made, 64 KiB at a time on the link. The
    // chunks go on the link's own schedule, whether or not the reader keeps up (a browser's
    // network buffers ahead of the page), so reading overlaps the download as it would.
    await delay(head.length, signal, first);
    const stream = new ReadableStream({
      async start(controller) {
        try {
          if (head.length) controller.enqueue(new Uint8Array(head));
          let at = performance.now() + Math.max(0, made - first);
          for (let sent = 0; sent < rest.length; sent += 65536) {
            const chunk = rest.subarray(sent, sent + 65536);
            at = await linkAt(chunk.length, at, signal);
            controller.enqueue(new Uint8Array(chunk));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-git-upload-pack-result' },
    });
  }

  /**
   * Sends `bytes` on the shared link no sooner than `notBefore` and waits until they are across;
   * returns when that was, on the link's clock (a late timer does not hold the link up).
   * @param {number} bytes @param {number} notBefore @param {AbortSignal | undefined} signal
   */
  async function linkAt(bytes, notBefore, signal) {
    const bytesPerMs = network?.bytesPerMs ?? Infinity;
    const start = Math.max(notBefore, linkFreeAt);
    linkFreeAt = start + bytes / bytesPerMs;
    const end = linkFreeAt;
    const wait = end - performance.now();
    if (wait > 0) await sleep(wait, signal);
    return end;
  }

  /** Waits a round trip and GitHub's time to answer, then for the body's turn on the shared link. */
  function delay(
    /** @type {number} */ bytes,
    /** @type {AbortSignal | undefined} */ signal,
    /** @type {number} */ made = 0,
  ) {
    const { rttMs, bytesPerMs } = network ?? { rttMs: 0, bytesPerMs: Infinity };
    const now = performance.now();
    const start = Math.max(now + rttMs + made, linkFreeAt);
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

  /** @param {URL} url @param {Headers} headers @param {string} body */
  async function answer(url, headers, body) {
    const auth = headers.get('authorization') ?? '';
    if (options.tokens && !options.tokens.some((t) => auth === `Bearer ${t}`)) {
      return reply({ message: 'Bad credentials' }, 401, 'error');
    }
    if (url.pathname === '/graphql') return graphql(headers, body);
    if (state.remaining <= 0) return reply({ message: 'API rate limit exceeded' }, 403, 'error');
    state.remaining--;
    if (url.pathname === '/user') {
      // The signed-in user: whoever holds the token (the history Worker checks it on upload).
      if (!auth) return reply({ message: 'Requires authentication' }, 401, 'user');
      return reply({ login: options.login ?? 'visitor', id: 1, type: 'User' }, 200, 'user');
    }
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
        const named = q.get('sha');
        // A pinned head stands for the branch, whether named or implied.
        const start = (named === branch || !named ? config.head : undefined) ?? named ?? branch;
        const per = Math.min(100, Number(q.get('per_page') ?? 30));
        const page = Number(q.get('page') ?? 1);
        const until = q.get('until');
        const committer = q.get('committer');
        const range = [
          start,
          ...(until ? [`--until=${until}`] : []),
          // GitHub matches a login or an exact email; git matches a pattern on name <email>.
          ...(committer
            ? [`--committer=<${committer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`]
            : []),
        ];
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
        // Counting is slow on big histories, and only the unfiltered one-per-page listing (the
        // root probe) has its Link read.
        const total =
          per === 1 && !committer ? Number((await git('rev-list', '--count', ...range)).trim()) : 0;
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
        const all = commit.parents.length > 1 ? [] : await changedFiles(config.dir, sha, base);
        // GitHub lists 300 files a page (per_page lowers it), up to 3,000 in all.
        const per = Math.min(300, Number(q.get('per_page') ?? 300));
        const page = Number(q.get('page') ?? 1);
        const capped = all.slice(0, 3000);
        const files = capped.slice((page - 1) * per, page * per);
        const pages = Math.ceil(capped.length / per);
        const extra = /** @type {Record<string, string>} */ ({});
        if (pages > 1) {
          const at = (/** @type {number} */ n) => {
            const link = new URL(url);
            link.searchParams.set('page', String(n));
            return link.href;
          };
          const rels = [];
          if (page < pages)
            rels.push(`<${at(page + 1)}>; rel="next"`, `<${at(pages)}>; rel="last"`);
          if (page > 1) rels.push(`<${at(1)}>; rel="first"`, `<${at(page - 1)}>; rel="prev"`);
          extra.link = rels.join(', ');
        }
        return reply(
          { ...commit, stats: { total: 0, additions: 0, deletions: 0 }, files },
          200,
          'commit',
          extra,
        );
      }
      const gitCommit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (gitCommit) {
        const found = await objs.read(gitCommit[1] ?? '');
        if (!found || found.type !== 'commit') return reply({ message: 'Not Found' }, 404, 'error');
        const line = (
          await git('log', '-z', '-1', gitCommit[1] ?? '', `--format=${FIELDS}`)
        ).replace(/\0$/, '');
        const { sha, commit, parents } = toCommit(line, fullName);
        return reply(
          {
            sha,
            node_id: nodeId('C', sha),
            url: `${base}/git/commits/${sha}`,
            author: commit.author,
            committer: commit.committer,
            tree: commit.tree,
            message: commit.message,
            parents,
            verification: commit.verification,
          },
          200,
          'git-commit',
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

  /**
   * GitHub's GraphQL endpoint, for the one query shape the tree reader sends: aliased
   * `object(oid:)` lookups with `... on Tree { entries { <fields> } }` under one repository.
   * A query whose trees hold more than `graphqlMaxEntries` entries fails the way GitHub's do
   * when they run past their time limit (200 with errors and null data).
   * @param {Headers} headers @param {string} raw
   */
  async function graphql(headers, raw) {
    if (!headers.get('authorization')) {
      return reply({ message: 'This endpoint requires you to be authenticated.' }, 401, 'graphql');
    }
    const fault = state.faults.shift();
    if (state.graphqlRemaining <= 0 || fault === 'rate-limited') {
      return reply(
        {
          data: null,
          errors: [
            { type: 'RATE_LIMITED', message: 'API rate limit already exceeded for user ID 1.' },
          ],
        },
        200,
        'graphql',
        { 'x-ratelimit-remaining': '0' },
      );
    }
    state.graphqlRemaining--;
    const secondary =
      'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.';
    if (fault === 'secondary-403') {
      return reply({ message: secondary }, 403, 'graphql', { 'retry-after': '30' });
    }
    if (fault === 'secondary-200') {
      return reply({ data: null, errors: [{ message: secondary }] }, 200, 'graphql');
    }
    if (fault === 'timeout-502' || fault === 'timeout-504') {
      return timeout(Number(fault.slice(-3)));
    }
    /** @type {string} */
    let query;
    try {
      query = String(JSON.parse(raw).query ?? '');
    } catch {
      return reply({ message: 'Problems parsing JSON' }, 400, 'graphql');
    }
    const repoMatch = /repository\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\)/.exec(query);
    const name = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : '';
    const found = Object.entries(repos).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (!found) {
      return reply(
        {
          data: { repository: null },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository'],
              message: `Could not resolve to a Repository with the name '${name}'.`,
            },
          ],
        },
        200,
        'graphql',
      );
    }
    const [, config] = found;
    let objs = objects.get(config.dir);
    if (!objs) objects.set(config.dir, (objs = new GitObjects(config.dir)));
    const fields = (/entries\s*\{([^}]*)\}/.exec(query)?.[1] ?? 'name oid').trim().split(/\s+/);
    /** @type {Record<string, unknown>} */
    const out = {};
    // The history Worker's check of a pack request: the repo's visibility, each want's type.
    if (/\bisPrivate\b/.test(query)) out.isPrivate = config.private ?? false;
    const typed = /object\([^)]*\)\s*\{\s*__typename\s*\}/.test(query);
    const TYPENAME = /** @type {Record<string, string>} */ ({
      commit: 'Commit',
      tree: 'Tree',
      blob: 'Blob',
      tag: 'Tag',
    });
    let total = 0;
    for (const [, alias = '', oid = ''] of query.matchAll(
      /(\w+)\s*:\s*object\(\s*oid:\s*"([0-9a-f]{40})"\s*\)/g,
    )) {
      if (typed) {
        const any = await objs.read(oid);
        out[alias] = any ? { __typename: TYPENAME[any.type] ?? 'Blob' } : null;
        continue;
      }
      const tree = await objs.tree(oid);
      if (!tree) {
        const any = await objs.read(oid);
        out[alias] = any ? {} : null;
        continue;
      }
      total += tree.length;
      out[alias] = {
        entries: tree.map((e) => {
          /** @type {Record<string, unknown>} */
          const entry = {};
          for (const f of fields) {
            if (f === 'name') entry.name = e.name;
            else if (f === 'oid') entry.oid = e.sha;
            else if (f === 'mode') entry.mode = parseInt(e.mode, 8);
            else if (f === 'type') entry.type = e.type;
          }
          return entry;
        }),
      };
    }
    state.graphqlEntries = (state.graphqlEntries ?? 0) + total;
    if (total > (options.graphqlMaxEntries ?? 50_000) || fault === 'timeout-200') {
      return timeout(fault === 'timeout-200' ? 200 : (options.graphqlTimeoutStatus ?? 200));
    }
    if (fault === 'partial') {
      // The first half of the objects come back null, each with an error, beside the rest.
      const aliases = Object.keys(out);
      const lost = aliases.slice(0, Math.ceil(aliases.length / 2));
      for (const alias of lost) out[alias] = null;
      return reply(
        {
          data: { repository: out },
          errors: lost.map((alias) => ({
            path: ['repository', alias],
            message: 'Something went wrong while executing your query.',
          })),
        },
        200,
        'graphql',
      );
    }
    return reply({ data: { repository: out } }, 200, 'graphql');
  }

  /** A query past GitHub's ten seconds: 200 with an error and null data, or a gateway's 502/504. */
  function timeout(/** @type {number} */ status) {
    if (status !== 200) {
      return {
        status,
        body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
        kind: 'graphql',
        type: 'text/html',
        extra: {},
      };
    }
    return reply(
      {
        data: null,
        errors: [
          {
            message:
              'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug. Please include `0000:FAKE` when reporting this issue.',
          },
        ],
      },
      200,
      'graphql',
    );
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

/** @param {number} ms @param {AbortSignal | undefined} signal */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
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

/**
 * `git upload-pack --stateless-rpc` answering a v2 request, as github.com would (any sha may be
 * wanted, filters allowed). FAKE_GIT_CACHE keeps the answers on disk by request.
 * @param {string} dir @param {Buffer} body @returns {Promise<Buffer>}
 */
function packFor(dir, body) {
  const cacheDir = process.env.FAKE_GIT_CACHE;
  const file = cacheDir
    ? join(cacheDir, `pack-${createHash('sha1').update(dir).update(body).digest('hex')}`)
    : '';
  if (file && existsSync(file)) return Promise.resolve(readFileSync(file));
  return new Promise((resolve, reject) => {
    const git = spawn(
      'git',
      [
        '-c',
        'uploadpack.allowFilter=true',
        '-c',
        'uploadpack.allowAnySHA1InWant=true',
        'upload-pack',
        '--stateless-rpc',
        dir,
      ],
      {
        env: { ...process.env, GIT_PROTOCOL: 'version=2', GIT_NO_LAZY_FETCH: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    /** @type {Buffer[]} */
    const parts = [];
    git.stdout.on('data', (c) => parts.push(c));
    git.on('error', reject);
    git.on('close', () => {
      const out = Buffer.concat(parts);
      if (file && out.includes('PACK')) {
        mkdirSync(cacheDir ?? '', { recursive: true });
        writeFileSync(file, out);
      }
      resolve(out);
    });
    git.stdin.end(body);
  });
}

/** @param {string} dir @param {string[]} args @returns {Promise<string>} */
function run(dir, args) {
  // FAKE_GIT_CACHE=<dir>: keep history walks (log, rev-list) on disk, so a measured run times
  // the engine and the modelled network rather than git walking a big history.
  const cacheDir = process.env.FAKE_GIT_CACHE;
  if (cacheDir && (args[0] === 'log' || args[0] === 'rev-list')) {
    const file = join(
      cacheDir,
      createHash('sha1')
        .update(JSON.stringify([dir, args]))
        .digest('hex'),
    );
    if (existsSync(file)) return Promise.resolve(readFileSync(file, 'utf8'));
    return runGit(dir, args).then((out) => {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, out);
      return out;
    });
  }
  return runGit(dir, args);
}

/** @param {string} dir @param {string[]} args @returns {Promise<string>} */
function runGit(dir, args) {
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

/**
 * @param {{ remaining: number, graphqlRemaining: number, resetAt: number }} state
 * @param {'core' | 'graphql'} resource
 */
function limits(state, resource) {
  const left = resource === 'graphql' ? state.graphqlRemaining : state.remaining;
  return {
    'x-ratelimit-remaining': String(Math.max(0, left)),
    'x-ratelimit-reset': String(state.resetAt),
    'x-ratelimit-resource': resource,
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
  // FAKE_REMAINING: the token's request budget (GitHub: 5,000 an hour).
  const remaining = Number(process.env.FAKE_REMAINING ?? 5000);
  // FAKE_NETWORK=<rtt ms>,<bytes per ms>: a slow link, to watch progress (verify-repo-tree).
  const [rttMs, bytesPerMs] = (process.env.FAKE_NETWORK ?? '').split(',').map(Number);
  const network = rttMs && bytesPerMs ? { rttMs, bytesPerMs } : undefined;
  // FAKE_LATENCY=github: GitHub's own time per answer (GITHUB_LATENCY).
  const latency = process.env.FAKE_LATENCY === 'github' ? GITHUB_LATENCY : undefined;
  const handle = gitHubFetch(repos, {
    log: (line) => console.error(line),
    remaining,
    ...(network ? { network } : {}),
    ...(latency ? { latency } : {}),
  });
  createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST',
        'access-control-allow-headers':
          'authorization, content-type, user-agent, x-github-api-version',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    const staticDir = process.env.FAKE_STATIC;
    if (staticDir && req.url?.startsWith('/__static/')) {
      // A page and worker bundle served from this origin, to measure the engine in a browser.
      const file = join(staticDir, req.url.slice('/__static/'.length).split('?')[0] ?? '');
      try {
        const bytes = readFileSync(file);
        const type = file.endsWith('.html') ? 'text/html' : 'text/javascript';
        // Cross-origin isolated, so the page can call performance.measureUserAgentSpecificMemory.
        res.writeHead(200, {
          'content-type': type,
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (req.url === '/__head' && req.method === 'POST') {
      // Moves a repo's branch head, as a push would: {"repo": "owner/name", "sha": "<sha>" | null}
      // (null: back to the git repo's own head). For e2e runs of an out-of-date history.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { repo, sha } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const config = repos[repo];
      if (!config) res.writeHead(404);
      else {
        if (sha) config.head = sha;
        else delete config.head;
        res.writeHead(204, { 'access-control-allow-origin': '*' });
      }
      res.end();
      return;
    }
    if (req.url === '/__stats') {
      // What scripts/measure.mjs --remote reads before and after a run.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handle.state));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const pack = req.url?.endsWith('.git/git-upload-pack') ?? false;
    const reply = await handle(`http://localhost${req.url}`, {
      method: req.method,
      headers: /** @type {Record<string, string>} */ (req.headers),
      ...(req.method === 'GET' || req.method === 'HEAD'
        ? {}
        : { body: pack ? Buffer.concat(chunks) : Buffer.concat(chunks).toString() }),
    });
    if (pack && reply.ok && reply.body) {
      // Streamed as it is paced, never gzipped (a pack is compressed already).
      res.writeHead(200, Object.fromEntries(reply.headers));
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (reply.body)) {
        res.write(chunk);
      }
      res.end();
      return;
    }
    const body = Buffer.from(await reply.arrayBuffer());
    const headers = Object.fromEntries(reply.headers);
    delete headers['x-fake-gzip-bytes'];
    const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && body.length > 0;
    res.writeHead(reply.status, {
      ...headers,
      'access-control-allow-origin': '*',
      'access-control-expose-headers':
        'link, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-resource, retry-after',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(gzip ? gzipSync(body) : body);
  }).listen(Number(port), () =>
    console.error(`fake GitHub on :${port} for ${Object.keys(repos).join(', ')}`),
  );
}
