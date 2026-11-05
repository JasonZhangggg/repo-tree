import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { decode, fetchSnapshot, loadSample } from './github';
import { parseRepoRef, type RepoRef } from './ref';

type Call = { url: string; headers: Headers };

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: new Headers(init?.headers) });
    if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    return respond(input);
  });
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const ref = (input: string) => parseRepoRef(input) as RepoRef;

const REPO = { full_name: 'octo/demo', default_branch: 'trunk' };
const TREE = {
  sha: 'f00d',
  url: 'https://api.github.com/repos/octo/demo/git/trees/f00d',
  truncated: false,
  tree: [
    { path: 'README.md', mode: '100644', type: 'blob', sha: 'a1', size: 120 },
    { path: 'src', mode: '040000', type: 'tree', sha: 'b2' },
    { path: 'src/main.ts', mode: '100644', type: 'blob', sha: 'c3', size: 2048 },
    { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'd4' },
  ],
};

function github(tree: unknown = TREE) {
  return fakeFetch((url) =>
    url.includes('/git/trees/')
      ? json(tree)
      : url.endsWith('/repos/octo/demo')
        ? json(REPO)
        : json({}, 404),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSnapshot', () => {
  test('reads the default branch, then its recursive tree, keeping files only', async () => {
    const calls = github();

    const snapshot = await fetchSnapshot(ref('octo/demo'));

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/octo/demo',
      'https://api.github.com/repos/octo/demo/git/trees/trunk?recursive=1',
    ]);
    expect(snapshot).toMatchObject({
      ref: { owner: 'octo', repo: 'demo' },
      branch: 'trunk',
      sha: 'f00d',
      truncated: false,
      files: [
        { path: 'README.md', size: 120 },
        { path: 'src/main.ts', size: 2048 },
      ],
    });
  });

  test('sends the API version headers and no Authorization without a token', async () => {
    const calls = github();

    await fetchSnapshot(ref('octo/demo'));

    for (const { headers } of calls) {
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(headers.has('authorization')).toBe(false);
    }
  });

  test('sends the token as a Bearer credential on every request', async () => {
    const calls = github();

    await fetchSnapshot(ref('octo/demo'), 'ghp_secret');

    expect(calls).toHaveLength(2);
    for (const { headers } of calls) expect(headers.get('authorization')).toBe('Bearer ghp_secret');
  });

  test('goes straight to the tree when the ref names a branch', async () => {
    const calls = github();

    const snapshot = await fetchSnapshot(ref('https://github.com/octo/demo/tree/feat/a b'));

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/octo/demo/git/trees/feat/a%20b?recursive=1',
    ]);
    expect(snapshot).toMatchObject({ branch: 'feat/a b' });
  });

  test('reads a tree GitHub cut short a folder at a time, down to where listings fit', async () => {
    const trees: Record<string, unknown> = {
      // The whole tree, cut short.
      'trunk?recursive=1': { ...TREE, truncated: true, tree: TREE.tree.slice(0, 2) },
      // Its own entries: a file, two folders and a submodule.
      f00d: {
        sha: 'f00d',
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', sha: 'a1', size: 120 },
          { path: 'big', type: 'tree', sha: 'b1' },
          { path: 'src', type: 'tree', sha: 'b2' },
          { path: 'vendor', type: 'commit', sha: 'd4' },
        ],
      },
      'b2?recursive=1': {
        sha: 'b2',
        truncated: false,
        tree: [
          { path: 'main.ts', type: 'blob', sha: 'c3', size: 2048 },
          { path: 'lib', type: 'tree', sha: 'c4' },
          { path: 'lib/x.ts', type: 'blob', sha: 'c5', size: 7 },
        ],
      },
      // Still too big: listed plainly, then its folder whole.
      'b1?recursive=1': { sha: 'b1', truncated: true, tree: [] },
      b1: {
        sha: 'b1',
        truncated: false,
        tree: [
          { path: 'a.txt', type: 'blob', sha: 'e1', size: 1 },
          { path: 'deep', type: 'tree', sha: 'e2' },
        ],
      },
      'e2?recursive=1': {
        sha: 'e2',
        truncated: false,
        tree: [{ path: 'z.txt', type: 'blob', sha: 'e3', size: 2 }],
      },
    };
    const calls = fakeFetch((url) => {
      const key = url.split('/git/trees/')[1];
      return key === undefined ? json(REPO) : key in trees ? json(trees[key]) : json({}, 404);
    });

    const snapshot = await fetchSnapshot(ref('octo/demo'));

    expect(snapshot).toMatchObject({
      truncated: false,
      files: [
        { path: 'README.md', size: 120 },
        { path: 'big/a.txt', size: 1 },
        { path: 'big/deep/z.txt', size: 2 },
        { path: 'src/lib/x.ts', size: 7 },
        { path: 'src/main.ts', size: 2048 },
      ],
    });
    expect(calls).toHaveLength(7);
  });

  test('keeps the partial tree when reading it in parts fails', async () => {
    fakeFetch((url) =>
      url.endsWith('?recursive=1') && url.includes('/git/trees/trunk')
        ? json({ ...TREE, truncated: true })
        : url.includes('/git/trees/')
          ? json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' })
          : json(REPO),
    );

    expect(await fetchSnapshot(ref('octo/demo'))).toMatchObject({
      truncated: true,
      files: [
        { path: 'README.md', size: 120 },
        { path: 'src/main.ts', size: 2048 },
      ],
    });
  });

  test.each([
    ['a tree without files', { ...TREE, tree: [TREE.tree[1]] }],
    ['a tree holding only a submodule', { ...TREE, tree: [TREE.tree[3]] }],
  ])('maps %s to empty', async (_, tree) => {
    github(tree);

    expect(await fetchSnapshot(ref('octo/demo'))).toEqual({ kind: 'empty' });
  });

  test('maps the 409 GitHub sends for a repository with no commits to empty', async () => {
    fakeFetch((url) =>
      url.includes('/git/trees/')
        ? json({ message: 'Git Repository is empty.', status: '409' }, 409)
        : json(REPO),
    );

    expect(await fetchSnapshot(ref('octo/demo'))).toEqual({ kind: 'empty' });
  });

  test.each([
    [
      'missing or private repository',
      json({ message: 'Not Found', status: '404' }, 404, { 'x-ratelimit-remaining': '59' }),
      { kind: 'not-found' },
    ],
    [
      'bad token',
      json({ message: 'Bad credentials', status: '401' }, 401),
      { kind: 'unauthorized' },
    ],
    [
      'exhausted primary rate limit',
      json({ message: 'API rate limit exceeded for 203.0.113.7.' }, 403, {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1762200000',
        'x-ratelimit-resource': 'core',
      }),
      { kind: 'rate-limited', resetAt: 1762200000_000 },
    ],
    [
      'exhausted rate limit answered with 429',
      json({ message: 'API rate limit exceeded' }, 429, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1762203600',
      }),
      { kind: 'rate-limited', resetAt: 1762203600_000 },
    ],
    [
      'forbidden with quota left',
      json({ message: 'Resource not accessible by personal access token' }, 403, {
        'x-ratelimit-remaining': '4999',
      }),
      { kind: 'unauthorized' },
    ],
    ['server error', json({ message: 'Server Error' }, 502), { kind: 'network' }],
    ['a body that is not JSON', new Response('<html>', { status: 200 }), { kind: 'network' }],
    ['JSON of the wrong shape', json({ tree: 'nope' }), { kind: 'network' }],
  ])('maps %s', async (_, response, expected) => {
    fakeFetch(() => response);

    expect(await fetchSnapshot(ref('octo/demo'))).toEqual(expected);
  });

  test('maps a failed request to network', async () => {
    fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));

    expect(await fetchSnapshot(ref('octo/demo'))).toEqual({ kind: 'network' });
  });

  test('rejects with the abort instead of reporting a load error', async () => {
    github();
    const controller = new AbortController();
    controller.abort();

    await expect(fetchSnapshot(ref('octo/demo'), undefined, controller.signal)).rejects.toThrow(
      /abort/i,
    );
  });
});

describe('loadSample', () => {
  const gz = readFileSync(
    new URL('../../public/samples/mathiasbynens-dotfiles.json.gz', import.meta.url),
  );

  test.each([
    ['gzip bytes, as GitHub Pages serves them', gz],
    ['bytes the browser already decoded, as vite preview serves them', gunzipSync(gz)],
  ])('reads %s', async (_, body) => {
    const calls = fakeFetch(() => new Response(body));

    const snapshot = await loadSample('mathiasbynens-dotfiles');

    expect(calls[0]?.url).toMatch(/(^|\/)samples\/mathiasbynens-dotfiles\.json\.gz$/);
    expect(snapshot).toMatchObject({
      ref: { owner: 'mathiasbynens', repo: 'dotfiles' },
      branch: 'main',
      sha: '249695a4e88d9c36c8f7f8f1be62e3036997efea',
      truncated: false,
    });
    expect(snapshot).toHaveProperty('files.length', 36);
    expect(snapshot).toHaveProperty('files.0', { path: '.aliases', size: 6317 });
  });
});

describe('decode', () => {
  const text = 'x'.repeat(5000);
  const gz = gzipSync(text);
  const buffer = (b: Uint8Array) =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

  test('unpacks gzip and passes plain text through', async () => {
    expect(await decode(buffer(gz))).toBe(text);
    expect(await decode(buffer(new TextEncoder().encode('{"a":1}')))).toBe('{"a":1}');
  });

  test('stops past the limit, unpacked or not', async () => {
    await expect(decode(buffer(gz), 4999)).rejects.toThrow(RangeError);
    await expect(decode(buffer(new TextEncoder().encode(text)), 10)).rejects.toThrow(RangeError);
    expect(await decode(buffer(gz), 5000)).toBe(text);
  });
});
