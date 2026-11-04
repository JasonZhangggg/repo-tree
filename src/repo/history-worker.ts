/**
 * Computes a repo's history in a module worker with the visitor's own GitHub token
 * (repo/compute-history.ts starts it). The engine is the server's host-agnostic core. After a
 * failed or cancelled run the worker keeps what it read, and a run for the same repo and branch
 * resumes from there (re-reading only the branch's head, which may have moved meanwhile).
 */
import { computeHistory, createCheckpoint, type Checkpoint } from '../../server/src/core/engine';
import { UpstreamError } from '../../server/src/core/github';
import { tracer } from '../../server/src/core/trace';
import type { ComputeCommand, ComputeError, ComputeMessage, Snapshot } from './compute-history';

const post = (message: ComputeMessage) => self.postMessage(message);

let kept: { key: string; checkpoint: Checkpoint } | null = null;
/** The run in progress; a new one waits for it to unwind, as both would write the checkpoint. */
let current: { run: number; abort: AbortController; done: Promise<void> } | null = null;

self.onmessage = async ({ data }: MessageEvent<ComputeCommand>) => {
  if ('cancel' in data) {
    if (current?.run === data.cancel) current.abort.abort();
    return;
  }
  const { run } = data;
  const previous = current;
  previous?.abort.abort();
  const abort = new AbortController();
  let finish = (): void => undefined;
  current = { run, abort, done: new Promise<void>((resolve) => (finish = resolve)) };
  await previous?.done;
  let last = -1;
  const key = `${data.repo}@${data.branch}`;
  if (kept?.key !== key) kept = { key, checkpoint: createCheckpoint() };
  let snapshots: Snapshot[] = [];
  // Where the run's time and bytes went, for the page's console (app/ui/history-compute.ts).
  const trace = tracer();
  try {
    const history = await computeHistory({
      fetch: (input, init) => fetch(input, init),
      api: data.api,
      ...(data.token ? { token: data.token } : {}),
      ...(data.packUrl ? { packUrl: data.packUrl } : {}),
      ...(data.base ? { base: data.base } : {}),
      repo: data.repo,
      branch: data.branch,
      checkpoint: kept.checkpoint,
      signal: abort.signal,
      trace,
      onSamples: (s) => (snapshots = s),
      onProgress: (progress) => {
        // A message per percent is plenty for a progress bar.
        const step = Math.floor(progress * 100);
        if (step === last) return;
        last = step;
        post({ run, progress });
      },
    });
    kept = null;
    post({ run, history, snapshots, trace: trace.summary() });
  } catch (error) {
    if (!abort.signal.aborted) post({ run, error: toError(error), trace: trace.summary() });
  } finally {
    finish();
  }
};

function toError(error: unknown): ComputeError {
  if (error instanceof UpstreamError) {
    return error.kind === 'rate-limited'
      ? { kind: 'rate-limited', resetAt: error.resetAt }
      : { kind: error.kind };
  }
  return { kind: 'upstream' };
}
