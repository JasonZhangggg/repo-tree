// The Ledger Durable Object (src/worker.ts) for Node: tests and scripts/local-worker.mjs run it
// on node:sqlite in memory, behind a namespace shaped like the binding Workers pass in env.
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/worker.ts';

/**
 * An `env.LEDGER` stand-in: every id reaches one Ledger, on its own in-memory database.
 * @param {Record<string, unknown>} [env] vars the Ledger reads (UPLOADS_PER_LOGIN, ...)
 */
export function ledgerNamespace(env = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = {
    /** Runs at once, as a Durable Object's sql.exec does. @param {string} query @param {...any} bindings */
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  };
  const ledger = new Ledger(/** @type {any} */ ({ storage: { sql } }), /** @type {any} */ (env));
  let calls = 0;
  return {
    /** Requests the Ledger answered. */
    get calls() {
      return calls;
    },
    idFromName: () => 'global',
    get: () => ({
      /** @param {string} url @param {RequestInit} init */
      fetch: (url, init) => {
        calls++;
        return ledger.fetch(new Request(url, init));
      },
    }),
  };
}
