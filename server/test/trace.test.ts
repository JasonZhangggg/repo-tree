import { describe, expect, it } from 'vitest';
import { formatTrace, kindOf, tracer, withUpload } from '../src/core/trace';

describe('trace', () => {
  it('names each kind of request the engine makes', () => {
    const sha = 'a'.repeat(40);
    expect(kindOf('/graphql')).toBe('graphql');
    expect(kindOf(`/repos/o/r/git/trees/${sha}?recursive=1`)).toBe('tree');
    expect(kindOf(`/repos/o/r/git/blobs/${sha}`)).toBe('blob');
    expect(kindOf(`/repos/o/r/commits/${sha}?page=2`)).toBe('commit');
    expect(
      kindOf(`/repos/o/r/commits?sha=${sha}&until=2026-01-01T00:00:00.000Z&per_page=100`),
    ).toBe('probe');
    expect(kindOf('/repos/o/r/commits?sha=main&per_page=100')).toBe('listing');
  });

  it('sums phases, requests, waits and batches, and prints them on one line', () => {
    let now = 1000;
    const t = tracer(() => now);
    t.begin('listings');
    t.request('listing', 300, 20_000);
    now += 300;
    t.end('listings');
    t.begin('graphql');
    for (let i = 1; i <= 10; i++) t.request('graphql', i * 100, 1000);
    t.batch(400, true);
    t.batch(400, true);
    t.batch(100, false);
    t.waited(2500);
    now += 4000;
    t.end('graphql');
    t.begin('recent');
    now += 700;
    const s = t.summary();
    expect(s.ms).toBe(5000);
    expect(s.phases).toEqual([
      { name: 'listings', from: 0, ms: 300 },
      { name: 'graphql', from: 300, ms: 4000 },
      // Still running: up to now.
      { name: 'recent', from: 4300, ms: 700 },
    ]);
    const graphql = s.kinds.find((k) => k.kind === 'graphql')!;
    expect(graphql).toMatchObject({ requests: 10, bytes: 10_000, meanMs: 550, p90Ms: 1000 });
    expect(s).toMatchObject({ requests: 11, bytes: 30_000, waitedMs: 2500, failed: 1 });
    expect(s.batches).toEqual({ 400: 2 });
    expect(t.bytes).toBe(30_000);

    const all = withUpload(s, { from: 5000.4, ms: 799.9, bytes: 50_000 });
    expect(all.ms).toBe(5800);
    expect(all.phases.at(-1)).toEqual({ name: 'upload', from: 5000, ms: 800 });
    expect(all.kinds.at(-1)).toMatchObject({
      kind: 'upload',
      requests: 1,
      bytes: 50_000,
      meanMs: 800,
      p90Ms: 800,
    });

    const line = formatTrace('o/r', all);
    expect(line).not.toContain('\n');
    expect(line).toContain('history o/r: 5.8 s, 12 requests');
    expect(line).toContain('graphql 4.0 s');
    expect(line).toContain('upload 0.8 s');
    expect(line).toContain('graphql 10 req 0.01 MB 550/1000 ms');
    expect(line).toContain('waited 2.5 s');
    expect(line).toContain('graphql batches 400x2, 1 failed');
    expect(line).toContain('fell back to REST: no');
  });
});
