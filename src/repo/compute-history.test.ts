import { describe, expect, test } from 'vitest';
import type { History } from '../../server/src/shape';
import {
  computeHistoryInWorker,
  type ComputeMessage,
  type ComputeRequest,
} from './compute-history';

function fakeWorker() {
  const sent: ComputeRequest[] = [];
  const worker = {
    terminated: false,
    onmessage: null as ((e: MessageEvent<ComputeMessage>) => void) | null,
    onerror: null as ((e: ErrorEvent) => void) | null,
    postMessage: (data: ComputeRequest) => void sent.push(data),
    terminate() {
      worker.terminated = true;
    },
    reply: (data: ComputeMessage) => worker.onmessage?.({ data } as MessageEvent<ComputeMessage>),
  };
  return { worker, sent };
}

const ref = { owner: 'vitejs', repo: 'vite' };

describe('computeHistoryInWorker', () => {
  test('relays progress, resolves the history and ends the worker', async () => {
    const { worker, sent } = fakeWorker();
    const seen: number[] = [];
    const done = computeHistoryInWorker(ref, 'main', {
      token: 'gho_x',
      spawn: () => worker,
      onProgress: (p) => seen.push(p),
    });
    expect(sent).toEqual([
      { api: 'https://api.github.com', repo: 'vitejs/vite', branch: 'main', token: 'gho_x' },
    ]);
    worker.reply({ progress: 0.5 });
    const history = { v: 1 } as History;
    worker.reply({ history });
    expect(await done).toEqual({ status: 'ready', history });
    expect(seen).toEqual([0.5]);
    expect(worker.terminated).toBe(true);
  });

  test('passes GitHub errors through', async () => {
    const { worker } = fakeWorker();
    const done = computeHistoryInWorker(ref, 'main', { spawn: () => worker });
    worker.reply({ error: { kind: 'rate-limited', resetAt: 5 } });
    expect(await done).toEqual({ status: 'error', error: { kind: 'rate-limited', resetAt: 5 } });
  });

  test("keeps a failed run's worker to resume the same repo, and only that", async () => {
    const first = fakeWorker();
    const failed = computeHistoryInWorker(ref, 'dev', { spawn: () => first.worker });
    first.worker.reply({ error: { kind: 'upstream' } });
    await failed;
    expect(first.worker.terminated).toBe(false);
    const unused = fakeWorker();
    const again = computeHistoryInWorker(ref, 'dev', { spawn: () => unused.worker });
    expect(first.sent).toHaveLength(2);
    first.worker.reply({ history: { v: 1 } as History });
    await again;
    expect(first.worker.terminated).toBe(true);

    const third = fakeWorker();
    const failing = computeHistoryInWorker(ref, 'dev', { spawn: () => third.worker });
    third.worker.reply({ error: { kind: 'upstream' } });
    await failing;
    const other = fakeWorker();
    void computeHistoryInWorker({ owner: 'a', repo: 'b' }, 'dev', { spawn: () => other.worker });
    expect(third.worker.terminated).toBe(true);
    expect(other.sent).toHaveLength(1);
  });

  test('abort terminates the worker and rejects', async () => {
    const { worker } = fakeWorker();
    const controller = new AbortController();
    const done = computeHistoryInWorker(ref, 'aborted', {
      spawn: () => worker,
      signal: controller.signal,
    });
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });
});
