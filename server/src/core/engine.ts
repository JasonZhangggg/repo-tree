/**
 * The history computation in one pass, for a host that can hold a repo's trees in memory and
 * wait as long as it takes: the visitor's browser (a Web Worker), with the visitor's token.
 * It reads what src/core/job.ts reads and yields the same History (summarize.ts), but:
 *
 * - snapshot trees are read pruned and incrementally (trees.ts): only folders whose sha changed
 *   since the newer snapshot are fetched, each whole or a level at a time, whichever costs less;
 * - snapshots are folded as diffs of neighbouring trees, so the work per snapshot follows what
 *   changed, not the size of the repo, and paths are rows in typed arrays, not a map per snapshot;
 * - requests run several at a time (trees first, then probes, then recent commits), the probes
 *   alongside the trees, and the recent commits alongside both.
 *
 * Rejects with the signal's reason on abort, and with UpstreamError when GitHub refuses.
 */

import { GONE_CAP, type Gap, type History } from '../shape';
import { CODEOWNERS_PATHS, parseCodeowners, type OwnerRule } from './codeowners';
import {
  UpstreamError,
  gitHub,
  isRecord,
  lastPage,
  toChanges,
  toCommits,
  type CommitSummary,
  type FileChange,
} from './github';
import {
  DEFAULT_LIMITS,
  countAuthors,
  listed,
  schedule,
  touchCommit,
  type AccRow,
  type Counts,
  type Listed,
  type Sample,
  type TouchRow,
} from './job';
import { summarize, type Folded } from './summarize';
import { DEFAULT_PLAN, MODE, treeReader, type Node, type Plan, type ReadStats } from './trees';

export type EngineOptions = {
  fetch: typeof fetch;
  /** e.g. https://api.github.com */
  api: string;
  token?: string;
  /** owner/repo */
  repo: string;
  branch: string;
  signal?: AbortSignal;
  /** 0 to 1. */
  onProgress?: (progress: number) => void;
  /** GitHub requests in flight at once. Browsers allow about six per host over HTTP/1.1. */
  concurrency?: number;
  /** Newest non-merge commits read one by one. */
  recentCommits?: number;
  /** Snapshots compared, the head and the root included. */
  maxSnapshots?: number;
  plan?: Partial<Plan>;
  now?: () => number;
  /**
   * Tree entries the snapshots may list in all (Infinity, the default, for no cap). Past it,
   * the schedule is thinned evenly once the head's size is known: a Linux-sized repo lists
   * about 90% of its head per snapshot, so 2,000,000 entries (about 75 MB) is about 20.
   */
  treeBudget?: number;
  /** Called once at the end with what the run cost, for measurement. */
  onStats?: (stats: EngineStats) => void;
};

export type EngineStats = {
  requests: { listings: number; trees: number; commits: number; blobs: number };
  trees: ReadStats;
  snapshots: number;
  rows: number;
  /** Probes were sent all at once (a busy repo) rather than one after another. */
  parallelProbes: boolean;
  /** Tree requests and entries listed for each snapshot, newest first. */
  perSnapshot: { requests: number; entries: number }[];
};

const PER_PAGE = 100;
/** Share of the head an older snapshot lists, for the tree budget (Linux: 0.85 to 0.95). */
const TYPICAL_SHARE = 0.9;
const MIN_TARGETS = 6;
/** Snapshots read ahead while they are read whole (small and medium repos). */
const PREFETCH = 4;
/** Only trees this small: a bigger one would come back truncated whole. */
const PREFETCH_BELOW = 80_000;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Request priorities: the tree chain is the critical path. */
const TREES = 0;
const PROBES = 1;
const RECENT = 2;

export async function computeHistory(options: EngineOptions): Promise<History> {
  const { signal, repo, branch } = options;
  const recentCommits = options.recentCommits ?? DEFAULT_LIMITS.recentCommits;
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_LIMITS.maxSnapshots;
  const plan = { ...DEFAULT_PLAN, ...options.plan };
  const gh = gitHub({
    fetch: options.fetch,
    api: options.api,
    ...(options.token ? { token: options.token } : {}),
    limit: Infinity,
    ...(signal ? { signal } : {}),
  });
  const pool = createPool(options.concurrency ?? 6, signal);
  const base = `/repos/${repo}`;
  const counts = { listings: 0, trees: 0, commits: 0, blobs: 0 };
  const get = (path: string, priority: number, kind: keyof typeof counts) =>
    pool.run(priority, () => {
      counts[kind]++;
      return gh.json(path);
    });
  const list = async (query: string, priority: number) => {
    const { body, link } = await get(`${base}/commits?${query}`, priority, 'listings');
    return { commits: toCommits(body), link };
  };

  // The newest page: the head, the recent commits and, for a short history, the root.
  const gaps: Gap[] = [];
  const first = await list(`sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}`, PROBES);
  const headCommit = first.commits[0];
  if (!headCommit) throw new UpstreamError('empty');
  const head: Sample = { sha: headCommit.sha, at: headCommit.at, tree: headCommit.tree };
  const firstListing = first.commits.map(listed);
  const firstComplete = first.commits.length < PER_PAGE;
  const nonMerge = first.commits.filter((c) => !c.merge);
  const recent = nonMerge.slice(0, recentCommits).map(listed);
  const recentIsAll = firstComplete && recent.length === nonMerge.length;

  let root: Sample | null = null;
  if (firstComplete) {
    const last = first.commits[first.commits.length - 1]!;
    root = { sha: last.sha, at: last.at, tree: last.tree };
  } else {
    const { link } = await list(`sha=${head.sha}&per_page=1`, PROBES);
    const pages = lastPage(link);
    const found = pages
      ? (await list(`sha=${head.sha}&per_page=1&page=${pages}`, PROBES)).commits[0]
      : undefined;
    if (found) root = { sha: found.sha, at: found.at, tree: found.tree };
    else gaps.push('root-unknown');
  }
  // Thinned once the head's size is known, when a tree budget is set.
  let targets = schedule(head.at, root?.at ?? null, maxSnapshots);
  let headEntries = 0;
  let headRead = (): void => undefined;
  const headDone = new Promise<void>((resolve) => (headRead = resolve));
  const pickTargets = async () => {
    const budget = options.treeBudget ?? Infinity;
    if (!Number.isFinite(budget)) return targets;
    await headDone;
    if (headEntries === 0) return targets;
    // Older snapshots list about as much as the head when little of them is shared.
    const room = Math.floor(budget / (TYPICAL_SHARE * headEntries)) - 2;
    targets = thin(targets, Math.max(MIN_TARGETS, room));
    return targets;
  };

  const progress = { probes: 0, trees: 0, recent: 0 };
  const report = () => {
    const part = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 1);
    options.onProgress?.(
      0.02 +
        0.08 * part(progress.probes, targets.length) +
        0.75 * part(progress.trees, targets.length + 2) +
        0.15 * part(progress.recent, recent.length),
    );
  };
  report();

  // Recent commits, alongside everything else; folded newest first once all are in.
  const recentTask = Promise.all(
    recent.map(async (c) => {
      const { body } = await get(`${base}/commits/${c.sha}`, RECENT, 'commits');
      progress.recent++;
      report();
      return toChanges(body);
    }),
  );
  recentTask.catch(() => undefined);

  const span = head.at - (firstListing[firstListing.length - 1]?.at ?? head.at);
  // A page of 100 commits that spans under half a week will not reach the next weekly target,
  // so every target takes its own request anyway: send them all at once.
  const parallelProbes = !firstComplete && span < 3.5 * DAY;
  const samples = probeSamples({
    head,
    root,
    targets: pickTargets,
    first: firstListing,
    complete: firstComplete,
    parallel: parallelProbes,
    page: (t) =>
      list(`sha=${head.sha}&until=${iso(t)}&per_page=${PER_PAGE}`, PROBES).then((r) => {
        progress.probes++;
        report();
        return r.commits;
      }),
    signal,
  });

  const rows = new Rows();
  const reader = treeReader(
    async (sha, recursive) =>
      (await get(`${base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, TREES, 'trees'))
        .body,
    plan,
  );
  const fold = new Fold(rows);
  fold.decay = plan.decay;
  const sampled: Sample[] = [];
  const perSnapshot: EngineStats['perSnapshot'] = [];
  let newer: Node | null = null;
  let codeownersSha: string | null = null;
  // Probes run ahead of the trees: samples land here as they are found.
  const found: { sample: Sample; between: Counts }[] = [];
  let probing = true;
  let wake = (): void => undefined;
  const probed = (async () => {
    try {
      for await (const s of samples) {
        found.push(s);
        wake();
      }
    } finally {
      probing = false;
      wake();
    }
  })();
  probed.catch(() => undefined);
  const next = async (j: number) => {
    while (found.length <= j && probing) await new Promise<void>((r) => (wake = r));
    if (found.length <= j) await probed;
    return found[j];
  };

  for (let j = 0; ; j++) {
    const item = await next(j);
    if (!item) break;
    signal?.throwIfAborted();
    const { sample, between } = item;
    sampled.push(sample);
    const before = { ...reader.stats };
    const tree: Node = await reader
      .read(sample.tree, newer, fold.changes, Math.max(0, j - 1))
      .catch((error: unknown) => {
        headRead();
        throw error;
      });
    // A snapshot read whole will likely be followed by more: start the next few now.
    // (Those are older than `tree`, so seldom bigger: repos mostly grow.)
    if (reader.lastWhole && tree.count < PREFETCH_BELOW) {
      for (const ahead of found.slice(j + 1, j + 1 + PREFETCH)) reader.prefetch(ahead.sample.tree);
    }
    if (!newer) {
      headEntries = tree.count;
      headRead();
      fold.head(tree);
      codeownersSha = findCodeowners(tree);
    } else fold.diff(newer, tree, j, between);
    newer = tree;
    perSnapshot.push({
      requests: reader.stats.requests - before.requests,
      entries: reader.stats.entries - before.entries,
    });
    progress.trees++;
    report();
  }
  fold.finish(sampled.length - 1);

  let codeowners: OwnerRule[] = [];
  const owners = codeownersSha
    ? get(`${base}/git/blobs/${codeownersSha}`, TREES, 'blobs').then(
        ({ body }) => {
          if (!isRecord(body) || typeof body.content !== 'string')
            throw new UpstreamError('upstream');
          const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, '')), (c) =>
            c.charCodeAt(0),
          );
          codeowners = parseCodeowners(new TextDecoder().decode(bytes));
        },
        (error: unknown) => {
          if (signal?.aborted) throw error;
          gaps.push('codeowners-unread');
        },
      )
    : Promise.resolve();

  const [changes] = await Promise.all([recentTask, owners]);
  const touched: Record<string, TouchRow> = {};
  const commitsBy: Record<string, Counts> = {};
  recent.forEach((c, i) => touchCommit({ touched, commitsBy }, c, changes[i] as FileChange[]));

  const folded: Folded = {
    repo,
    branch,
    head,
    gaps,
    samples: sampled,
    applied: sampled.map((_, j) => j),
    acc: rows.acc(),
    weights: fold.weights,
    recent,
    recentIsAll,
    recentNext: recent.length,
    touched,
    commitsBy,
    codeowners,
    headTruncated: false,
  };
  options.onStats?.({
    requests: counts,
    trees: reader.stats,
    snapshots: sampled.length,
    rows: rows.n,
    parallelProbes,
    perSnapshot,
  });
  options.onProgress?.(1);
  return summarize(folded, (options.now ?? Date.now)());
}

type Probing = {
  head: Sample;
  root: Sample | null;
  /** Target times, newest first; asked once the head has been read. */
  targets: () => Promise<readonly number[]>;
  first: Listed[];
  complete: boolean;
  parallel: boolean;
  page: (target: number) => Promise<CommitSummary[]>;
  signal: AbortSignal | undefined;
};

/**
 * The snapshots newest first, each with the authors of the listed commits between it and the
 * newer one: the same choices as job.ts's probe phase, one commit per target time, a page reused
 * while it reaches the next target. With `parallel` every target's page is asked for at once.
 */
async function* probeSamples(p: Probing): AsyncGenerator<{ sample: Sample; between: Counts }> {
  yield { sample: p.head, between: {} };
  const targets = await p.targets();
  const pages = p.parallel ? targets.map((t) => p.page(t)) : [];
  for (const page of pages) page.catch(() => undefined);
  let listing = p.first;
  let complete = p.complete;
  let newer = p.head;
  for (let k = 0; k < targets.length; k++) {
    p.signal?.throwIfAborted();
    const target = targets[k]!;
    const oldestListed = listing[listing.length - 1];
    const covers = oldestListed !== undefined && (oldestListed.at <= target || complete);
    let found: Listed | undefined;
    let between: Counts;
    if (covers) {
      found = listing.find((c) => c.at <= target);
      between = found ? countAuthors(listing, found.at, newer.at) : {};
    } else {
      between = countAuthors(listing, target, newer.at);
      const commits = await (pages[k] ?? p.page(target));
      listing = commits.map(listed);
      complete = commits.length < PER_PAGE;
      found = listing[0];
    }
    if (!found) break;
    if (found.sha === newer.sha) continue;
    newer = { sha: found.sha, at: found.at, tree: found.tree };
    yield { sample: newer, between };
  }
  if (p.root && p.root.sha !== newer.sha && p.root.at < newer.at) {
    yield { sample: p.root, between: countAuthors(listing, p.root.at, newer.at) };
  }
}

/** `n` of the targets, spread evenly over the list (which is already denser near the head). */
export function thin(targets: readonly number[], n: number): number[] {
  if (targets.length <= n) return [...targets];
  if (n <= 1) return targets.slice(0, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(targets[Math.round((i * (targets.length - 1)) / (n - 1))]!);
  return out;
}

/** The CODEOWNERS blob GitHub would use, from the head tree. */
function findCodeowners(root: Node): string | null {
  for (const path of CODEOWNERS_PATHS) {
    let node: Node | null = root;
    const parts = path.split('/');
    for (let i = 0; node && i < parts.length; i++) {
      const at = node.names.indexOf(parts[i]!);
      if (at < 0) node = null;
      else if (i === parts.length - 1) {
        if (node.modes[at] !== MODE.tree && node.modes[at] !== MODE.module) return node.shas[at]!;
        node = null;
      } else node = node.kids[at] ?? null;
    }
  }
  return null;
}

/** A priority queue of tasks, `size` at a time. Queued tasks reject once `signal` aborts. */
function createPool(size: number, signal: AbortSignal | undefined) {
  const queues: (() => void)[][] = [[], [], []];
  let active = 0;
  const pump = () => {
    while (active < size) {
      const next = queues.find((q) => q.length > 0)?.shift();
      if (!next) return;
      active++;
      next();
    }
  };
  return {
    run<T>(priority: number, task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queues[priority]!.push(() => {
          const done = () => {
            active--;
            pump();
          };
          if (signal?.aborted) {
            reject(signal.reason);
            done();
            return;
          }
          task().then(resolve, reject).finally(done);
        });
        pump();
      });
    },
  };
}

const RUN = 1;
const VERSION = 2;

/**
 * One row per path ever folded: head paths, deleted files (up to GONE_CAP of them, as job.ts
 * keeps), and the folders that hold those. Columns are typed arrays indexed by row; children
 * are found through a per-folder map keyed by name (`name/` for a folder).
 */
class Rows {
  n = 0;
  parent = new Int32Array(1024);
  newest = new Int16Array(1024);
  oldest = new Int16Array(1024);
  version = new Int16Array(1024);
  churn = new Uint16Array(1024);
  flags = new Uint8Array(1024);
  folder = new Uint8Array(1024);
  /** Folders: discounted intervals in which the parent changed, and in which this one did too. */
  seen = new Float32Array(1024);
  changed = new Float32Array(1024);
  names: string[] = [];
  kids: (Map<string, number> | undefined)[] = [];

  constructor() {
    this.add(-1, '', true, 0);
  }

  add(parent: number, name: string, folder: boolean, j: number): number {
    const r = this.n++;
    if (r === this.parent.length) this.grow();
    this.parent[r] = parent;
    this.newest[r] = j;
    this.oldest[r] = j;
    this.version[r] = j;
    this.flags[r] = RUN | VERSION;
    this.folder[r] = folder ? 1 : 0;
    this.names.push(name);
    this.kids.push(undefined);
    if (parent >= 0) (this.kids[parent] ??= new Map()).set(folder ? `${name}/` : name, r);
    return r;
  }

  find(parent: number, name: string, folder: boolean): number | undefined {
    return parent < 0 ? undefined : this.kids[parent]?.get(folder ? `${name}/` : name);
  }

  private grow() {
    const size = this.parent.length * 2;
    const widen = <A extends Int32Array | Int16Array | Uint16Array | Uint8Array | Float32Array>(
      a: A,
      make: (n: number) => A,
    ) => {
      const b = make(size);
      b.set(a);
      return b;
    };
    this.parent = widen(this.parent, (n) => new Int32Array(n));
    this.newest = widen(this.newest, (n) => new Int16Array(n));
    this.oldest = widen(this.oldest, (n) => new Int16Array(n));
    this.version = widen(this.version, (n) => new Int16Array(n));
    this.churn = widen(this.churn, (n) => new Uint16Array(n));
    this.flags = widen(this.flags, (n) => new Uint8Array(n));
    this.folder = widen(this.folder, (n) => new Uint8Array(n));
    this.seen = widen(this.seen, (n) => new Float32Array(n));
    this.changed = widen(this.changed, (n) => new Float32Array(n));
  }

  /** The rows summarize reads, keyed by path: every file row and the head's folders. */
  acc(): Record<string, AccRow> {
    const paths: string[] = new Array(this.n);
    const out: Record<string, AccRow> = {};
    for (let r = 0; r < this.n; r++) {
      const p = this.parent[r]!;
      paths[r] = p < 0 ? '' : p === 0 ? this.names[r]! : `${paths[p]}/${this.names[r]}`;
      const folder = this.folder[r] === 1;
      if (folder && this.newest[r] !== 0) continue;
      // A deleted file whose path a head folder now holds gives way to the folder.
      const held = out[paths[r]!];
      if (held && held[0] === 0) continue;
      out[paths[r]!] = [
        this.newest[r]!,
        this.oldest[r]!,
        this.version[r]!,
        this.churn[r]!,
        '',
        folder ? 1 : 0,
      ];
    }
    return out;
  }
}

/** Folds snapshots into Rows, the head first, then each older one as a diff against the newer. */
class Fold {
  weights: Record<string, Counts> = {};
  private goneRows = 0;
  private goneFullAt = -1;
  /** Head folders by path, for the reader's change odds. */
  private folders = new Map<string, number>();

  private rows: Rows;

  constructor(rows: Rows) {
    this.rows = rows;
  }

  /**
   * How often the head folder at `path` changed along with its parent, older intervals
   * discounted by `decay` each (for the reader's choice between whole and level reads).
   */
  readonly changes = (path: string) => {
    const r = this.folders.get(path);
    if (r === undefined || this.rows.seen[r] === 0) return undefined;
    return { changed: this.rows.changed[r]!, seen: this.rows.seen[r]! };
  };

  /** Weight of each older interval against the newer one in `changes`. */
  decay = DEFAULT_PLAN.decay;

  head(root: Node): void {
    const visit = (node: Node, row: number, path: string) => {
      for (let i = 0; i < node.names.length; i++) {
        const mode = node.modes[i]!;
        if (mode === MODE.module) continue;
        const name = node.names[i]!;
        if (mode === MODE.tree) {
          const r = this.rows.add(row, name, true, 0);
          const kidPath = path ? `${path}/${name}` : name;
          this.folders.set(kidPath, r);
          visit(node.kids[i]!, r, kidPath);
        } else this.rows.add(row, name, false, 0);
      }
    };
    this.folders.set('', 0);
    visit(root, 0, '');
  }

  /** Snapshot j (older) against j - 1 (newer), with the authors listed between them. */
  diff(newer: Node, older: Node, j: number, between: Counts): void {
    if (newer === older) return;
    this.weigh(newer, older, between);
    this.walk(newer, older, 0, j);
  }

  /** Rows still open reach the oldest snapshot. */
  finish(last: number): void {
    const { rows } = this;
    for (let r = 0; r < rows.n; r++) {
      if (rows.flags[r]! & RUN) rows.oldest[r] = last;
      if (rows.flags[r]! & VERSION) rows.version[r] = last;
    }
  }

  private full(j: number) {
    return this.goneFullAt >= 0 && j > this.goneFullAt;
  }

  /** The path's sha differs between j - 1 and j. */
  private change(r: number, j: number) {
    const { rows } = this;
    const f = rows.flags[r]!;
    if (!(f & RUN)) return;
    rows.churn[r]!++;
    if (f & VERSION) {
      rows.version[r] = j - 1;
      rows.flags[r] = f & ~VERSION;
    }
  }

  /** The path is at j - 1 but not at j: its run ends at j - 1. */
  private close(r: number, j: number) {
    const { rows } = this;
    const f = rows.flags[r]!;
    if (f & RUN) rows.oldest[r] = j - 1;
    if (f & VERSION) rows.version[r] = j - 1;
    rows.flags[r] = 0;
  }

  private walk(newer: Node, older: Node, row: number, j: number) {
    if (row >= 0) this.change(row, j);
    const at = new Map<string, number>();
    for (let i = 0; i < newer.names.length; i++) {
      if (newer.modes[i] !== MODE.module) at.set(newer.names[i]!, i);
    }
    for (let i = 0; i < older.names.length; i++) {
      const mode = older.modes[i]!;
      if (mode === MODE.module) continue;
      const name = older.names[i]!;
      const isTree = mode === MODE.tree;
      const k = at.get(name);
      if (k !== undefined && (newer.modes[k] === MODE.tree) === isTree) {
        at.delete(name);
        if (isTree) this.learn(row, name, newer.shas[k] !== older.shas[i]);
        if (newer.shas[k] === older.shas[i]) continue;
        if (isTree) {
          // No row here means none below either, and none can be made once the cap is full.
          let r = this.rows.find(row, name, true);
          if (r === undefined && row >= 0 && !this.full(j)) r = this.rows.add(row, name, true, j);
          if (r !== undefined) this.walk(newer.kids[k]!, older.kids[i]!, r, j);
        } else {
          const r = this.rows.find(row, name, false);
          if (r !== undefined) this.change(r, j);
        }
        continue;
      }
      this.appear(older, i, row, j);
    }
    for (const k of at.values()) this.vanish(newer, k, row, j);
  }

  /** The parent changed in this interval; record whether its subfolder `name` did. */
  private learn(parent: number, name: string, changed: boolean) {
    const { rows } = this;
    const r = rows.find(parent, name, true);
    if (r === undefined || rows.newest[r] !== 0) return;
    rows.seen[r] = this.decay * rows.seen[r]! + 1;
    rows.changed[r] = this.decay * rows.changed[r]! + (changed ? 1 : 0);
  }

  /** Entry i of `older` is at j but not at j - 1: a path deleted since (or a run already ended). */
  private appear(older: Node, i: number, row: number, j: number) {
    if (row < 0 || this.full(j)) return;
    const { rows } = this;
    const name = older.names[i]!;
    if (older.modes[i] === MODE.tree) {
      const r = rows.find(row, name, true) ?? rows.add(row, name, true, j);
      const kid = older.kids[i]!;
      for (let c = 0; c < kid.names.length; c++) {
        if (kid.modes[c] !== MODE.module) this.appear(kid, c, r, j);
      }
      return;
    }
    if (rows.find(row, name, false) !== undefined) return;
    rows.add(row, name, false, j);
    if (++this.goneRows === GONE_CAP) this.goneFullAt = j;
  }

  /** Entry k of `newer` is at j - 1 but not at j: its rows' runs end. */
  private vanish(newer: Node, k: number, row: number, j: number) {
    const isTree = newer.modes[k] === MODE.tree;
    const r = this.rows.find(row, newer.names[k]!, isTree);
    if (r === undefined) return;
    this.close(r, j);
    if (!isTree) return;
    const kid = newer.kids[k]!;
    for (let c = 0; c < kid.names.length; c++) {
      if (kid.modes[c] !== MODE.module) this.vanish(kid, c, r, j);
    }
  }

  /** Authors listed in the interval count toward each top-level folder that changed in it. */
  private weigh(newer: Node, older: Node, between: Counts) {
    const top = (node: Node) => {
      const out = new Map<string, string>();
      const files: string[] = [];
      for (let i = 0; i < node.names.length; i++) {
        if (node.modes[i] === MODE.tree) out.set(node.names[i]!, node.shas[i]!);
        else if (node.modes[i] !== MODE.module) files.push(node.shas[i]!);
      }
      out.set('', files.join(','));
      return out;
    };
    const a = top(newer);
    const b = top(older);
    for (const folder of new Set([...a.keys(), ...b.keys()])) {
      if (a.get(folder) === b.get(folder)) continue;
      const w = (this.weights[folder] ??= {});
      for (const [name, n] of Object.entries(between)) w[name] = (w[name] ?? 0) + n;
    }
  }
}
