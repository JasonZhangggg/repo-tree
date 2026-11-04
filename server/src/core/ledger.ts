/**
 * The history Worker's ledger: what is stored under each key, and how many uploads were taken
 * today, in all and per GitHub login. One global SQLite-backed Durable Object holds it
 * (`Ledger` in ../worker.ts), so each check-and-count runs alone, and every KV write the Worker
 * makes is counted here first. KV's own view of what exists is only eventually consistent; this is
 * the source of truth for "already stored" and for the caps.
 *
 * The caps keep a free-plan account safe: KV allows 1,000 writes a day (shared with the owner's
 * other project) and 1 GB of storage, and a junk upload must not be able to use either up.
 */

/** The SQL a Durable Object's `ctx.storage.sql` runs (node:sqlite in tests and local runs). */
export type Sql = {
  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): Record<string, unknown>[] };
};

export type LedgerLimits = {
  /** Uploads one GitHub login may store in a UTC day. */
  perLogin: number;
  /** Uploads the Worker stores in a UTC day, in all. */
  perDay: number;
  /** Bytes all stored bodies may take, together; past it the oldest are evicted (FIFO). */
  maxBytes: number;
  /** KV writes and deletes the Worker makes in a UTC day, evictions included. */
  writesPerDay: number;
  /** Entries one upload may evict to make room; past it the upload is refused as full. */
  evictPerUpload: number;
  /** A stored history for the same head may be replaced after this long (a bad first upload). */
  replaceAfterMs: number;
  /** How long KV keeps a body; the ledger forgets an entry with it. */
  ttlMs: number;
};

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = {
  perLogin: 20,
  perDay: 200,
  maxBytes: 500 * 1024 * 1024,
  // Free KV: 1,000 writes and deletes a day, shared with the account's other projects.
  writesPerDay: 400,
  evictPerUpload: 20,
  replaceAfterMs: 24 * 60 * 60 * 1000,
  ttlMs: 90 * 24 * 60 * 60 * 1000,
};

export type LedgerRequest =
  /** Before spending GitHub requests: would an upload of `head` under `key` be taken? */
  | { op: 'check'; key: string; head: string; now: number }
  /**
   * After the checks: take it, counting one write for `login` and today, or refuse. When the
   * stored bodies would pass maxBytes, the reply names the keys evicted to make room (oldest
   * first, ones reported bad before them), which the Worker deletes from KV before its put.
   */
  | { op: 'reserve'; key: string; head: string; bytes: number; login: string; now: number }
  /** The KV write failed: forget the entry (the count stays, the write may have landed). */
  | { op: 'release'; key: string; head: string; now: number }
  /** A reader could not use the stored body for `head`: it may be replaced at once. */
  | { op: 'bad'; key: string; head: string; now: number };

export type LedgerReply =
  | { ok: true; evict?: string[] }
  | { ok: false; error: 'exists' | 'rate-limited' | 'full'; retryAfter?: number };

const DAY_MS = 24 * 60 * 60 * 1000;

export function ledger(sql: Sql, limits: LedgerLimits = DEFAULT_LEDGER_LIMITS) {
  sql.exec(`CREATE TABLE IF NOT EXISTS entries (
    key TEXT PRIMARY KEY, head TEXT NOT NULL, bytes INTEGER NOT NULL,
    stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bad INTEGER NOT NULL DEFAULT 0)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS uploads (
    day INTEGER NOT NULL, login TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, login))`);
  sql.exec(`CREATE TABLE IF NOT EXISTS writes (day INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);

  const one = (query: string, ...bindings: (string | number)[]) =>
    sql.exec(query, ...bindings).toArray()[0];
  const num = (value: unknown) => Number(value ?? 0);

  /** Seconds to the next UTC midnight, when the day's counts start over. */
  const untilTomorrow = (now: number) => Math.ceil((DAY_MS - (now % DAY_MS)) / 1000);

  const written = (day: number) => num(one('SELECT n FROM writes WHERE day = ?', day)?.n);

  /**
   * The entries to evict, oldest first and bad ones before the rest, so that `bytes` more fit
   * beside the others (the entry under `key` is replaced, so it does not count); null when
   * evictPerUpload of them would not make room.
   */
  function room(key: string, bytes: number): { keys: string[]; freed: number } | null {
    const others = num(one('SELECT SUM(bytes) AS b FROM entries WHERE key != ?', key)?.b);
    let over = others + bytes - limits.maxBytes;
    if (over <= 0) return { keys: [], freed: 0 };
    const oldest = sql
      .exec(
        'SELECT key, bytes FROM entries WHERE key != ? ORDER BY bad DESC, stored_at ASC, key LIMIT ?',
        key,
        limits.evictPerUpload,
      )
      .toArray();
    const keys: string[] = [];
    let freed = 0;
    for (const row of oldest) {
      if (over <= 0) break;
      keys.push(String(row.key));
      freed += num(row.bytes);
      over -= num(row.bytes);
    }
    return over <= 0 ? { keys, freed } : null;
  }

  /** Refusals that need no login: the same head stored and good, or today's cap reached. */
  function refuse(key: string, head: string, now: number): LedgerReply | null {
    sql.exec('DELETE FROM entries WHERE expires_at <= ?', now);
    const day = Math.floor(now / DAY_MS);
    sql.exec('DELETE FROM uploads WHERE day < ?', day);
    const held = one('SELECT head, stored_at, bad FROM entries WHERE key = ?', key);
    if (
      held &&
      held.head === head &&
      num(held.bad) === 0 &&
      now - num(held.stored_at) < limits.replaceAfterMs
    ) {
      return { ok: false, error: 'exists' };
    }
    sql.exec('DELETE FROM writes WHERE day < ?', day);
    const today = num(one('SELECT SUM(n) AS n FROM uploads WHERE day = ?', day)?.n);
    if (today >= limits.perDay || written(day) >= limits.writesPerDay) {
      return { ok: false, error: 'rate-limited', retryAfter: untilTomorrow(now) };
    }
    return null;
  }

  return {
    run(request: LedgerRequest): LedgerReply {
      const { key, head, now } = request;
      switch (request.op) {
        case 'check':
          return refuse(key, head, now) ?? { ok: true };
        case 'reserve': {
          const refused = refuse(key, head, now);
          if (refused) return refused;
          const day = Math.floor(now / DAY_MS);
          const mine = num(
            one('SELECT n FROM uploads WHERE day = ? AND login = ?', day, request.login)?.n,
          );
          if (mine >= limits.perLogin) {
            return { ok: false, error: 'rate-limited', retryAfter: untilTomorrow(now) };
          }
          const made = room(key, request.bytes);
          if (!made) return { ok: false, error: 'full' };
          // The put and each eviction's delete are KV writes.
          if (written(day) + 1 + made.keys.length > limits.writesPerDay) {
            return { ok: false, error: 'rate-limited', retryAfter: untilTomorrow(now) };
          }
          for (const evicted of made.keys) sql.exec('DELETE FROM entries WHERE key = ?', evicted);
          sql.exec(
            `INSERT INTO writes (day, n) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET n = n + excluded.n`,
            day,
            1 + made.keys.length,
          );
          sql.exec(
            `INSERT INTO entries (key, head, bytes, stored_at, expires_at, bad) VALUES (?, ?, ?, ?, ?, 0)
             ON CONFLICT (key) DO UPDATE SET head = excluded.head, bytes = excluded.bytes,
               stored_at = excluded.stored_at, expires_at = excluded.expires_at, bad = 0`,
            key,
            head,
            request.bytes,
            now,
            now + limits.ttlMs,
          );
          sql.exec(
            `INSERT INTO uploads (day, login, n) VALUES (?, ?, 1)
             ON CONFLICT (day, login) DO UPDATE SET n = n + 1`,
            day,
            request.login,
          );
          return made.keys.length > 0 ? { ok: true, evict: made.keys } : { ok: true };
        }
        case 'release':
          sql.exec('DELETE FROM entries WHERE key = ? AND head = ?', key, head);
          return { ok: true };
        case 'bad':
          sql.exec('UPDATE entries SET bad = 1 WHERE key = ? AND head = ?', key, head);
          return { ok: true };
      }
    },
    /** For tests and the README's numbers. */
    totals(now: number) {
      const day = Math.floor(now / DAY_MS);
      return {
        today: num(one('SELECT SUM(n) AS n FROM uploads WHERE day = ?', day)?.n),
        writes: written(day),
        bytes: num(one('SELECT SUM(bytes) AS b FROM entries')?.b),
        entries: num(one('SELECT COUNT(*) AS c FROM entries')?.c),
      };
    },
  };
}

/** Reads a LedgerRequest from a JSON body, or null. */
export function parseLedgerRequest(body: unknown): LedgerRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.head !== 'string' || typeof r.now !== 'number') {
    return null;
  }
  const base = { key: r.key, head: r.head, now: r.now };
  switch (r.op) {
    case 'check':
    case 'release':
    case 'bad':
      return { op: r.op, ...base };
    case 'reserve':
      return typeof r.bytes === 'number' && typeof r.login === 'string'
        ? { op: 'reserve', ...base, bytes: r.bytes, login: r.login }
        : null;
    default:
      return null;
  }
}
