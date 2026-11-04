/**
 * Reading a repo's snapshot trees into a TreeStore (store.ts), two ways.
 *
 * GraphQL (`graphqlLoader`, the default): every tree not yet in the store is asked for once,
 * fifty to a hundred to a query as aliased `object(oid:)` lookups, breadth first across all
 * snapshots at once. Each distinct tree object costs its entries once and no request of its own, so the
 * bytes follow what changed between snapshots. GraphQL needs a token; the loader backs off to
 * smaller batches when a query fails and gives up (leaving the rest to REST) when they keep
 * failing.
 *
 * REST (`restReader`, the fallback): a snapshot is read against the newer one already in the
 * store. Trees already read cost nothing; each changed folder is read whole (`?recursive=1`, one
 * request) or one level at a time, whichever an expected cost favours. That cost comes from the
 * newer snapshot's sizes, how often each subfolder changed along with its parent, and how busy
 * this interval looks in the level reads made so far. A truncated recursive listing keeps every
 * folder whose entries hash to its own sha, whatever order GitHub listed them in.
 */

import { GraphQLError, UpstreamError, isRecord } from './github';
import { MODE, TreeStore, type Entry, type Mode } from './store';

export { MODE, TreeStore };

const MODE_TEXT = ['100644', '100755', '120000', '40000', '160000'] as const;

export type Plan = {
  /** What one request costs, in the gzipped bytes it is worth. */
  requestBytes: number;
  /** Gzipped bytes per tree entry in a REST listing (the sha is most of it). */
  entryBytes: number;
  /** How likely a child folder changed when its parent did, before anything was seen of it. */
  prior: number;
  /** Weight of that prior against what was seen, in intervals. */
  priorWeight: number;
  /** The same odds before any interval was read (1 reads the first changed folders whole). */
  firstPrior: number;
  /** How much each older interval counts against the next newer one in those odds (0 to 1). */
  decay: number;
  /** Scale the odds by how busy the interval looks in the level reads made so far. */
  adapt: boolean;
};

/**
 * Tuned on linux and vite against scripts/fake-github.mjs (scripts/measure.mjs --plan --reader
 * rest). A tree entry costs 37 to 40 gzipped bytes as REST serves it, the url about 3 of them.
 * Linux, 65 snapshots, REST only (before snapshots kept to the first-parent chain):
 *   requestBytes  6,000: 6,015 tree requests, 4.24M entries listed
 *   requestBytes 12,000: 1,574 tree requests, 4.80M entries (the default)
 *   requestBytes 25,000:   988 tree requests, 5.11M entries
 * Without `adapt` the default cost 2,648 requests for 5.01M entries.
 */
export const DEFAULT_PLAN: Plan = {
  requestBytes: 12_000,
  entryBytes: 40,
  prior: 0.1,
  priorWeight: 1,
  firstPrior: 1,
  decay: 1,
  adapt: true,
};

/**
 * What was seen of a folder so far, in intervals in which its parent changed: `changed` of
 * `seen` also changed (older intervals discounted). Undefined for a folder never seen.
 */
export type ChangeStats = (path: string) => { changed: number; seen: number } | undefined;

export type ReadStats = {
  requests: number;
  recursive: number;
  level: number;
  /** Folders kept from truncated listings because their entries hash to their sha. */
  salvaged: number;
  truncated: number;
  /** Entries listed by all those requests. */
  entries: number;
};

type Flat = { path: string; mode: Mode; sha: string };

function modeOf(text: unknown, type: unknown): Mode | null {
  switch (text) {
    case '100644':
    case 0o100644:
      return MODE.file;
    case '100755':
    case 0o100755:
      return MODE.exec;
    case '120000':
    case 0o120000:
      return MODE.link;
    case '040000':
    case '40000':
    case 0o40000:
      return MODE.tree;
    case '160000':
    case 0o160000:
      return MODE.module;
  }
  if (type === 'tree') return MODE.tree;
  if (type === 'commit') return MODE.module;
  return type === 'blob' ? MODE.file : null;
}

/** Reads a /git/trees body, submodules included (they count toward a folder's sha). */
export function parseListing(body: unknown): { entries: Flat[]; truncated: boolean } {
  if (!isRecord(body) || !Array.isArray(body.tree)) throw new UpstreamError('upstream');
  const entries: Flat[] = [];
  for (const e of body.tree as unknown[]) {
    if (!isRecord(e) || typeof e.path !== 'string' || typeof e.sha !== 'string') continue;
    const mode = modeOf(e.mode, e.type);
    if (mode !== null) entries.push({ path: e.path, mode, sha: e.sha });
  }
  return { entries, truncated: body.truncated === true };
}

/** git's object id for a tree with these entries, in this order. */
async function treeSha(entries: readonly Entry[]): Promise<string> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const e of entries) {
    const head = enc.encode(`${MODE_TEXT[e.mode]} ${e.name}\0`);
    const id = new Uint8Array(20);
    for (let i = 0; i < 20; i++) id[i] = parseInt(e.oid.slice(2 * i, 2 * i + 2), 16);
    parts.push(head, id);
    length += head.length + 20;
  }
  const prefix = enc.encode(`tree ${length}\0`);
  const all = new Uint8Array(prefix.length + length);
  all.set(prefix);
  let at = prefix.length;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Stores the folders of a recursive listing of tree `sha`. A truncated listing keeps only the
 * folders whose entries hash to their sha. Returns how many folders were kept that way.
 */
async function storeListing(
  store: TreeStore,
  sha: string,
  entries: readonly Flat[],
  truncated: boolean,
): Promise<number> {
  const groups = new Map<string, Entry[]>();
  const shaOf = new Map<string, string>([['', sha]]);
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const folder = slash < 0 ? '' : e.path.slice(0, slash);
    let g = groups.get(folder);
    if (!g) groups.set(folder, (g = []));
    g.push({ name: slash < 0 ? e.path : e.path.slice(slash + 1), mode: e.mode, oid: e.sha });
    if (e.mode === MODE.tree) shaOf.set(e.path, e.sha);
  }
  let kept = 0;
  for (const [folder, list] of groups) {
    const oid = shaOf.get(folder);
    if (!oid || store.has(oid)) continue;
    if (truncated) {
      if ((await treeSha(list)) !== oid) continue;
      kept++;
    }
    store.add(store.id(oid), list);
  }
  return kept;
}

export type TreeFetch = (sha: string, recursive: boolean, snapshot: number) => Promise<unknown>;

export type RestReader = {
  /**
   * Makes snapshot `snapshot`'s tree `sha` complete in the store, read against the newer
   * snapshot's tree `newer` (-1 for none). Returns its tree id. `changes(path)` says how often
   * that folder changed along with its parent; `intervals` counts the intervals folded so far.
   */
  read(
    sha: string,
    newer: number,
    changes: ChangeStats,
    intervals: number,
    snapshot: number,
  ): Promise<number>;
  /** Starts reading tree `sha` whole before its turn (a snapshot expected to be read whole). */
  prefetch(sha: string, snapshot: number): void;
  /** Whether the last `read` fetched its root whole. */
  readonly lastWhole: boolean;
  readonly stats: ReadStats;
};

/**
 * A pruned REST reader over `fetchTree`, which returns a /git/trees body (and may run several
 * at a time; the caller bounds concurrency).
 */
export function restReader(
  fetchTree: TreeFetch,
  store: TreeStore,
  partial: Partial<Plan> = {},
): RestReader {
  const plan: Plan = { ...DEFAULT_PLAN, ...partial };
  const stats: ReadStats = {
    requests: 0,
    recursive: 0,
    level: 0,
    salvaged: 0,
    truncated: 0,
    entries: 0,
  };
  /** Reads in flight by tree id, so no tree is asked for twice at once. */
  const pending = new Map<number, Promise<void>>();
  let lastWhole = false;

  async function list(sha: string, recursive: boolean, snapshot: number) {
    stats.requests++;
    if (recursive) stats.recursive++;
    else stats.level++;
    const listing = parseListing(await fetchTree(sha, recursive, snapshot));
    if (listing.truncated) stats.truncated++;
    stats.entries += listing.entries.length;
    return listing;
  }

  /** Reads tree `sha` whole into the store (what it can of a truncated listing). */
  function whole(sha: string, snapshot: number): Promise<void> {
    const t = store.id(sha);
    const known = pending.get(t);
    if (known) return known;
    const p = (async () => {
      const { entries, truncated } = await list(sha, true, snapshot);
      stats.salvaged += await storeListing(store, sha, entries, truncated);
    })().finally(() => pending.delete(t));
    pending.set(t, p);
    return p;
  }

  /** Reads tree `sha`'s own entries into the store. */
  function level(sha: string, snapshot: number): Promise<void> {
    const t = store.id(sha);
    const known = pending.get(t);
    if (known) return known;
    const p = (async () => {
      const { entries } = await list(sha, false, snapshot);
      store.add(
        t,
        entries.map((e) => ({ name: e.path, mode: e.mode, oid: e.sha })),
      );
    })().finally(() => pending.delete(t));
    pending.set(t, p);
    return p;
  }

  function prefetch(sha: string, snapshot: number) {
    if (store.has(sha) || pending.has(store.id(sha))) return;
    whole(sha, snapshot).catch(() => undefined);
  }

  async function read(
    rootSha: string,
    newer: number,
    changes: ChangeStats,
    intervals: number,
    snapshot: number,
  ): Promise<number> {
    lastWhole = false;
    // How busy this interval is next to the ones learnt from: subfolders seen to change in the
    // level reads so far, against how many the odds predicted. Busy and quiet weeks alternate
    // (a merge window, then release candidates), so the odds follow it within the snapshot.
    let predicted = 0;
    let observed = 0;
    const busy = () => (plan.adapt ? (observed + 2) / (predicted + 2) : 1);

    /** What was learnt of a folder: the chance it changed, given that its parent did. */
    const learnt = (path: string) => {
      if (intervals === 0) return plan.firstPrior;
      const w = plan.priorWeight;
      const seen = changes(path);
      return seen ? (seen.changed + plan.prior * w) / (seen.seen + w) : plan.prior;
    };
    const odds = (path: string) => Math.min(1, learnt(path) * busy());

    /** Expected cost of reading a changed folder shaped like `old`, choosing well below it. */
    const cost = (old: number, path: string, memo: Map<number, number>): number => {
      const known = memo.get(old);
      if (known !== undefined) return known;
      const all = plan.requestBytes + plan.entryBytes * store.count(old);
      const n = store.length(old);
      let lvl = plan.requestBytes + plan.entryBytes * n;
      for (let i = 0; i < n && lvl < all; i++) {
        if (!store.isTree(old, i)) continue;
        const kidPath = join(path, store.name(old, i));
        lvl += odds(kidPath) * cost(store.ref(old, i), kidPath, memo);
      }
      const best = Math.min(all, lvl);
      memo.set(old, best);
      return best;
    };

    const chooseWhole = (old: number, path: string): boolean => {
      // A folder new at this path has no sizes to go by; most are small, so read it whole.
      if (old < 0 || !store.complete(old)) return true;
      // An over-limit listing would be cut short; read those a level at a time.
      if (store.count(old) > 90_000) return false;
      const all = plan.requestBytes + plan.entryBytes * store.count(old);
      return all <= cost(old, path, new Map());
    };

    const kidOf = (old: number, name: string): number => {
      if (old < 0 || !store.loaded(old)) return -1;
      const i = store.find(old, name, true);
      return i < 0 ? -1 : store.ref(old, i);
    };

    /** Makes the folder `sha` at `path` complete; `old` is its counterpart in `newer`. */
    async function resolve(sha: string, old: number, path: string): Promise<void> {
      const t = store.id(sha);
      if (store.complete(t)) return;
      if (!store.loaded(t)) {
        const busyRead = pending.get(t);
        if (busyRead) await busyRead;
        else if (chooseWhole(old, path)) {
          if (path === '') lastWhole = true;
          await whole(sha, snapshot);
        }
        if (!store.loaded(t)) await level(sha, snapshot);
        else if (store.complete(t)) return;
      }
      // Read a level (or kept from a cut-short listing): fill in what is missing below.
      const n = store.length(t);
      const missing: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!store.isTree(t, i)) continue;
        const kid = store.ref(t, i);
        if (store.complete(kid)) continue;
        missing.push(i);
        if (old >= 0 && intervals > 0) {
          const was = kidOf(old, store.name(t, i));
          if (was >= 0) {
            predicted += learnt(join(path, store.name(t, i)));
            if (was !== kid) observed++;
          }
        }
      }
      // Many unread subfolders and no newer counterpart to go by (the tail of a cut-short
      // listing): one whole read of this folder beats a request for each.
      if (old < 0 && path !== '' && missing.length > 4) {
        let held = 0;
        for (let i = 0; i < n; i++) {
          if (store.isTree(t, i)) held += Math.max(0, store.count(store.ref(t, i)));
        }
        if (missing.length * plan.requestBytes > plan.entryBytes * held) {
          await whole(sha, snapshot);
          if (store.complete(t)) return;
        }
      }
      await Promise.all(
        missing.map((i) => {
          const name = store.name(t, i);
          return resolve(store.oids[store.ref(t, i)]!, kidOf(old, name), join(path, name));
        }),
      );
    }

    await resolve(rootSha, newer, '');
    return store.id(rootSha);
  }

  return {
    read,
    prefetch,
    get lastWhole() {
      return lastWhole;
    },
    stats,
  };
}

export type LoaderStats = {
  queries: number;
  /** Queries GitHub failed (timeouts and errors), each retried in smaller batches. */
  failed: number;
  trees: number;
  entries: number;
  /** Largest batch that went through. */
  batch: number;
};

export type GraphQLLoader = {
  /** Queues a tree (and, as it arrives, everything below it) to be read. */
  add(sha: string): void;
  /** Settles when the queue is empty, or GraphQL gave up (then `gaveUp` is set). */
  drain(): Promise<void>;
  readonly gaveUp: boolean;
  readonly stats: LoaderStats;
};

export type GraphQLOptions = {
  /** Trees per query to start with; halves after a failed query, grows back after successes. */
  batch: number;
  maxBatch: number;
  /** Queries in flight at once. */
  concurrency: number;
  /** Failed queries in a row (at a batch of one) before giving up on GraphQL. */
  giveUpAfter: number;
};

/**
 * Reads trees with GitHub's GraphQL API, many per query. GitHub does not publish what such a
 * query costs: one point each (no connections) by its documented formula; a reply must finish
 * within ten seconds; secondary limits apply. Batches therefore start at fifty trees, halve on
 * any failure and grow back slowly, and a tree that fails alone is left for REST.
 */
export function graphqlLoader(
  query: (q: string) => Promise<Record<string, unknown>>,
  repo: { owner: string; name: string },
  store: TreeStore,
  partial: Partial<GraphQLOptions> = {},
): GraphQLLoader {
  const options: GraphQLOptions = {
    batch: 50,
    maxBatch: 100,
    concurrency: 4,
    giveUpAfter: 3,
    ...partial,
  };
  const stats: LoaderStats = { queries: 0, failed: 0, trees: 0, entries: 0, batch: 0 };
  const queue: string[] = [];
  const queued = new Set<number>();
  /** Trees that failed alone: left for the REST reader. */
  const skipped = new Set<number>();
  let batch = options.batch;
  let streak = 0;
  let failedAlone = 0;
  let inFlight = 0;
  let gaveUp = false;
  let fatal: unknown = null;
  let settle: (() => void) | null = null;

  const owner = JSON.stringify(repo.owner);
  const name = JSON.stringify(repo.name);

  function add(sha: string) {
    const t = store.id(sha);
    if (store.loaded(t) || queued.has(t) || skipped.has(t)) return;
    queued.add(t);
    queue.push(sha);
    pump();
  }

  function pump() {
    // A part batch goes only when nothing else is in flight: replies queue the next level, so
    // waiting for them fills batches (a level of every snapshot's trees at once).
    while (
      !gaveUp &&
      inFlight < options.concurrency &&
      queue.length > 0 &&
      (queue.length >= batch || inFlight === 0)
    ) {
      const take = queue.splice(0, batch);
      inFlight++;
      void send(take).finally(() => {
        inFlight--;
        pump();
      });
    }
    if (inFlight === 0 && (queue.length === 0 || gaveUp)) settle?.();
  }

  async function send(shas: string[]) {
    const body = shas
      .map((sha, i) => `t${i}:object(oid:"${sha}"){...on Tree{entries{name oid mode}}}`)
      .join(' ');
    stats.queries++;
    let data: Record<string, unknown>;
    try {
      data = await query(`query{repository(owner:${owner},name:${name}){${body}}}`);
    } catch (error) {
      if (!(error instanceof GraphQLError) && !(error instanceof UpstreamError)) {
        fatal = error;
        gaveUp = true;
        return;
      }
      if (error instanceof UpstreamError && error.kind === 'unauthorized') {
        fatal = error;
        gaveUp = true;
        return;
      }
      stats.failed++;
      streak = 0;
      if (shas.length === 1) {
        // Alone and still failing: REST reads it; GraphQL is given up after a few of these.
        const t = store.id(shas[0]!);
        queued.delete(t);
        skipped.add(t);
        if (++failedAlone >= options.giveUpAfter) gaveUp = true;
        return;
      }
      batch = Math.max(1, Math.floor(shas.length / 2));
      queue.unshift(...shas);
      return;
    }
    const repoData = isRecord(data.repository) ? data.repository : null;
    if (!repoData) {
      gaveUp = true;
      return;
    }
    failedAlone = 0;
    stats.batch = Math.max(stats.batch, shas.length);
    if (++streak >= 3 && batch < options.maxBatch) {
      batch = Math.min(options.maxBatch, Math.ceil(batch * 1.5));
      streak = 0;
    }
    shas.forEach((sha, i) => {
      const t = store.id(sha);
      queued.delete(t);
      const obj = repoData[`t${i}`];
      const raw = isRecord(obj) && Array.isArray(obj.entries) ? obj.entries : null;
      if (!raw) {
        skipped.add(t);
        return;
      }
      const entries: Entry[] = [];
      for (const e of raw as unknown[]) {
        if (!isRecord(e) || typeof e.name !== 'string' || typeof e.oid !== 'string') continue;
        const mode = modeOf(e.mode, undefined);
        if (mode !== null) entries.push({ name: e.name, mode, oid: e.oid });
      }
      store.add(t, entries);
      stats.trees++;
      stats.entries += entries.length;
      for (const e of entries) if (e.mode === MODE.tree) add(e.oid);
    });
  }

  return {
    add,
    drain() {
      return new Promise<void>((resolve, reject) => {
        settle = () => (fatal ? reject(fatal) : resolve());
        pump();
      });
    },
    get gaveUp() {
      return gaveUp;
    },
    stats,
  };
}

const join = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);
