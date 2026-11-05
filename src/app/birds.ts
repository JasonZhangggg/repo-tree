import { pullsKey, perchOf, type OpenPull, type OpenPulls } from '../repo/pulls';
import type { AppState } from './state';

/**
 * Plumage, one per author: mostly cool and deep, so birds stand apart from autumn and spring
 * leaves, and readable against both the day and the night sky.
 */
export const PLUMAGE = [
  '#2a5bd7', // bluebird
  '#0f9aa8', // kingfisher
  '#7446c9', // martin
  '#2a2c38', // blackbird
  '#c62828', // cardinal
  '#e6b31e', // goldfinch
] as const;
/** A draft is a fledgling: pale and not yet in its colors. */
export const FLEDGLING = '#c9c3b8';

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

/** The repo on show's open PRs once read, or null: birds off, not read yet, or unreadable. */
export function pullsOf(state: AppState): OpenPulls | null {
  const { repo, settings } = state;
  if (!repo || !settings.birds) return null;
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
