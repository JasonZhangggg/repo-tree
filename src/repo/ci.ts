import type { RepoRef } from './ref';

/** One finished GitHub Actions run on the default branch: did it pass, and when did it end. */
export type CiRun = { passed: boolean; at: number };
/**
 * The scene's weather. `clear` means no CI to report on (no runs, or Actions is off), so it
 * claims nothing either way.
 */
export type Sky = 'clear' | 'sunny' | 'cloudy' | 'rain' | 'storm';
export const SKIES: readonly Sky[] = ['clear', 'sunny', 'cloudy', 'rain', 'storm'];

export type CiHealth = {
  sky: Sky;
  /** Runs that passed or failed, newest first; cancelled and skipped runs do not count. */
  runs: number;
  passed: number;
  /** Failures in a row, counted from the newest run. */
  streak: number;
  latest: CiRun | null;
};

/** At most this many recent runs count, and the API is asked for this many. */
export const RECENT = 20;
/** This many failures in a row, newest first, is a storm. */
export const STORM_STREAK = 3;
/** With the newest run green, at least this many failures that are also half the runs is rain. */
export const RAIN_FAILURES = 3;

const API = 'https://api.github.com';
const PASSED = new Set(['success']);
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * Weather from recent runs, newest first. Storm: the last STORM_STREAK runs failed. Rain: the
 * newest run failed, or at least RAIN_FAILURES runs failed and they are half or more. Cloudy:
 * the newest run passed but some recent one failed. Sunny: every recent run passed. Clear: none.
 */
export function ciHealth(all: readonly CiRun[]): CiHealth {
  const runs = all.slice(0, RECENT);
  const failed = runs.filter((r) => !r.passed).length;
  const firstPass = runs.findIndex((r) => r.passed);
  const streak = firstPass === -1 ? runs.length : firstPass;
  const sky: Sky =
    runs.length === 0
      ? 'clear'
      : streak >= STORM_STREAK
        ? 'storm'
        : streak > 0 || (failed >= RAIN_FAILURES && failed * 2 >= runs.length)
          ? 'rain'
          : failed > 0
            ? 'cloudy'
            : 'sunny';
  return { sky, runs: runs.length, passed: runs.length - failed, streak, latest: runs[0] ?? null };
}

/**
 * Reads a `GET /repos/{o}/{r}/actions/runs` body into finished runs on `branch`, newest first.
 * Runs that were cancelled, skipped or still going are left out, and so are malformed ones.
 * Null when the body is not a list of runs at all.
 */
export function parseRuns(body: unknown, branch: string): CiRun[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const list = (body as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(list)) return null;
  const runs: CiRun[] = [];
  for (const run of list as unknown[]) {
    if (typeof run !== 'object' || run === null) continue;
    const { status, conclusion, head_branch, updated_at } = run as Record<string, unknown>;
    if (status !== 'completed' || head_branch !== branch || typeof conclusion !== 'string') {
      continue;
    }
    const at = typeof updated_at === 'string' ? Date.parse(updated_at) : NaN;
    if (Number.isNaN(at)) continue;
    if (PASSED.has(conclusion)) runs.push({ passed: true, at });
    else if (FAILED.has(conclusion)) runs.push({ passed: false, at });
  }
  return runs.sort((a, b) => b.at - a.at);
}

/**
 * Recent finished runs on `branch`. An empty list when the repo has no runs or Actions is off
 * (404). Null for anything else, a rate limit or the network included: weather is a nicety, so
 * callers show none rather than an error. Rejects only on abort.
 */
export async function fetchRuns(
  ref: RepoRef,
  branch: string,
  token?: string,
  signal?: AbortSignal,
): Promise<CiRun[] | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const query = `branch=${encodeURIComponent(branch)}&status=completed&per_page=${RECENT}`;
  try {
    const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/actions/runs?${query}`, {
      headers,
      signal,
    });
    if (res.status === 404) return [];
    if (!res.ok) return null;
    return parseRuns(await res.json(), branch);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** The runs bundled beside a sample (`<base>samples/<id>.runs.json`), in the API's shape. */
export async function loadSampleRuns(
  id: string,
  branch: string,
  base: string = import.meta.env.BASE_URL,
): Promise<CiRun[] | null> {
  try {
    const res = await fetch(`${base}samples/${id}.runs.json`);
    return res.ok ? parseRuns(await res.json(), branch) : null;
  } catch {
    return null;
  }
}

/** What runs are cached and stored under: one repo's branch. */
export const ciKey = (ref: { owner: string; repo: string }, branch: string) =>
  `${ref.owner}/${ref.repo}@${branch}`.toLowerCase();

/** The repo's Actions page, filtered to the branch. */
export const actionsUrl = (ref: { owner: string; repo: string }, branch: string) =>
  `https://github.com/${ref.owner}/${ref.repo}/actions?query=${encodeURIComponent(`branch:${branch}`)}`;
