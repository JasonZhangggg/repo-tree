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

  test("a sample's repo reloaded live falls back to the bundled history when none is shared", async () => {
    const body = readFileSync('public/samples/torvalds-linux.history.json.gz');
    vi.stubGlobal('indexedDB', undefined);
    const fetch = vi.fn(async (url: string) =>
      url.startsWith(SERVER)
        ? Response.json({ status: 'missing' }, { status: 404 })
        : new Response(body),
    );
    vi.stubGlobal('fetch', fetch);
    const linux = parseRepoRef('torvalds/linux') as RepoRef;
    const source = historySource(
      { info: { ref: linux, branch: 'master' } },
      { base: '/app/', server: SERVER },
    )!;
    const loaded = await source.load(signal);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      `${SERVER}/v1/history/torvalds/linux?branch=master`,
      '/app/samples/torvalds-linux.history.json.gz',
    ]);
    expect(loaded?.status === 'ready' && loaded.history.repo).toBe('torvalds/linux');
    // A signed-in visitor can still bring it up to date.
    expect(source.compute).not.toBeNull();
    expect(source.outdated).not.toBeNull();
  });

  test("a sample's repo on another branch does not use the bundled history", async () => {
    vi.stubGlobal('indexedDB', undefined);
    const fetch = vi.fn(async () => Response.json({ status: 'missing' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const linux = parseRepoRef('torvalds/linux') as RepoRef;
    const source = historySource(
      { info: { ref: linux, branch: 'next' } },
      { base: '/app/', server: SERVER },
    )!;
    expect(await source.load(signal)).toEqual({ status: 'missing' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("without a server, a sample's repo reloaded live still has the bundled history", () => {
    const linux = parseRepoRef('torvalds/linux') as RepoRef;
    const source = historySource({ info: { ref: linux, branch: 'master' } }, { server: undefined });
    expect(source).not.toBeNull();
    expect(source!.compute).toBeNull();
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

  test('hands a stored history to the worker to bring up to date', async () => {
    const stored = { v: 1, repo: 'acme/widgets', branch: 'main', head: 'a'.repeat(40) } as History;
    const sent: ComputeRequest[] = [];
    const worker = {
      onmessage: null as ((e: MessageEvent<ComputeMessage>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage: (data: ComputeRequest) => {
        sent.push(data);
        queueMicrotask(() =>
          worker.onmessage?.({
            data: { run: data.run, history: stored, snapshots: [] },
          } as unknown as MessageEvent<ComputeMessage>),
        );
      },
    };
    vi.stubGlobal('fetch', async () => Response.json({ status: 'stored' }, { status: 201 }));
    vi.stubGlobal('indexedDB', undefined);
    const source = historySource(
      { info: { ref, branch: 'main' } },
      { server: SERVER, api: 'https://github.test', spawn: () => worker },
    )!;
    await source.compute!({ token: 'gho_visitor', signal, base: stored });
    expect(sent[0]!.base).toBe(stored);
  });

  test('a branch link to a branch that is not the default is told so, before any run', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return Response.json({ default_branch: 'main' });
    });
    const spawn = vi.fn();
    const dev = { ...ref, ref: 'dev' };
    const source = historySource(
      { info: { ref: dev, branch: 'dev' } },
      { server: SERVER, api: 'https://github.test', spawn },
    )!;
    expect(await source.compute!({ token: 'gho_visitor', signal })).toEqual({
      status: 'error',
      error: { kind: 'not-default-branch', defaultBranch: 'main' },
    });
    expect(asked).toEqual(['https://github.test/repos/acme/widgets']);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a branch link to the default branch computes as usual', async () => {
    const history = { v: 1, repo: 'acme/widgets', branch: 'main' } as History;
    const worker = {
      onmessage: null as ((e: MessageEvent<ComputeMessage>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage: ({ run }: ComputeRequest) =>
        queueMicrotask(() =>
          worker.onmessage?.({
            data: { run, history, snapshots: [] },
          } as unknown as MessageEvent<ComputeMessage>),
        ),
    };
    vi.stubGlobal('fetch', async (url: string) =>
      url === 'https://github.test/repos/acme/widgets'
        ? Response.json({ default_branch: 'main' })
        : Response.json({ status: 'stored' }, { status: 201 }),
    );
    vi.stubGlobal('indexedDB', undefined);
    const main = { ...ref, ref: 'main' };
    const source = historySource(
      { info: { ref: main, branch: 'main' } },
      { server: SERVER, api: 'https://github.test', spawn: () => worker },
    )!;
    expect(await source.compute!({ token: 'gho_visitor', signal })).toEqual({
      status: 'ready',
      history,
      shared: 'stored',
    });
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
