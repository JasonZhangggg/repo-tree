import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { historySource } from './source';

const ref = parseRepoRef('acme/widgets') as RepoRef;
const signal = new AbortController().signal;

afterEach(() => vi.unstubAllGlobals());

describe('historySource', () => {
  test('a repo that is no sample has no history without a server', () => {
    expect(historySource({ info: { ref, branch: 'main' } }, { server: undefined })).toBeNull();
  });

  test('a sample reads the history bundled beside it, whatever the server', async () => {
    const body = readFileSync('public/samples/mathiasbynens-dotfiles.history.json.gz');
    const fetch = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetch);
    const source = historySource(
      { sample: 'mathiasbynens-dotfiles', info: { ref, branch: 'main' } },
      { base: '/app/', server: undefined },
    );
    const history = await source!(signal);
    expect(fetch).toHaveBeenCalledWith('/app/samples/mathiasbynens-dotfiles.history.json.gz');
    expect(history?.repo).toBe('mathiasbynens/dotfiles');
  });

  test('a server that says to sign in gives no history', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'gho_visitor' });
    vi.stubGlobal('fetch', async () => Response.json({ status: 'needs-auth' }));
    const source = historySource(
      { info: { ref, branch: 'main' } },
      { server: 'https://history.example' },
    );
    expect(await source!(signal)).toBeNull();
  });
});
