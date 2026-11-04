/**
 * Computes a repo's history in a module worker with the visitor's own GitHub token
 * (repo/compute-history.ts starts it). The engine is the server's host-agnostic core. After a
 * failed run the worker keeps what it read, and a request for the same repo and branch resumes.
 */
import { computeHistory, createCheckpoint, type Checkpoint } from '../../server/src/core/engine';
import { UpstreamError } from '../../server/src/core/github';
import type { ComputeError, ComputeMessage, ComputeRequest } from './compute-history';

const post = (message: ComputeMessage) => self.postMessage(message);

let kept: { key: string; checkpoint: Checkpoint } | null = null;

self.onmessage = async ({ data }: MessageEvent<ComputeRequest>) => {
  let last = -1;
  const key = `${data.repo}@${data.branch}`;
  if (kept?.key !== key) kept = { key, checkpoint: createCheckpoint() };
  try {
    const history = await computeHistory({
      fetch: (input, init) => fetch(input, init),
      api: data.api,
      ...(data.token ? { token: data.token } : {}),
      repo: data.repo,
      branch: data.branch,
      checkpoint: kept.checkpoint,
      onProgress: (progress) => {
        // A message per percent is plenty for a progress bar.
        const step = Math.floor(progress * 100);
        if (step === last) return;
        last = step;
        post({ progress });
      },
    });
    kept = null;
    post({ history });
  } catch (error) {
    post({ error: toError(error) });
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
