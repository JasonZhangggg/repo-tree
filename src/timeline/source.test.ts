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

  test('computes in a worker with the token and the GitHub API, then shares the result', async () => {
    const history = { v: 1, repo: 'acme/widgets', branch: 'main' } as History;
    const sent: ComputeRequest[] = [];
    const worker = {
      onmessage: null as ((e: MessageEvent<ComputeMessage>) => void) | null,
      onerror: null,
      terminate: () => {},
      postMessage: (data: ComputeRequest) => {
        sent.push(data);
        queueMicrotask(() => {
          worker.onmessage?.({ data: { progress: 0.5 } } as MessageEvent<ComputeMessage>);
          worker.onmessage?.({
            data: { history, snapshots: [] },
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
      { api: 'https://github.test', repo: 'acme/widgets', branch: 'main', token: 'gho_visitor' },
    ]);
    expect(progress).toEqual([0.5]);
    expect(puts).toEqual([`PUT ${SERVER}/v1/history/acme/widgets?branch=main`]);
  });
});
