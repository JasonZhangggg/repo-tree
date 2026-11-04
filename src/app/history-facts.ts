import { historyFacts } from '../timeline/facts';
import { historySource } from '../timeline/source';
import { needsHistory, type Store } from './state';

/**
 * Loads the history of the repo on show once something needs it, and lays it over the tree.
 * It only reads what is stored (the history cache keeps it for six hours): computing a missing
 * history is the timeline's offer, so a repo without one says so and keeps language colors.
 */
export function watchHistory(store: Store): void {
  let abort: AbortController | null = null;
  const check = () => {
    const state = store.get();
    const { repo } = state;
    if (!repo || !needsHistory(state) || state.history?.repo === repo) return;
    abort?.abort();
    const source = historySource(repo);
    if (!source)
      return store.dispatch({ type: 'history', history: { repo, status: 'unavailable' } });
    const mine = (abort = new AbortController());
    store.dispatch({ type: 'history', history: { repo, status: 'loading' } });
    source.load(mine.signal).then(
      (loaded) => {
        if (mine.signal.aborted) return;
        if (loaded?.status === 'ready') {
          const facts = historyFacts(loaded.history, repo.tree, repo.index);
          store.dispatch({ type: 'history', history: { repo, status: 'ready', facts } });
        } else {
          const status = loaded?.status === 'missing' ? 'missing' : 'unavailable';
          store.dispatch({ type: 'history', history: { repo, status } });
        }
      },
      () => {},
    );
  };
  // After the change that asked has reached every listener, never in the middle of it.
  store.subscribe(() => queueMicrotask(check));
  check();
}
