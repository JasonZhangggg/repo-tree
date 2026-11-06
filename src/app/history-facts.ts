import type { Loaded } from '../load/load-in-worker';
import { historyFacts } from '../timeline/facts';
import { historySource } from '../timeline/source';
import { needsHistory, type HistoryFacts, type Store } from './state';

/**
 * Loads the history of the repo on show, and of each one compared beside it, once something
 * needs it, and lays it over the tree. It only reads what is stored (the history cache keeps it
 * for six hours): computing a missing history is the timeline's offer, so a repo without one
 * says so and keeps language colors.
 */
export function watchHistory(store: Store): void {
  const main = watchOne(
    store,
    (state) => state.repo,
    (state) => state.history?.repo,
    (history) => store.dispatch({ type: 'history', history: history as HistoryFacts }),
  );
  /** One reader per compared repo, dropped with it. */
  const others = new Map<Loaded, () => void>();
  const companions = () => {
    const state = store.get();
    for (const companion of others.keys()) {
      if (!state.companions.includes(companion)) others.delete(companion);
    }
    for (const companion of state.companions) {
      if (!others.has(companion)) {
        others.set(
          companion,
          watchOne(
            store,
            (now) => (now.companions.includes(companion) ? companion : null),
            (now) => now.companionHistory.find((h) => h.repo === companion)?.repo,
            (history) => store.dispatch({ type: 'companion-history', history }),
          ),
        );
      }
      others.get(companion)!();
    }
  };
  // After the change that asked has reached every listener, never in the middle of it.
  store.subscribe(() =>
    queueMicrotask(() => {
      main();
      companions();
    }),
  );
  main();
  companions();
}

function watchOne(
  store: Store,
  repoOf: (state: ReturnType<Store['get']>) => Loaded | null,
  readFor: (state: ReturnType<Store['get']>) => Loaded | undefined,
  put: (history: HistoryFacts<Loaded>) => void,
): () => void {
  let abort: AbortController | null = null;
  return () => {
    const state = store.get();
    const repo = repoOf(state);
    if (!repo || !needsHistory(state) || readFor(state) === repo) return;
    abort?.abort();
    const source = historySource(repo);
    if (!source) return put({ repo, status: 'unavailable' });
    const mine = (abort = new AbortController());
    put({ repo, status: 'loading' });
    source.load(mine.signal).then(
      (loaded) => {
        if (mine.signal.aborted) return;
        if (loaded?.status === 'ready') {
          const facts = historyFacts(loaded.history, repo.tree, repo.index);
          put({ repo, status: 'ready', facts });
        } else {
          put({ repo, status: loaded?.status === 'missing' ? 'missing' : 'unavailable' });
        }
      },
      () => {},
    );
  };
}
