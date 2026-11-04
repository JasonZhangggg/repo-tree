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
import { withUpload, type TraceSummary } from '../../server/src/core/trace';

/** GitHub's API, for the engine that runs in the visitor's browser (a fake in e2e runs). */
export const GITHUB_API: string = import.meta.env.VITE_GITHUB_API || 'https://api.github.com';

/** What a source had: a history, none yet (one may be computed), or none to be had. */
export type HistoryLoad = { status: 'ready'; history: History } | { status: 'missing' } | null;

export type ComputeOutcome =
  /**
   * `shared`: what the upload said (`stored`, or why not). The history is good either way.
   * `trace`: where the time and bytes went, the upload included.
   */
  | { status: 'ready'; history: History; shared: UploadResult; trace?: TraceSummary }
  | { status: 'error'; error: ComputeError; trace?: TraceSummary };

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
  /**
   * Whether a loaded history is behind the branch: computed over STALE_AFTER_MS ago, and GitHub
   * names another head now (one request, with the visitor's token). Null where `compute` is.
   */
  outdated: ((history: History, token: string, signal: AbortSignal) => Promise<boolean>) | null;
};

/** A stored history younger than this is not checked against the branch. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Where a repo's history comes from: the file bundled beside a sample, or the history server
 * when this build names one, which a signed-in visitor fills by computing it in their browser.
 * The server keeps one history per repo, its default branch: a repo opened on a branch named
 * in the link (`ref.ref`) reads what is there but is not offered a compute. Null means none
 * can: the timeline shows as unavailable. The timeline reads only what this returns.
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
      outdated: null,
    };
  }
  if (!server) return null;
  const { ref, branch } = repo.info;
  const load = (signal: AbortSignal) => loadHistory(ref, branch, { base: server, signal });
  if (ref.ref !== undefined) return { load, compute: null, outdated: null };
  return {
    load,
    outdated: async (history, token, signal) => {
      if (Date.now() - history.computedAt < STALE_AFTER_MS) return false;
      const path = branch.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await fetch(`${api}/repos/${ref.owner}/${ref.repo}/commits/${path}`, {
          headers: { Accept: 'application/vnd.github.sha', Authorization: `Bearer ${token}` },
          signal,
        });
        return res.ok && (await res.text()).trim() !== history.head;
      } catch (error) {
        if (signal.aborted) throw error;
        return false;
      }
    },
    compute: async ({ token, signal, onProgress }) => {
      const started = performance.now();
      const result = await computeHistoryInWorker(ref, branch, {
        token,
        signal,
        api,
        ...(onProgress ? { onProgress } : {}),
        ...(spawn ? { spawn } : {}),
      });
      if (result.status === 'error') return result;
      const from = performance.now() - started;
      let bytes = 0;
      const shared = await uploadHistory(result.history, result.snapshots, token, {
        base: server,
        signal,
        onBody: (n) => (bytes = n),
      });
      const upload = { from, ms: performance.now() - started - from, bytes };
      await cacheComputed(ref, branch, result.history);
      return {
        status: 'ready',
        history: result.history,
        shared,
        ...(result.trace ? { trace: withUpload(result.trace, upload) } : {}),
      };
    },
  };
}

export { signedInToken };
