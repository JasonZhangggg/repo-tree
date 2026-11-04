import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ComputeMessage, ComputeRequest } from '../repo/compute-history';
import type { History } from '../repo/history';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { historySource } from './source';

const ref = parseRepoRef('acme/widgets') as RepoRef;
const signal = new AbortController().signal;
const SERVER = 'https://history.example';

afterEach(() => vi.unstubAllGlobals());

describe('historySource', () => {
  test('a repo that is no sample has no history without a server', () => {
    expect(historySource({ info: { ref, branch: 'main' } }, { server: undefined })).toBeNull();
  });

  test('a sample reads the history bundled beside it, and offers no computing', async () => {
    const body = readFileSync('public/samples/mathiasbynens-dotfiles.history.json.gz');
    const fetch = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetch);
    const source = historySource(
      { sample: 'mathiasbynens-dotfiles', info: { ref, branch: 'main' } },
      { base: '/app/', server: undefined },
    )!;
    const loaded = await source.load(signal);
    expect(fetch).toHaveBeenCalledWith('/app/samples/mathiasbynens-dotfiles.history.json.gz');
    expect(loaded?.status === 'ready' && loaded.history.repo).toBe('mathiasbynens/dotfiles');
    expect(source.compute).toBeNull();
  });

  test('a branch nobody computed is missing, with no token sent', async () => {
    const fetch = vi.fn(async () => Response.json({ status: 'missing' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const source = historySource({ info: { ref, branch: 'main' } }, { server: SERVER })!;
    expect(await source.load(signal)).toEqual({ status: 'missing' });
    expect(fetch.mock.calls[0]).toEqual([
      `${SERVER}/v1/history/acme/widgets?branch=main`,
      { signal },
    ]);
  });

  test('computes in a worker with the token, the GitHub API and the pack route, then shares the result', async () => {
    const history = { v: 1, repo: 'acme/widgets', branch: 'main' } as History;
    const sent: ComputeRequest[] = [];
    const worker = {
      onmessage: null as ((e: MessageEvent<ComputeMessage>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage: (data: ComputeRequest) => {
        sent.push(data);
        const { run } = data;
        queueMicrotask(() => {
          worker.onmessage?.({ data: { run, progress: 0.5 } } as MessageEvent<ComputeMessage>);
          worker.onmessage?.({
            data: { run, history, snapshots: [] },
          } as unknown as MessageEvent<ComputeMessage>);
        });
      },
    };
    const puts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      puts.push(`${init.method} ${url}`);
      return Response.json({ status: 'stored' }, { status: 201 });
    });
    vi.stubGlobal('indexedDB', undefined);
    const source = historySource(
      { info: { ref, branch: 'main' } },
      { server: SERVER, api: 'https://github.test', spawn: () => worker },
    )!;
    const progress: number[] = [];
    const outcome = await source.compute!({
      token: 'gho_visitor',
      signal,
      onProgress: (p) => progress.push(p),
    });
    expect(outcome).toEqual({ status: 'ready', history, shared: 'stored' });
    expect(sent).toEqual([
      {
        run: expect.any(Number),
        api: 'https://github.test',
        repo: 'acme/widgets',
        branch: 'main',
        token: 'gho_visitor',
        packUrl: `${SERVER}/v1/git/acme/widgets/git-upload-pack`,
      },
    ]);
    expect(progress).toEqual([0.5]);
    expect(puts).toEqual([`PUT ${SERVER}/v1/history/acme/widgets?branch=main`]);
  });

  test('a branch named in the link is read, but not offered to compute', () => {
    const dev = { ...ref, ref: 'dev' };
    const source = historySource({ info: { ref: dev, branch: 'dev' } }, { server: SERVER })!;
    expect(source.load).toBeTypeOf('function');
    expect(source.compute).toBeNull();
    expect(source.outdated).toBeNull();
  });

  test('a stored history over a day old is outdated when GitHub names another head', async () => {
    const asked: [string, RequestInit][] = [];
    let head = 'b'.repeat(40);
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      asked.push([url, init]);
      return new Response(head);
    });
    const source = historySource(
      { info: { ref, branch: 'main' } },
      { server: SERVER, api: 'https://github.test' },
    )!;
    const old = { head: 'a'.repeat(40), computedAt: Date.now() - 2 * 24 * 3600_000 } as History;
    expect(await source.outdated!(old, 'gho_visitor', signal)).toBe(true);
    expect(asked[0]![0]).toBe('https://github.test/repos/acme/widgets/commits/main');
    expect(asked[0]![1].headers).toMatchObject({ Authorization: 'Bearer gho_visitor' });
    head = old.head;
    expect(await source.outdated!(old, 'gho_visitor', signal)).toBe(false);
    const fresh = { ...old, computedAt: Date.now() - 3600_000 };
    expect(await source.outdated!(fresh, 'gho_visitor', signal)).toBe(false);
    expect(asked).toHaveLength(2);
  });
});
