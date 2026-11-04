/**
 * The visitor's browser computes a repo's history from GitHub with their own token, in a module
 * worker (repo/history-worker.ts running server/src/core/engine.ts). Abort cancels the run in
 * the worker, so its requests stop. A worker whose run failed (a spent rate limit, a dropped
 * connection) or was cancelled is kept, with what it read, for the next try at the same repo
 * and branch; a try at another repo ends it.
 */
import type { History } from '../../server/src/shape';

/** A run to start, numbered so its messages are told apart from a cancelled run's. */
export type ComputeRequest = {
  run: number;
  api: string;
  repo: string;
  branch: string;
  token?: string;
};
/** What the page sends the worker: a run, or the cancelling of one. */
export type ComputeCommand = ComputeRequest | { cancel: number };
export type ComputeError =
  | { kind: 'not-found' | 'empty' | 'unauthorized' | 'upstream' }
  | { kind: 'rate-limited'; resetAt: number };
/** A snapshot of the History with its root tree, for the upload's manifest. */
export type Snapshot = { sha: string; at: number; tree: string };
export type ComputeMessage = { run: number } & (
  { progress: number } | { history: History; snapshots: Snapshot[] } | { error: ComputeError }
);

export type ComputeResult =
  | { status: 'ready'; history: History; snapshots: Snapshot[] }
  | { status: 'error'; error: ComputeError };

type WorkerLike = Pick<Worker, 'terminate'> & {
  postMessage(command: ComputeCommand): void;
  onmessage: ((event: MessageEvent<ComputeMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
};

export type ComputeOptions = {
  token?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /** Defaults to https://api.github.com. */
  api?: string;
  /** Injected for tests. */
  spawn?: () => WorkerLike;
};

const spawnWorker = (): WorkerLike =>
  new Worker(new URL('./history-worker.ts', import.meta.url), { type: 'module' });

/** The worker of a failed or cancelled run, which resumes from what it read; one at a time. */
let parked: { key: string; worker: WorkerLike } | null = null;
let runs = 0;

/** Rejects only on abort. */
export function computeHistoryInWorker(
  ref: { owner: string; repo: string },
  branch: string,
  options: ComputeOptions = {},
): Promise<ComputeResult> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const key = `${ref.owner}/${ref.repo}@${branch}`;
    let worker: WorkerLike;
    if (parked?.key === key) worker = parked.worker;
    else {
      parked?.worker.terminate();
      worker = (options.spawn ?? spawnWorker)();
    }
    parked = null;
    const run = ++runs;
    const settle = (keep = false) => {
      worker.onmessage = null;
      worker.onerror = null;
      signal?.removeEventListener('abort', onAbort);
      if (keep) parked = { key, worker };
      else worker.terminate();
    };
    const onAbort = () => {
      // Cancelled, not ended: the worker keeps what it read, and "try again" resumes.
      worker.postMessage({ cancel: run });
      settle(true);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.run !== run) return;
      if ('progress' in data) return options.onProgress?.(data.progress);
      settle('error' in data);
      resolve(
        'history' in data
          ? { status: 'ready', history: data.history, snapshots: data.snapshots }
          : { status: 'error', error: data.error },
      );
    };
    worker.onerror = () => {
      settle();
      resolve({ status: 'error', error: { kind: 'upstream' } });
    };
    const request: ComputeRequest = {
      run,
      api: options.api ?? 'https://api.github.com',
      repo: `${ref.owner}/${ref.repo}`,
      branch,
      ...(options.token ? { token: options.token } : {}),
    };
    worker.postMessage(request);
  });
}
