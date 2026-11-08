import { pullsKey, perchOf, type OpenPull, type OpenPulls } from '../repo/pulls';
import type { AppState } from './state';

/**
 * Plumage, one per author: the muted browns, greys and dusky blues of real songbirds, so birds
 * read as part of the scene rather than markers on it, and stay apart from bright leaves.
 */
export const PLUMAGE = [
  '#7d5f48', // sparrow
  '#5d6670', // slate junco
  '#8c857c', // dove
  '#566c86', // dusky bluebird
  '#6c6e4c', // olive warbler
  '#8a5848', // wren
  '#3f4045', // starling
] as const;
/** A draft is a fledgling: pale and not yet in its colors. */
export const FLEDGLING = '#cdc6bb';

/** One open pull request perched on the folder it changes most (perchOf). */
export type Bird = { pull: OpenPull; folder: number; color: string };

/** A stable color per author, so one person's PRs read as one kind of bird. */
export function plumageOf(author: string): string {
  let hash = 0;
  for (const c of author.toLowerCase()) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  return PLUMAGE[Math.abs(hash) % PLUMAGE.length]!;
}

/**
 * The repo on show's open pull requests as birds, most recently updated first. A PR that changes
 * no files has no perch and stays off the tree.
 */
export function birdsFrom(pulls: OpenPulls, folderIds: ReadonlyMap<string, number>): Bird[] {
  const birds: Bird[] = [];
  for (const pull of pulls.pulls) {
    const perch = perchOf(pull.files, (f) => folderIds.has(f));
    const folder = perch === null ? undefined : folderIds.get(perch);
    if (folder === undefined) continue;
    birds.push({ pull, folder, color: pull.draft ? FLEDGLING : plumageOf(pull.author) });
  }
  return birds;
}

/**
 * The repo on show's open PRs once read, or null: birds off, not read yet, or unreadable, or
 * while trees are compared, when birds on only one of them would read as a difference.
 */
export function pullsOf(state: AppState): OpenPulls | null {
  const { repo, settings } = state;
  if (!repo || !settings.birds || state.compare.length) return null;
  return state.pulls[pullsKey(repo.info.ref, repo.info.branch)] ?? null;
}

const memo = new WeakMap<OpenPulls, { folderIds: ReadonlyMap<string, number>; birds: Bird[] }>();
/** Birds for the state, the same array while its pulls and tree stay, so views can compare. */
export function birdsOf(state: AppState): Bird[] | null {
  const pulls = pullsOf(state);
  if (!pulls || !state.repo) return null;
  const hit = memo.get(pulls);
  if (hit?.folderIds === state.repo.folderIds) return hit.birds;
  const birds = birdsFrom(pulls, state.repo.folderIds);
  memo.set(pulls, { folderIds: state.repo.folderIds, birds });
  return birds;
}

/** What a PR's changed paths are on the tree on show. */
export type PullFiles = {
  /** Per RepoIndex file: 1 where the PR changes it. */
  lit: Uint8Array;
  /** Changed files with a leaf or rock on the tree. */
  shown: number;
  /** Changed paths the tree lacks: new in the PR, or in a hidden folder. */
  missing: number;
};

const pathIds = new WeakMap<readonly string[], Map<string, number>>();
/** Each file path's RepoIndex id, built once per tree. */
function idsOf(paths: readonly string[]): Map<string, number> {
  let ids = pathIds.get(paths);
  if (!ids) {
    ids = new Map(paths.map((path, i) => [path, i]));
    pathIds.set(paths, ids);
  }
  return ids;
}

/** The files a PR changes, marked on the tree's own file ids. */
export function pullFiles(files: readonly string[], paths: readonly string[]): PullFiles {
  const ids = idsOf(paths);
  const lit = new Uint8Array(paths.length);
  let shown = 0;
  for (const file of files) {
    const id = ids.get(file);
    if (id === undefined || lit[id]) continue;
    lit[id] = 1;
    shown++;
  }
  return { lit, shown, missing: new Set(files).size - shown };
}
