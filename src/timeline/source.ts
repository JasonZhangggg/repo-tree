import { signedInToken } from '../repo/auth';
import { HISTORY_URL, loadHistory, loadSampleHistory, type History } from '../repo/history';
import type { RepoRef } from '../repo/ref';

/** Reads a repo's history, or null when it could not be had. Rejects only on abort. */
export type HistorySource = (signal: AbortSignal) => Promise<History | null>;

/**
 * Where a repo's history comes from: the file bundled beside a sample, or the history server
 * when this build names one. Null means none can: the timeline shows as unavailable. The
 * timeline reads only the History this returns, so another source (one that runs in the
 * browser, or prebuilt files for popular repos) slots in here alone.
 */
export function historySource(
  repo: { sample?: string; info: { ref: RepoRef; branch: string } },
  {
    base = import.meta.env.BASE_URL,
    server = HISTORY_URL,
  }: { base?: string; server?: string } = {},
): HistorySource | null {
  const { sample } = repo;
  if (sample) return () => loadSampleHistory(sample, base);
  if (!server) return null;
  return async (signal) => {
    const result = await loadHistory(repo.info.ref, repo.info.branch, {
      base: server,
      token: signedInToken(),
      signal,
    });
    return result?.status === 'ready' ? result.history : null;
  };
}
