import { describe, expect, it } from 'vitest';
import { schedule } from '../src/core/commits';
import { DEFAULT_LEDGER_LIMITS, ledger, parseLedgerRequest, type Sql } from '../src/core/ledger';
import { followsSchedule } from '../src/core/upload';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 4, 12);

async function book(limits: Partial<typeof DEFAULT_LEDGER_LIMITS> = {}) {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => {
      prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] };
    };
  };
  const db = new DatabaseSync(':memory:');
  const sql: Sql = {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  return ledger(sql, { ...DEFAULT_LEDGER_LIMITS, ...limits });
}

const reserve = (key: string, head: string, login: string, now: number, bytes = 100) =>
  ({ op: 'reserve', key, head, bytes, login, now }) as const;

describe('ledger', () => {
  it('counts each login and the day, and starts over the next UTC day', async () => {
    const l = await book({ perLogin: 2, perDay: 3 });
    expect(l.run(reserve('a', 'h1', 'ada', T0))).toEqual({ ok: true });
    expect(l.run(reserve('b', 'h1', 'ada', T0))).toEqual({ ok: true });
    expect(l.run(reserve('c', 'h1', 'ada', T0))).toMatchObject({
      ok: false,
      error: 'rate-limited',
    });
    expect(l.run(reserve('c', 'h1', 'bob', T0))).toEqual({ ok: true });
    const full = l.run({ op: 'check', key: 'd', head: 'h1', now: T0 });
    expect(full).toEqual({ ok: false, error: 'rate-limited', retryAfter: 12 * 60 * 60 });
    expect(l.run(reserve('d', 'h1', 'cy', T0 + DAY / 2))).toEqual({ ok: true });
    expect(l.totals(T0 + DAY / 2)).toMatchObject({ today: 1, entries: 4 });
  });

  it('refuses the same good head, but not a new head, a reported one, or one a day old', async () => {
    const l = await book();
    expect(l.run(reserve('k', 'h1', 'ada', T0)).ok).toBe(true);
    expect(l.run({ op: 'check', key: 'k', head: 'h1', now: T0 })).toEqual({
      ok: false,
      error: 'exists',
    });
    expect(l.run(reserve('k', 'h1', 'bob', T0))).toMatchObject({ error: 'exists' });
    l.run({ op: 'bad', key: 'k', head: 'h0', now: T0 });
    expect(l.run({ op: 'check', key: 'k', head: 'h1', now: T0 }).ok).toBe(false);
    l.run({ op: 'bad', key: 'k', head: 'h1', now: T0 });
    expect(l.run(reserve('k', 'h1', 'bob', T0)).ok).toBe(true);
    expect(l.run(reserve('k', 'h1', 'bob', T0)).ok).toBe(false);
    expect(l.run(reserve('k', 'h2', 'bob', T0)).ok).toBe(true);
    expect(l.run({ op: 'check', key: 'k', head: 'h2', now: T0 + DAY - 1 }).ok).toBe(false);
    expect(l.run({ op: 'check', key: 'k', head: 'h2', now: T0 + DAY }).ok).toBe(true);
  });

  it('keeps the stored bytes under the budget, counting a replaced entry once', async () => {
    const l = await book({ maxBytes: 250 });
    expect(l.run(reserve('a', 'h1', 'ada', T0, 100)).ok).toBe(true);
    expect(l.run(reserve('b', 'h1', 'ada', T0, 100)).ok).toBe(true);
    expect(l.run(reserve('c', 'h1', 'ada', T0, 100))).toEqual({ ok: false, error: 'full' });
    expect(l.run(reserve('b', 'h2', 'ada', T0, 150)).ok).toBe(true);
    expect(l.totals(T0).bytes).toBe(250);
  });

  it('forgets entries when KV does, and on release', async () => {
    const l = await book({ ttlMs: 10 * DAY, maxBytes: 150 });
    expect(l.run(reserve('a', 'h1', 'ada', T0, 100)).ok).toBe(true);
    expect(l.run(reserve('b', 'h1', 'ada', T0, 100)).ok).toBe(false);
    expect(l.run(reserve('b', 'h1', 'ada', T0 + 10 * DAY, 100)).ok).toBe(true);
    l.run({ op: 'release', key: 'b', head: 'h1', now: T0 + 10 * DAY });
    expect(l.totals(T0 + 10 * DAY)).toMatchObject({ entries: 0, bytes: 0 });
  });

  it('reads only well-formed requests', () => {
    expect(parseLedgerRequest({ op: 'check', key: 'k', head: 'h', now: 1 })).not.toBeNull();
    expect(parseLedgerRequest({ op: 'reserve', key: 'k', head: 'h', now: 1 })).toBeNull();
    expect(parseLedgerRequest({ op: 'drop', key: 'k', head: 'h', now: 1 })).toBeNull();
    expect(parseLedgerRequest(null)).toBeNull();
  });
});

describe('followsSchedule', () => {
  const head = T0;
  const root = T0 - 5 * 365 * DAY;
  const targets = schedule(head, root, 80);

  it('takes the engine-like picks: one per target, at or before it', () => {
    const picks = [root, ...targets.map((t) => t - DAY).reverse(), head];
    expect(followsSchedule(picks.map((at) => ({ at })))).toBe(true);
    // Sparse is allowed: commits may be few.
    expect(followsSchedule([{ at: root }, { at: head }])).toBe(true);
    expect(followsSchedule([{ at: head }])).toBe(true);
  });

  it('refuses two picks for one target, or a pick newer than every target', () => {
    expect(followsSchedule([{ at: root }, { at: head - 3 * DAY }, { at: head }])).toBe(false);
    const doubled = [root, targets[1]! - DAY, targets[0]! - DAY, targets[0]! - 2 * DAY, head];
    expect(followsSchedule(doubled.sort((a, b) => a - b).map((at) => ({ at })))).toBe(false);
  });
});
