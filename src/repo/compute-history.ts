/**
 * The visitor's browser computes a repo's history from GitHub with their own token, in a module
 * worker (repo/history-worker.ts running server/src/core/engine.ts). Abort terminates the worker,
 * so its requests stop with it.
 */
import type { History } from '../../server/src/shape';

export type ComputeRequest = { api: string; repo: string; branch: string; token?: string };
export type ComputeError =
  | { kind: 'not-found' | 'empty' | 'unauthorized' | 'upstream' }
  | { kind: 'rate-limited'; resetAt: number };
export type ComputeMessage = { progress: number } | { history: History } | { error: ComputeError };

export type ComputeResult =
  { status: 'ready'; history: History } | { status: 'error'; error: ComputeError };

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
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

/** Rejects only on abort. */
export function computeHistoryInWorker(
  ref: { owner: string; repo: string },
  branch: string,
  options: ComputeOptions = {},
): Promise<ComputeResult> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = (options.spawn ?? spawnWorker)();
    const settle = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if ('progress' in data) return options.onProgress?.(data.progress);
      settle();
      resolve(
        'history' in data
          ? { status: 'ready', history: data.history }
          : { status: 'error', error: data.error },
      );
    };
    worker.onerror = () => {
      settle();
      resolve({ status: 'error', error: { kind: 'upstream' } });
    };
    const request: ComputeRequest = {
      api: options.api ?? 'https://api.github.com',
      repo: `${ref.owner}/${ref.repo}`,
      branch,
      ...(options.token ? { token: options.token } : {}),
    };
    worker.postMessage(request);
  });
}
