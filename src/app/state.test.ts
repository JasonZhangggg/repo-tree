import { describe, expect, test } from 'vitest';
import type { Loaded } from '../load/load-in-worker';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { DEFAULT_SETTINGS } from './settings';
import { createStore, qualityOf, reduce, type AppState, type Repo } from './state';

const ref = (input: string) => parseRepoRef(input) as RepoRef;
const INITIAL: AppState = {
  load: { phase: 'idle' },
  repo: null,
  selection: null,
  notice: null,
  settings: DEFAULT_SETTINGS,
  autoQuality: 'medium',
};
const repo = (name: string, truncated = false) =>
  ({ info: { ref: ref(name), truncated }, folderIds: new Map() }) as unknown as Repo & Loaded;

const run = (...actions: Parameters<typeof reduce>[1][]) => actions.reduce(reduce, INITIAL);

describe('loading', () => {
  test('walks fetch, build and grow, then shows the repo', () => {
    const shown = repo('a/one');
    const loading = run(
      { type: 'load', id: 1, ref: ref('a/one') },
      { type: 'step', id: 1, step: 'grow' },
    );
    expect(loading.load).toEqual({ phase: 'loading', id: 1, ref: ref('a/one'), step: 'grow' });

    const ready = reduce(loading, { type: 'loaded', id: 1, repo: shown, selection: { folder: 3 } });
    expect(ready).toMatchObject({ load: { phase: 'idle' }, repo: shown, selection: { folder: 3 } });
  });

  test('keeps the shown repo while the next one loads and when it fails', () => {
    const first = repo('a/one');
    const loading = run(
      { type: 'load', id: 1, ref: ref('a/one') },
      { type: 'loaded', id: 1, repo: first, selection: { folder: 2 } },
      { type: 'load', id: 2, ref: ref('a/two') },
    );
    expect(loading.repo).toBe(first);
    expect(loading.selection).toEqual({ folder: 2 });

    const failed = reduce(loading, { type: 'failed', id: 2, error: { kind: 'not-found' } });
    expect(failed.load).toEqual({
      phase: 'error',
      ref: ref('a/two'),
      error: { kind: 'not-found' },
    });
    expect(failed.repo).toBe(first);
    expect(reduce(failed, { type: 'dismiss-error' }).load).toEqual({ phase: 'idle' });
  });

  test('ignores steps and results from a load that a newer one replaced', () => {
    const replaced = run(
      { type: 'load', id: 1, ref: ref('a/one') },
      { type: 'load', id: 2, ref: ref('a/two') },
    );
    expect(reduce(replaced, { type: 'step', id: 1, step: 'grow' })).toBe(replaced);
    expect(reduce(replaced, { type: 'loaded', id: 1, repo: repo('a/one'), selection: null })).toBe(
      replaced,
    );
    expect(reduce(replaced, { type: 'failed', id: 1, error: { kind: 'network' } })).toBe(replaced);
  });

  test('cancel stops the load and drops its late result', () => {
    const cancelled = run({ type: 'load', id: 1, ref: ref('a/one') }, { type: 'cancel' });
    expect(cancelled.load).toEqual({ phase: 'idle' });
    expect(reduce(cancelled, { type: 'loaded', id: 1, repo: repo('a/one'), selection: null })).toBe(
      cancelled,
    );
  });

  test('raises the truncated notice once per repo', () => {
    const truncated = run(
      { type: 'load', id: 1, ref: ref('a/big') },
      { type: 'loaded', id: 1, repo: repo('a/big', true), selection: null },
    );
    expect(truncated.notice).toBe('truncated');
    expect(reduce(truncated, { type: 'dismiss-notice' }).notice).toBeNull();
    const next = reduce(reduce(truncated, { type: 'load', id: 2, ref: ref('a/small') }), {
      type: 'loaded',
      id: 2,
      repo: repo('a/small'),
      selection: null,
    });
    expect(next.notice).toBeNull();
  });
});

test('settings merge and auto quality resolves', () => {
  const state = run(
    { type: 'settings', patch: { palette: 'winter' } },
    { type: 'auto-quality', quality: 'low' },
  );
  expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, palette: 'winter' });
  expect(qualityOf(state)).toBe('low');
  expect(qualityOf(reduce(state, { type: 'settings', patch: { quality: 'high' } }))).toBe('high');
});

test('the store notifies with the previous state only on change', () => {
  const store = createStore(INITIAL);
  const seen: [string, string][] = [];
  store.subscribe((state, prev) => seen.push([prev.load.phase, state.load.phase]));
  store.dispatch({ type: 'cancel' });
  store.dispatch({ type: 'load', id: 1, ref: ref('a/b') });
  expect(seen).toEqual([['idle', 'loading']]);
});
