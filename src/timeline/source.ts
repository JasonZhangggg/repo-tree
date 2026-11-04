import { signedInToken } from '../repo/auth';
import {
  computeHistoryInWorker,
  type ComputeError,
  type ComputeOptions,
} from '../repo/compute-history';
import {
  HISTORY_URL,
  cacheComputed,
  loadHistory,
  loadSampleHistory,
  uploadHistory,
  type History,
  type UploadResult,
} from '../repo/history';
import type { RepoRef } from '../repo/ref';

/** GitHub's API, for the engine that runs in the visitor's browser (a fake in e2e runs). */
export const GITHUB_API: string = import.meta.env.VITE_GITHUB_API || 'https://api.github.com';

/** What a source had: a history, none yet (one may be computed), or none to be had. */
export type HistoryLoad = { status: 'ready'; history: History } | { status: 'missing' } | null;

export type ComputeOutcome =
  /** `shared`: what the upload said (`stored`, or why not). The history is good either way. */
  | { status: 'ready'; history: History; shared: UploadResult }
  | { status: 'error'; error: ComputeError };

export type HistorySource = {
  /** Reads the history. Rejects only on abort. */
  load(signal: AbortSignal): Promise<HistoryLoad>;
  /**
   * For a missing history: computes it in this browser with the signed-in visitor's token
   * (repo/compute-history.ts), shares it through the history server and caches it here.
   * Null when this build has no history server. Rejects only on abort.
   */
  compute:
    | ((options: {
        token: string;
        signal: AbortSignal;
        onProgress?: (p: number) => void;
      }) => Promise<ComputeOutcome>)
    | null;
};

/**
 * Where a repo's history comes from: the file bundled beside a sample, or the history server
 * when this build names one, which a signed-in visitor fills by computing it in their browser.
 * Null means none can: the timeline shows as unavailable. The timeline reads only what this
 * returns.
 */
export function historySource(
  repo: { sample?: string; info: { ref: RepoRef; branch: string } },
  {
    base = import.meta.env.BASE_URL,
    server = HISTORY_URL,
    api = GITHUB_API,
    spawn,
  }: { base?: string; server?: string; api?: string; spawn?: ComputeOptions['spawn'] } = {},
): HistorySource | null {
  const { sample } = repo;
  if (sample) {
    return {
      load: async () => {
        const history = await loadSampleHistory(sample, base);
        return history ? { status: 'ready', history } : null;
      },
      compute: null,
    };
  }
  if (!server) return null;
  const { ref, branch } = repo.info;
  return {
    load: (signal) => loadHistory(ref, branch, { base: server, signal }),
    compute: async ({ token, signal, onProgress }) => {
      const result = await computeHistoryInWorker(ref, branch, {
        token,
        signal,
        api,
        ...(onProgress ? { onProgress } : {}),
        ...(spawn ? { spawn } : {}),
      });
      if (result.status === 'error') return result;
      const shared = await uploadHistory(result.history, result.snapshots, token, {
        base: server,
        signal,
      });
      await cacheComputed(ref, branch, result.history);
      return { status: 'ready', history: result.history, shared };
    },
  };
}

export { signedInToken };
