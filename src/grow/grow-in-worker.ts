import type { Snapshot } from '../repo/github';
import type { Dir, Filters } from '../repo/hierarchy';
import type { GrowParams, TreeModel } from './grow';

export type GrowRequest =
  { snapshot: Snapshot; filters: Filters; params: GrowParams } | { dir: Dir; params: GrowParams };

/** Grows off the main thread. Aborting terminates the worker and rejects with the signal's reason. */
export function growInWorker(request: GrowRequest, signal?: AbortSignal): Promise<TreeModel> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const settle = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort);
    worker.onmessage = (event: MessageEvent<TreeModel>) => {
      settle();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      settle();
      reject(new Error(event.message));
    };
    worker.postMessage(request);
  });
}
