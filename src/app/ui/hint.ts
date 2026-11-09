import { byId } from '../dom';

const KEY = 'repo-tree:hint-closed';

/**
 * The "drag to orbit" tip stays beside the controls until its close button is pressed, and then
 * stays gone on later visits. Closed, it keeps its box, so the controls' footprint and the tree's
 * framing don't jump.
 */
export function mountHint(): void {
  const hint = byId('help');
  let closed = false;
  try {
    closed = localStorage.getItem(KEY) === '1';
  } catch {
    // Private mode: the tip shows, and closing it lasts until the page reloads.
  }
  if (closed) {
    hint.dataset.closed = '';
    return;
  }
  byId('help-close').addEventListener('click', () => {
    hint.dataset.closed = '';
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Private mode: the tip comes back next visit.
    }
  });
}
