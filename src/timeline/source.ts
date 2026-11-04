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
import { sampleFor } from '../app/samples';
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
 * in the link (`ref.ref`) that turns out not to be the default is told so when it computes. A
 * sample's repo
 * reloaded live on the sample's branch falls back to the bundled history when none is shared.
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
  const { ref, branch } = repo.info;
  // A sample's bundled history, also for its repo reloaded live on the same branch.
  const bundled = repo.sample ?? sampleFor({ ...ref, ref: branch })?.id;
  const loadBundled = async (): Promise<HistoryLoad> => {
    const history = bundled ? await loadSampleHistory(bundled, base) : null;
    return history ? { status: 'ready', history } : null;
  };
  if (repo.sample || (bundled && !server)) {
    return { load: loadBundled, compute: null, outdated: null };
  }
  if (!server) return null;
  const load = async (signal: AbortSignal): Promise<HistoryLoad> => {
    const shared = await loadHistory(ref, branch, { base: server, signal });
    if (shared?.status === 'ready' || !bundled) return shared;
    // None shared yet, or the server is unreachable: the bundled one, which `outdated` may offer
    // a signed-in visitor to bring up to date.
    return (await loadBundled()) ?? shared;
  };
  /**
   * A branch link (every shared link names its branch) may name the default branch or another:
   * the server keeps only the default, so ask GitHub which it is before an expensive run.
   */
  const notDefault = async (token: string, signal: AbortSignal): Promise<string | null> => {
    if (ref.ref === undefined) return null;
    try {
      const res = await fetch(`${api}/repos/${ref.owner}/${ref.repo}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
        signal,
      });
      const body: unknown = res.ok ? await res.json() : null;
      const name = (body as { default_branch?: unknown } | null)?.default_branch;
      return typeof name === 'string' && name !== branch ? name : null;
    } catch (error) {
      if (signal.aborted) throw error;
      // Unknown: the run goes ahead, and the server checks the branch before storing it.
      return null;
    }
  };
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
      const defaultBranch = await notDefault(token, signal);
      if (defaultBranch !== null) {
        return { status: 'error', error: { kind: 'not-default-branch', defaultBranch } };
      }
      const started = performance.now();
      const result = await computeHistoryInWorker(ref, branch, {
        token,
        signal,
        api,
        // Every snapshot's trees in one git fetch, through the history server.
        packUrl: `${server}/v1/git/${ref.owner}/${ref.repo}/git-upload-pack`,
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
