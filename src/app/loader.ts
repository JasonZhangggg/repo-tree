import { loadInWorker, type LoadSource } from '../load/load-in-worker';
import type { RepoRef } from '../repo/ref';
import { PALETTES } from '../render/palette';
import { leafCategories } from '../render/tree-view';
import { debug } from './debug';
import { sampleFor } from './samples';
import { qualityOf, type Repo, type Store } from './state';

const SEED = 42;
const KEEP = 4;

/**
 * Runs one load at a time: a new load aborts the one in flight. Grown repos stay in memory
 * (keyed by source, hidden folders and quality) so switching back is instant; `fresh` skips
 * that cache, the snapshot cache and the bundled samples. `select` pins a folder by path and
 * `highlight` a legend entry by label, each once the repo is ready and only if it has one.
 */
export function createLoader(store: Store) {
  const memory = new Map<string, Repo>();
  let inFlight: AbortController | null = null;
  let lastId = 0;

  async function load(
    ref: RepoRef,
    {
      fresh = false,
      select,
      highlight,
    }: { fresh?: boolean; select?: string; highlight?: string } = {},
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

    let repo = fresh ? undefined : memory.get(key);
    if (!repo) {
      try {
        const result = await loadInWorker(
          { source, filters: { hidden }, params: { seed: SEED, quality } },
          (step) => {
            if (step === 'build') debug.timings.loaded ??= performance.now();
            store.dispatch({ type: 'step', id, step });
          },
          abort.signal,
        );
        if ('kind' in result) return store.dispatch({ type: 'failed', id, error: result });
        const folderIds = new Map(result.tree.folders.path.map((path, i) => [path, i]));
        repo = { ...result, folderIds, sample: sample?.id };
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
      highlight: legend.some((e) => e.label === highlight) ? highlight : undefined,
    });
  }

  function cancel() {
    inFlight?.abort();
    store.dispatch({ type: 'cancel' });
  }

  return { load, cancel };
}
