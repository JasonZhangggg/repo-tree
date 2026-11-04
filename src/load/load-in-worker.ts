import type { GrowParams, TreeModel } from '../grow/grow';
import type { LoadError, Snapshot } from '../repo/github';
import type { Filters } from '../repo/hierarchy';
import type { RepoRef } from '../repo/ref';
import type { RepoIndex } from './repo-index';

export type LoadSource =
  | { kind: 'sample'; id: string; base: string }
  | { kind: 'github'; ref: RepoRef; token?: string; fresh: boolean };
export type LoadRequest = { source: LoadSource; filters: Filters; params: GrowParams };
export type LoadStep = 'fetch' | 'build' | 'grow';
export type RepoInfo = Omit<Snapshot, 'files'> & { files: number };
export type Loaded = { info: RepoInfo; tree: TreeModel; index: RepoIndex };
/**
 * File paths cross as one newline-joined string: cloning a hundred thousand separate strings
 * blocked the main thread for most of a second on the Linux sample.
 */
export type WorkerMessage =
  | { step: LoadStep }
  | { branch: string }
  | { loaded: Loaded; paths: string }
  | { error: LoadError };
/** Progress from the worker: each step as it starts, and a GitHub repo's branch once known. */
export type LoadProgress = { step(step: LoadStep): void; branch?(name: string): void };

/**
 * Fetches, parses, builds and grows in a fresh worker, so the main thread only receives the
 * finished buffers. Aborting terminates the worker and rejects with the signal's reason.
 */
export function loadInWorker(
  request: LoadRequest,
  progress: LoadProgress,
  signal: AbortSignal,
): Promise<Loaded | LoadError> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const settle = () => {
      worker.terminate();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort);
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if ('step' in data) return progress.step(data.step);
      if ('branch' in data) return progress.branch?.(data.branch);
      settle();
      if ('error' in data) return resolve(data.error);
      const { loaded, paths } = data;
      resolve({
        ...loaded,
        index: { ...loaded.index, files: { ...loaded.index.files, paths: paths.split('\n') } },
      });
    };
    worker.onerror = (event) => {
      settle();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}
