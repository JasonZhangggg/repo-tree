import { byId } from '../dom';

const KEY = 'repo-tree:hint-seen';

/**
 * The "drag to orbit" hint fades out after the first gesture on the tree and stays gone. It keeps
 * its box, so the controls' footprint and the tree's framing don't jump when it goes.
 */
export function mountHint(): void {
  const hint = byId('help');
  const seen = () => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  };
  if (seen()) {
    hint.dataset.seen = '';
    return;
  }
  const done = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target?.closest('#view, #labels')) return;
    window.removeEventListener('pointerup', done);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Private mode: the hint just comes back next visit.
    }
    hint.dataset.seen = '';
  };
  window.addEventListener('pointerup', done);
}
