import { AGES } from '../timeline/facts';
import { cachedRuns, cacheRuns } from '../load/cache';
import { loadInWorker, type LoadSource } from '../load/load-in-worker';
import { ciKey, fetchRuns, loadSampleRuns } from '../repo/ci';
import type { RepoRef } from '../repo/ref';
import { PALETTES } from '../render/palette';
import { leafCategories } from '../render/tree-view';
import { debug } from './debug';
import { sampleFor, type Sample } from './samples';
import { qualityOf, type Repo, type Store } from './state';

const SEED = 42;
const KEEP = 4;

/**
 * Runs one load at a time: a new load aborts the one in flight. Grown repos stay in memory
 * (keyed by source, hidden folders and quality) so switching back is instant; `fresh` skips
 * that cache, the snapshot cache and the bundled samples. `select` pins a folder by path and
 * `highlight` a legend entry by label, each once the repo is ready and only if it has one;
 * `timeline` opens the timeline at that date.
 * Each load also reads the repo's recent Actions runs for its weather, beside the tree and as
 * soon as the branch is known, so the tree never waits on them.
 */
export function createLoader(store: Store) {
  const memory = new Map<string, Repo>();
  let inFlight: AbortController | null = null;
  let lastId = 0;
  let runsInFlight: { key: string; abort: AbortController } | null = null;

  async function loadRuns(
    ref: RepoRef,
    branch: string,
    { sample, token, fresh }: { sample?: Sample; token?: string; fresh: boolean },
  ) {
    const key = ciKey(ref, branch);
    if (runsInFlight?.key === key) return;
    if (!fresh && store.get().ci[key]) return;
    const abort = new AbortController();
    runsInFlight = { key, abort };
    try {
      const base = new URL('./', location.href).href;
      let runs = sample
        ? await loadSampleRuns(sample.id, branch, base)
        : fresh
          ? undefined
          : await cachedRuns(key);
      if (runs === undefined) {
        runs = await fetchRuns(ref, branch, token, abort.signal);
        if (runs) void cacheRuns(key, runs);
      }
      store.dispatch({ type: 'ci', key, runs });
    } catch {
      // Aborted by a load of another repo, which reads its own.
    } finally {
      if (runsInFlight?.abort === abort) runsInFlight = null;
    }
  }

  async function load(
    ref: RepoRef,
    {
      fresh = false,
      select,
      highlight,
      timeline,
    }: { fresh?: boolean; select?: string; highlight?: string; timeline?: number } = {},
  ) {
    inFlight?.abort();
    const abort = (inFlight = new AbortController());
    const id = ++lastId;
    store.dispatch({ type: 'load', id, ref });

    const state = store.get();
    const { hidden, token } = state.settings;
    const quality = qualityOf(state);
    const sample = fresh ? undefined : sampleFor(ref);
    const source: LoadSource = sample
      ? { kind: 'sample', id: sample.id, base: new URL('./', location.href).href }
      : { kind: 'github', ref, token: token || undefined, fresh };
    const name = sample?.id ?? `${ref.owner}/${ref.repo}@${ref.ref ?? ''}`.toLowerCase();
    const key = `${name}|${hidden.join('/')}|${quality}`;
    const runsFor = (branch: string) => {
      if (runsInFlight && runsInFlight.key !== ciKey(ref, branch)) runsInFlight.abort.abort();
      void loadRuns(ref, branch, { sample, token: token || undefined, fresh });
    };
    const branch = sample?.branch ?? ref.ref;
    if (branch !== undefined) runsFor(branch);

    let repo = fresh ? undefined : memory.get(key);
    if (!repo) {
      try {
        const result = await loadInWorker(
          { source, filters: { hidden }, params: { seed: SEED, quality } },
          {
            step(step) {
              if (step === 'build') debug.timings.loaded ??= performance.now();
              store.dispatch({ type: 'step', id, step });
            },
            branch(name) {
              if (branch === undefined) runsFor(name);
            },
          },
          abort.signal,
        );
        if ('kind' in result) return store.dispatch({ type: 'failed', id, error: result });
        const folderIds = new Map(result.tree.folders.path.map((path, i) => [path, i]));
        repo = { ...result, folderIds, sample: sample?.id };
        if (branch === undefined) runsFor(result.info.branch);
      } catch (error) {
        if (abort.signal.aborted) return;
        console.error(error);
        return store.dispatch({ type: 'failed', id, error: { kind: 'unexpected' } });
      }
    }
    memory.delete(key);
    memory.set(key, repo);
    if (memory.size > KEEP) memory.delete(memory.keys().next().value!);
    const folder = select === undefined ? undefined : repo.folderIds.get(select);
    const { colorBy, palette } = store.get().settings;
    const { legend } = leafCategories(repo.tree, colorBy, PALETTES[palette]);
    store.dispatch({
      type: 'loaded',
      id,
      repo,
      selection: folder === undefined ? null : { folder },
      // Activity bands are known before the history that fills them arrives.
      highlight:
        legend.some((e) => e.label === highlight) ||
        (colorBy === 'activity' && AGES.some((a) => a.label === highlight))
          ? highlight
          : undefined,
      timeline,
    });
  }

  function cancel() {
    inFlight?.abort();
    store.dispatch({ type: 'cancel' });
  }

  return { load, cancel };
}
