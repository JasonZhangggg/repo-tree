import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_INFLATED_BYTES,
  snapshotDigest,
  type StoredManifest,
  type UploadManifest,
} from '../../server/src/shape';
import { fetchHistory, parseHistory, uploadHistory, type History } from './history';
import { parseRepoRef, type RepoRef } from './ref';

const ref = parseRepoRef('vitejs/vite') as RepoRef;
const BASE = 'https://history.example';

const history: History = {
  v: 1,
  repo: 'vitejs/vite',
  branch: 'main',
  head: 'a'.repeat(40),
  computedAt: 5,
  gaps: [],
  recent: { since: 3, commits: 1 },
  snapshots: [{ sha: 'a'.repeat(40), at: 4 }],
  files: { path: ['a.ts'], changed: [4], born: [1], churn: [0], commits: [1] },
  folders: { path: [''], changed: [4], born: [1], churn: [0], commits: [1] },
  gone: [],
  owners: [{ folder: '', authors: [{ name: 'ada', commits: 1, weight: 0 }], codeowners: [] }],
};

afterEach(() => vi.unstubAllGlobals());

async function manifestFor(
  h: History,
  extra: Partial<StoredManifest> = {},
): Promise<StoredManifest> {
  return {
    v: 1,
    repo: h.repo,
    branch: h.branch,
    head: h.head,
    computedAt: h.computedAt,
    snapshots: h.snapshots.length,
    digest: await snapshotDigest(h.snapshots),
    bytes: 1,
    by: 'ada',
    storedAt: 9,
    ...extra,
  };
}

/** The Worker's GET: the gzipped history (or `body`), its manifest in a header. POSTs listed. */
function stored(h: unknown, manifest: StoredManifest | null, body?: Uint8Array<ArrayBuffer>) {
  const urls: string[] = [];
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return Response.json({ status: 'noted' }, { status: 202 });
      }
      urls.push(url);
      return new Response(body ?? gzipSync(JSON.stringify(h)), {
        headers: manifest ? { 'X-History-Manifest': JSON.stringify(manifest) } : {},
      });
    }),
  );
  return { urls, posts };
}

describe('fetchHistory', () => {
  test('is off without a server URL', async () => {
    const { urls } = stored(history, null);
    expect(await fetchHistory(ref, 'main', { base: '' })).toBeNull();
    expect(urls).toEqual([]);
  });

  test('reads a stored history that agrees with the manifest the server checked', async () => {
    const { urls } = stored(
      { ...history, branch: 'feat/x' },
      await manifestFor({ ...history, branch: 'feat/x' }),
    );
    const got = await fetchHistory(ref, 'feat/x', { base: `${BASE}/` });
    expect(got).toEqual({ status: 'ready', history: { ...history, branch: 'feat/x' } });
    expect(urls).toEqual([`${BASE}/v1/history/vitejs/vite?branch=feat%2Fx`]);
  });

  test('says missing when nobody computed it yet', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ status: 'missing' }, { status: 404 }));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual({ status: 'missing' });
  });

  test('takes a body that does not agree with its manifest for missing, and reports it', async () => {
    const missing = { status: 'missing' };
    const report = `${BASE}/v1/history/vitejs/vite/bad?branch=main&head=${history.head}`;
    const other = { ...history, snapshots: [{ sha: 'b'.repeat(40), at: 4 }] };
    let calls = stored(other, await manifestFor(history));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual(missing);
    expect(calls.posts).toEqual([report]);
    calls = stored(history, await manifestFor(history, { head: 'c'.repeat(40) }));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual(missing);
    expect(calls.posts).toEqual([report.replace(history.head, 'c'.repeat(40))]);
    calls = stored(history, null);
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual(missing);
    expect(calls.posts).toEqual([]);
    stored({ ...history, repo: 'evil/repo' }, await manifestFor({ ...history, repo: 'evil/repo' }));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual(missing);
  });

  test('takes a malformed or unreadable body for missing too', async () => {
    const broken = { ...history, files: { ...history.files, born: [] } };
    let calls = stored(broken, await manifestFor(history));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual({ status: 'missing' });
    expect(calls.posts).toHaveLength(1);
    const junk = new Uint8Array(new ArrayBuffer(64)).fill(7);
    junk.set([0x1f, 0x8b]);
    calls = stored(null, await manifestFor(history), junk);
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual({ status: 'missing' });
    expect(calls.posts).toHaveLength(1);
  });

  test('stops unpacking a gzip bomb past the cap, and takes it for missing', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1024 * 1024)));
    const calls = stored(null, await manifestFor(history), bomb);
    expect(await fetchHistory(ref, 'main', { base: BASE })).toEqual({ status: 'missing' });
    expect(calls.posts).toHaveLength(1);
  });

  test('fails soft on server errors and the network', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ status: 'error', error: 'upstream' }, { status: 502 }),
    );
    expect(await fetchHistory(ref, 'main', { base: BASE })).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await fetchHistory(ref, 'main', { base: BASE })).toBeNull();
  });

  test('rejects on abort', async () => {
    const abort = new AbortController();
    vi.stubGlobal(
      'fetch',
      (_: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason)),
        ),
    );
    const done = fetchHistory(ref, 'main', { base: BASE, signal: abort.signal });
    abort.abort();
    await expect(done).rejects.toBeDefined();
  });
});

describe('uploadHistory', () => {
  const snapshots = [{ sha: 'a'.repeat(40), at: 4, tree: 't'.repeat(40) }];

  test('sends the gzipped history and its manifest, with the token, to the server only', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Response.json({ status: 'stored' }, { status: 201 });
    });
    expect(await uploadHistory(history, snapshots, 'gho_x', { base: BASE })).toBe('stored');
    const [url, init] = calls[0]!;
    expect(url).toBe(`${BASE}/v1/history/vitejs/vite?branch=main`);
    expect(init.method).toBe('PUT');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gho_x');
    const body = init.body as Uint8Array;
    expect(JSON.parse(gunzipSync(body).toString())).toEqual(history);
    const manifest = JSON.parse(headers['X-History-Manifest']!) as UploadManifest;
    expect(manifest).toEqual({
      v: 1,
      repo: 'vitejs/vite',
      branch: 'main',
      head: history.head,
      computedAt: 5,
      snapshots,
      bytes: body.byteLength,
    });
  });

  test('says why the server would not store it', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ status: 'error', error: 'exists' }, { status: 409 }),
    );
    expect(await uploadHistory(history, snapshots, 'gho_x', { base: BASE })).toBe('exists');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await uploadHistory(history, snapshots, 'gho_x', { base: BASE })).toBe('network');
  });
});

describe('parseHistory', () => {
  test('accepts a well-formed history and refuses other versions', () => {
    expect(parseHistory(history)).toEqual(history);
    expect(parseHistory({ ...history, v: 2 })).toBeNull();
    expect(parseHistory({ ...history, folders: { ...history.folders, churn: ['x'] } })).toBeNull();
  });
});

describe('sample histories', () => {
  test.each(['mathiasbynens-dotfiles', 'vitejs-vite', 'torvalds-linux'])(
    '%s covers every file of its bundled tree',
    (id) => {
      const read = (file: string) =>
        JSON.parse(gunzipSync(readFileSync(`public/samples/${file}`)).toString());
      const history = parseHistory(read(`${id}.history.json.gz`));
      expect(history).not.toBeNull();
      const tree = read(`${id}.json.gz`) as { tree: { tree: { path: string; type: string }[] } };
      const files = tree.tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
      expect(new Set(history!.files.path)).toEqual(new Set(files));
    },
  );
});
