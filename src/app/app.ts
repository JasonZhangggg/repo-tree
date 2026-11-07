import type { RepoRef } from '../repo/ref';
import type { TreeView } from '../render/tree-view';
import type { Selection, Store } from './state';

/** A folder pinned on a compared tree: its index in companionsOf, and that tree's folder id. */
export type CompanionPin = { companion: number; folder: number };

/** What the UI modules may do; main.ts composes it. */
export type App = {
  store: Store;
  view: TreeView;
  load(
    ref: RepoRef,
    options?: { fresh?: boolean; select?: string; highlight?: string; timeline?: number },
  ): void;
  cancelLoad(): void;
  /** Pins a folder (or one of its files) or clears the pin; `frame` glides the camera to it. */
  select(selection: Selection | null, frame?: boolean): void;
  /**
   * Previews a folder's highlight while the pointer is over it: on the tree on show, or on a
   * compared tree, by its index in companionsOf.
   */
  hover(folder: number | null, companion?: number): void;
  /**
   * Pins a folder of a compared tree (by its index in companionsOf) in place, the grove kept in
   * view, as a click on the tree on show pins one of its own; or clears that pin. A pin of the
   * tree on show (select) clears it too.
   */
  pinCompanion(pin: CompanionPin | null): void;
  /** The folder pinned on a compared tree, if any. */
  companionPin(): CompanionPin | null;
  /** Calls back whenever the compared tree's pin is set or let go. */
  onCompanionPin(listener: () => void): void;
  /** Highlights the leaves of one legend entry, by label, or clears the highlight. */
  highlight(label: string | null): void;
  /** Previews a legend entry's highlight while the pointer is over it. */
  hoverCategory(label: string | null): void;
  openSettings(focus?: 'token' | 'hidden'): void;
  /** Signs in with GitHub (from a click), then reads again what the old limit may have cost. */
  signIn(): void;
  /** Reads the repo on show's CI runs again, past the cache. */
  refreshRuns(): void;
  openSearch(): void;
  toast(message: string): void;
};

export const githubUrl = (
  ref: { owner: string; repo: string },
  branch?: string,
  path = '',
  kind = 'tree',
) =>
  `https://github.com/${ref.owner}/${ref.repo}${branch ? `/${kind}/${branch}${path ? `/${path}` : ''}` : ''}`;

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
