import type { RepoRef } from '../repo/ref';

export type Sample = {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  files: number;
};

/** Repos bundled in public/samples, so they grow with no network. */
export const SAMPLES: readonly Sample[] = [
  {
    id: 'mathiasbynens-dotfiles',
    label: 'dotfiles',
    owner: 'mathiasbynens',
    repo: 'dotfiles',
    branch: 'main',
    files: 36,
  },
  { id: 'vitejs-vite', label: 'vite', owner: 'vitejs', repo: 'vite', branch: 'main', files: 2916 },
  {
    id: 'torvalds-linux',
    label: 'linux',
    owner: 'torvalds',
    repo: 'linux',
    branch: 'master',
    files: 97359,
  },
];

export const FIRST_VISIT = SAMPLES[1]!;

/** The bundled snapshot that stands in for a ref on its default branch. */
export function sampleFor(ref: RepoRef): Sample | undefined {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return SAMPLES.find(
    (s) => same(s.owner, ref.owner) && same(s.repo, ref.repo) && (ref.ref ?? s.branch) === s.branch,
  );
}
