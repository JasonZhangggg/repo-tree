import type { RepoRef } from '../repo/ref';
import type { TreeView } from '../render/tree-view';
import type { Selection, Store } from './state';

/** What the UI modules may do; main.ts composes it. */
export type App = {
  store: Store;
  view: TreeView;
  load(ref: RepoRef, options?: { fresh?: boolean; select?: string }): void;
  cancelLoad(): void;
  /** Pins a folder (or one of its files) or clears the pin; `frame` glides the camera to it. */
  select(selection: Selection | null, frame?: boolean): void;
  /** Previews a folder's highlight while the pointer is over it. */
  hover(folder: number | null): void;
  openSettings(focus?: 'token' | 'hidden'): void;
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
