/**
 * Computes a repo's history in a module worker with the visitor's own GitHub token
 * (repo/compute-history.ts starts it). The engine is the server's host-agnostic core.
 */
import { computeHistory } from '../../server/src/core/engine';
import { UpstreamError } from '../../server/src/core/github';
import type { ComputeError, ComputeMessage, ComputeRequest } from './compute-history';

const post = (message: ComputeMessage) => self.postMessage(message);

self.onmessage = async ({ data }: MessageEvent<ComputeRequest>) => {
  let last = -1;
  try {
    const history = await computeHistory({
      fetch: (input, init) => fetch(input, init),
      api: data.api,
      ...(data.token ? { token: data.token } : {}),
      repo: data.repo,
      branch: data.branch,
      onProgress: (progress) => {
        // A message per percent is plenty for a progress bar.
        const step = Math.floor(progress * 100);
        if (step === last) return;
        last = step;
        post({ progress });
      },
    });
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
