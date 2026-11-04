/**
 * The history computation in one pass, for a host that can hold a repo's trees in memory and
 * wait as long as it takes: the visitor's browser (a Web Worker), with the visitor's token.
 * It reads what src/core/job.ts reads and yields the same History (summarize.ts), but:
 *
 * - snapshots are kept on the branch's first-parent chain when its mainline has one committer
 *   (Linux: Linus Torvalds; squash-merging repos: GitHub), so a snapshot is never a topic
 *   branch commit whose older base would read as churn;
 * - every distinct tree object is read once, through GraphQL many to a query (trees.ts), or,
 *   without it, through REST pruned against the newer snapshot; both fill one compact store;
 * - snapshots are folded as diffs of neighbouring trees, so the work per snapshot follows what
 *   changed, and paths are rows in typed arrays, not a map per snapshot;
 * - requests run several at a time and are retried with backoff (5xx, network errors,
 *   secondary rate limits), and a Checkpoint passed back in after a failure resumes the run
 *   with everything already read.
 *
 * Rejects with the signal's reason on abort, and with UpstreamError when GitHub refuses.
 */

import { GONE_CAP, type Gap, type History } from '../shape';
import { CODEOWNERS_PATHS, parseCodeowners, type OwnerRule } from './codeowners';
import {
  PATIENT,
  UpstreamError,
  gitHub,
  isRecord,
  lastPage,
  nextPage,
  toChanges,
  toCommits,
  type CommitSummary,
  type FileChange,
  type RetryPolicy,
} from './github';
import {
  DEFAULT_LIMITS,
  countAuthors,
  schedule,
  touchCommit,
  type AccRow,
  type Counts,
  type Sample,
  type TouchRow,
} from './job';
import { summarize, type Folded } from './summarize';
import {
  DEFAULT_PLAN,
  MODE,
  TreeStore,
  graphqlLoader,
  restReader,
  type GraphQLOptions,
  type LoaderStats,
  type Plan,
  type ReadStats,
} from './trees';

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
  /**
   * How trees are read: 'graphql' (the default with a token; falls back to REST on its own
   * when GraphQL keeps failing) or 'rest' (the default without one: GraphQL needs a token).
   */
  reader?: 'graphql' | 'rest';
  graphql?: Partial<GraphQLOptions>;
  plan?: Partial<Plan>;
  retry?: RetryPolicy;
  /**
   * What a run has read so far. Pass the same object to a later run of the same repo and
   * branch (after a failure: a spent rate limit, a dropped connection) to continue from there.
   */
  checkpoint?: Checkpoint;
  now?: () => number;
  /**
   * Tree entries the snapshots may list in all (Infinity, the default, for no cap). Past it,
   * the schedule is thinned evenly once the head's size is known.
   */
  treeBudget?: number;
  /** Called once at the end with what the run cost, for measurement. */
  onStats?: (stats: EngineStats) => void;
};

export type EngineStats = {
  requests: { listings: number; trees: number; graphql: number; commits: number; blobs: number };
  retried: number;
  rest: ReadStats;
  graphql: (LoaderStats & { gaveUp: boolean }) | null;
  store: { trees: number; entries: number; bytes: number };
  snapshots: number;
  rows: number;
  /** Probes were sent all at once (a busy repo) rather than one after another. */
  parallelProbes: boolean;
  /** The committer whose commits stand for the mainline, or null (a linear history). */
  mainline: string | null;
  /** Filtered probes sent because a page held no mainline commit before its target. */
  mainlineProbes: number;
  /**
   * Per snapshot, newest first: REST requests and entries charged to it, and the entries of
   * tree objects it was the first (newest) snapshot to hold (what GraphQL pays for it).
   */
  perSnapshot: { requests: number; entries: number; fresh: number }[];
};

/** What a run keeps between attempts (see EngineOptions.checkpoint). */
export type Checkpoint = {
  /** Commit listings by query. */
  pages: Map<string, { commits: CommitSummary[]; link: string | null }>;
  store: TreeStore;
  /** Recent commits' changed files by sha, and whether GitHub capped the list. */
  changes: Map<string, { files: FileChange[]; capped: boolean }>;
  codeowners: Map<string, string>;
};

export function createCheckpoint(): Checkpoint {
  return { pages: new Map(), store: new TreeStore(), changes: new Map(), codeowners: new Map() };
}

const PER_PAGE = 100;
/** GitHub lists a commit's files 300 to a page, up to 3,000 in all. */
const FILE_PAGES = 10;
const FILES_CAP = 3000;
/** Share of the head an older snapshot lists, for the tree budget. */
const TYPICAL_SHARE = 0.9;
const MIN_TARGETS = 6;
/** Snapshots read ahead while REST reads them whole (small and medium repos). */
const PREFETCH = 4;
/** Only trees this small: a bigger one would come back truncated whole. */
const PREFETCH_BELOW = 80_000;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Request priorities: the trees are the critical path. */
const TREES = 0;
const PROBES = 1;
const RECENT = 2;

export async function computeHistory(options: EngineOptions): Promise<History> {
  const { signal, repo, branch } = options;
  const recentCommits = options.recentCommits ?? DEFAULT_LIMITS.recentCommits;
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_LIMITS.maxSnapshots;
  const plan = { ...DEFAULT_PLAN, ...options.plan };
  const cp = options.checkpoint ?? createCheckpoint();
  const store = cp.store;
  const gh = gitHub({
    fetch: options.fetch,
    api: options.api,
    ...(options.token ? { token: options.token } : {}),
    limit: Infinity,
    retry: options.retry ?? PATIENT,
    ...(signal ? { signal } : {}),
  });
  const pool = createPool(options.concurrency ?? 6, signal);
  const base = `/repos/${repo}`;
  const counts = { listings: 0, trees: 0, graphql: 0, commits: 0, blobs: 0 };
  const get = (path: string, priority: number, kind: keyof typeof counts) =>
    pool.run(priority, () => {
      counts[kind]++;
      return gh.json(path);
    });
  const list = async (query: string, priority: number) => {
    const kept = cp.pages.get(query);
    if (kept) return kept;
    const { body, link } = await get(`${base}/commits?${query}`, priority, 'listings');
    const page = { commits: toCommits(body), link };
    cp.pages.set(query, page);
    return page;
  };

  // The newest page: the head, the recent commits and, for a short history, the root.
  const gaps: Gap[] = [];
  const first = await list(`sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}`, PROBES);
  const headCommit = first.commits[0];
  if (!headCommit) throw new UpstreamError('empty');
  const head: Sample = { sha: headCommit.sha, at: headCommit.at, tree: headCommit.tree };
  const firstComplete = first.commits.length < PER_PAGE;
  const nonMerge = first.commits.filter((c) => !c.merge);
  const recent = nonMerge.slice(0, recentCommits);
  const recentIsAll = firstComplete && recent.length === nonMerge.length;
  const mainline = mainlineCommitter(first.commits);

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
  let targets = schedule(head.at, root?.at ?? null, maxSnapshots);

  const useGraphQL = (options.reader ?? (options.token ? 'graphql' : 'rest')) === 'graphql';
  const loader = useGraphQL
    ? graphqlLoader(
        (q) =>
          pool.run(TREES, () => {
            counts.graphql++;
            return gh.graphql(q);
          }),
        { owner: repo.split('/')[0]!, name: repo.split('/')[1]! },
        store,
        { concurrency: options.concurrency ?? 6, ...options.graphql },
      )
    : null;

  // The tree budget needs the head's size: read it first (GraphQL reads it with the rest).
  let headEntries = 0;
  let headRead = (): void => undefined;
  const headDone = new Promise<void>((resolve) => (headRead = resolve));
  const pickTargets = async () => {
    const budget = options.treeBudget ?? Infinity;
    if (!Number.isFinite(budget)) return targets;
    await headDone;
    if (headEntries === 0) return targets;
    const room = Math.floor(budget / (TYPICAL_SHARE * headEntries)) - 2;
    targets = thin(targets, Math.max(MIN_TARGETS, room));
    return targets;
  };

  const progress = { probes: 0, trees: 0, recent: 0 };
  const report = () => {
    const part = (done: number, total: number) => (total > 0 ? Math.min(1, done / total) : 1);
    const trees = loader
      ? part(loader.stats.trees + progress.trees * 50, store.trees + (targets.length + 2) * 50)
      : part(progress.trees, targets.length + 2);
    options.onProgress?.(
      0.02 +
        0.08 * part(progress.probes, targets.length) +
        0.75 * trees +
        0.15 * part(progress.recent, recent.length),
    );
  };
  report();

  // Recent commits, alongside everything else; folded newest first once all are in.
  const recentTask = Promise.all(
    recent.map(async (c) => {
      let kept = cp.changes.get(c.sha);
      if (!kept) {
        const files: FileChange[] = [];
        for (let page = 1; page <= FILE_PAGES; page++) {
          const path = `${base}/commits/${c.sha}${page > 1 ? `?page=${page}` : ''}`;
          const { body, link } = await get(path, RECENT, 'commits');
          files.push(...toChanges(body));
          if (nextPage(link) === null) break;
        }
        kept = { files, capped: files.length >= FILES_CAP };
        cp.changes.set(c.sha, kept);
      }
      progress.recent++;
      report();
      return kept;
    }),
  );
  recentTask.catch(() => undefined);

  const span = head.at - (first.commits[first.commits.length - 1]?.at ?? head.at);
  // A page of 100 commits that spans under half a week will not reach the next weekly target,
  // so every target takes its own request anyway: send them all at once.
  const parallelProbes = !firstComplete && span < 3.5 * DAY;
  let mainlineProbes = 0;
  const samples = probeSamples({
    head,
    root,
    targets: pickTargets,
    first: first.commits,
    complete: firstComplete,
    parallel: parallelProbes,
    mainline,
    page: (t) =>
      list(`sha=${head.sha}&until=${iso(t)}&per_page=${PER_PAGE}`, PROBES).then((r) => {
        progress.probes++;
        report();
        return r.commits;
      }),
    pick: async (t) => {
      mainlineProbes++;
      const committer = encodeURIComponent(mainline ?? '');
      const r = await list(
        `sha=${head.sha}&until=${iso(t)}&committer=${committer}&per_page=1`,
        PROBES,
      );
      return r.commits[0];
    },
    signal,
  });

  // Probes run ahead of the trees: samples land here as they are found (and, with GraphQL,
  // their trees are queued at once).
  const found: { sample: Sample; between: Counts }[] = [];
  let probing = true;
  let wake = (): void => undefined;
  const probed = (async () => {
    try {
      for await (const s of samples) {
        found.push(s);
        loader?.add(s.sample.tree);
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

  if (loader) {
    // GraphQL reads breadth first across every snapshot; the fold waits for all of it. Where
    // it gave up, the REST reader below reads what is still missing.
    if (Number.isFinite(options.treeBudget ?? Infinity)) {
      await next(0);
      await loader.drain();
      headEntries = store.count(store.id(head.tree));
      headRead();
    }
    await probed;
    await loader.drain();
  }

  const perSnapshot: EngineStats['perSnapshot'] = [];
  const charged = new Map<number, { requests: number; entries: number }>();
  const rest = restReader(
    async (sha, recursive, snapshot) => {
      const { body } = await get(
        `${base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
        TREES,
        'trees',
      );
      const c = charged.get(snapshot) ?? { requests: 0, entries: 0 };
      c.requests++;
      c.entries += isRecord(body) && Array.isArray(body.tree) ? body.tree.length : 0;
      charged.set(snapshot, c);
      return body;
    },
    store,
    plan,
  );
  const rows = new Rows();
  const fold = new Fold(rows, store);
  fold.decay = plan.decay;
  const sampled: Sample[] = [];
  let newer = -1;
  let codeownersSha: string | null = null;
  for (let j = 0; ; j++) {
    const item = await next(j);
    if (!item) break;
    signal?.throwIfAborted();
    const { sample, between } = item;
    sampled.push(sample);
    const tree = await rest
      .read(sample.tree, newer, fold.changes, Math.max(0, j - 1), j)
      .catch((error: unknown) => {
        headRead();
        throw error;
      });
    // A snapshot read whole will likely be followed by more: start the next few now.
    // (Those are older than this one, so seldom bigger: repos mostly grow.)
    if (rest.lastWhole && store.count(tree) < PREFETCH_BELOW) {
      found
        .slice(j + 1, j + 1 + PREFETCH)
        .forEach((a, k) => rest.prefetch(a.sample.tree, j + 1 + k));
    }
    if (newer < 0) {
      headEntries = store.count(tree);
      headRead();
      fold.head(tree);
      codeownersSha = findCodeowners(store, tree);
    } else fold.diff(newer, tree, j, between);
    perSnapshot.push({ requests: 0, entries: 0, fresh: fold.fresh(tree) });
    newer = tree;
    progress.trees++;
    report();
  }
  fold.finish(sampled.length - 1);
  perSnapshot.forEach((p, j) => Object.assign(p, charged.get(j) ?? {}));

  let codeowners: OwnerRule[] = [];
  const owners = codeownersSha
    ? (async () => {
        let text = cp.codeowners.get(codeownersSha);
        if (text === undefined) {
          const { body } = await get(`${base}/git/blobs/${codeownersSha}`, TREES, 'blobs');
          if (!isRecord(body) || typeof body.content !== 'string') {
            throw new UpstreamError('upstream');
          }
          const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, '')), (c) =>
            c.charCodeAt(0),
          );
          text = new TextDecoder().decode(bytes);
          cp.codeowners.set(codeownersSha, text);
        }
        codeowners = parseCodeowners(text);
      })().catch((error: unknown) => {
        if (signal?.aborted) throw error;
        gaps.push('codeowners-unread');
      })
    : Promise.resolve();

  const [changes] = await Promise.all([recentTask, owners]);
  const touched: Record<string, TouchRow> = {};
  const commitsBy: Record<string, Counts> = {};
  recent.forEach((c, i) => touchCommit({ touched, commitsBy }, c, changes[i]!.files));
  if (changes.some((c) => c.capped)) gaps.push('commit-files-capped');

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
    retried: gh.retried,
    rest: rest.stats,
    graphql: loader ? { ...loader.stats, gaveUp: loader.gaveUp } : null,
    store: { trees: store.trees, entries: store.entries, bytes: store.bytes },
    snapshots: sampled.length,
    rows: rows.n,
    parallelProbes,
    mainline,
    mainlineProbes,
    perSnapshot,
  });
  options.onProgress?.(1);
  return summarize(folded, (options.now ?? Date.now)());
}

/**
 * The committer that stands for the mainline, read off the newest page: when the page is not
 * one straight line (a merge-based history) and most of the first-parent chain it holds was
 * committed by the head's committer, snapshots are taken from that committer's commits. Null
 * keeps the newest commit by date, right for a linear history.
 */
export function mainlineCommitter(page: readonly CommitSummary[]): string | null {
  const bySha = new Map(page.map((c) => [c.sha, c]));
  const chain: CommitSummary[] = [];
  for (let c = page[0]; c && chain.length < page.length; c = bySha.get(c.parents[0] ?? '')) {
    chain.push(c);
  }
  const top = page[0]?.committer;
  if (!top || chain.length >= 0.95 * page.length) return null;
  const share = chain.filter((c) => c.committer === top).length / chain.length;
  return share >= 0.8 ? top : null;
}

type Probing = {
  head: Sample;
  root: Sample | null;
  /** Target times, newest first; asked once the head is known. */
  targets: () => Promise<readonly number[]>;
  first: CommitSummary[];
  complete: boolean;
  parallel: boolean;
  mainline: string | null;
  /** The newest page of commits before a target. */
  page: (target: number) => Promise<CommitSummary[]>;
  /** The newest mainline commit before a target, for a page that held none. */
  pick: (target: number) => Promise<CommitSummary | undefined>;
  signal: AbortSignal | undefined;
};

/**
 * The snapshots newest first, each with the authors of the listed commits between it and the
 * newer one: job.ts's probe phase, one commit per target time, a page reused while it reaches
 * the next target; with a mainline committer, the newest of that committer's commits.
 */
async function* probeSamples(p: Probing): AsyncGenerator<{ sample: Sample; between: Counts }> {
  yield { sample: p.head, between: {} };
  const targets = await p.targets();
  const pages = p.parallel ? targets.map((t) => p.page(t)) : [];
  for (const page of pages) page.catch(() => undefined);
  const pickIn = (listing: readonly CommitSummary[], target: number) =>
    listing.find((c) => c.at <= target && (!p.mainline || c.committer === p.mainline));
  let listing = p.first;
  let complete = p.complete;
  let newer = p.head;
  for (let k = 0; k < targets.length; k++) {
    p.signal?.throwIfAborted();
    const target = targets[k]!;
    const oldestListed = listing[listing.length - 1];
    const covers = oldestListed !== undefined && (oldestListed.at <= target || complete);
    let found: CommitSummary | undefined;
    let between: Counts;
    if (covers) {
      found = pickIn(listing, target);
      between = found ? countAuthors(listing, found.at, newer.at) : {};
    } else {
      between = countAuthors(listing, target, newer.at);
      listing = await (pages[k] ?? p.page(target));
      complete = listing.length < PER_PAGE;
      found = pickIn(listing, target);
    }
    if (!found && p.mainline) {
      found = (await p.pick(target)) ?? listing.find((c) => c.at <= target);
    }
    if (!found) break;
    if (found.sha === newer.sha || found.at > newer.at) continue;
    newer = { sha: found.sha, at: found.at, tree: found.tree };
    yield { sample: newer, between };
  }
  if (p.root && p.root.sha !== newer.sha && p.root.at < newer.at) {
    yield { sample: p.root, between: countAuthors(listing, p.root.at, newer.at) };
  }
}

/** The CODEOWNERS blob GitHub would use, from the head tree. */
function findCodeowners(store: TreeStore, root: number): string | null {
  for (const path of CODEOWNERS_PATHS) {
    let t = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1 && t >= 0; i++) {
      const at = store.find(t, parts[i]!, true);
      t = at < 0 ? -1 : store.ref(t, at);
    }
    if (t < 0) continue;
    const at = store.find(t, parts[parts.length - 1]!, false);
    if (at >= 0) return store.keptOid(t, at);
  }
  return null;
}

/** `n` of the targets, spread evenly over the list (which is already denser near the head). */
export function thin(targets: readonly number[], n: number): number[] {
  if (targets.length <= n) return [...targets];
  if (n <= 1) return targets.slice(0, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(targets[Math.round((i * (targets.length - 1)) / (n - 1))]!);
  return out;
}

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
  /** Weight of each older interval against the newer one in `changes`. */
  decay = DEFAULT_PLAN.decay;
  private goneRows = 0;
  private goneFullAt = -1;
  /** Head folders by path, for the reader's change odds. */
  private folders = new Map<string, number>();
  private seen = new Uint8Array(1024);
  private rows: Rows;
  private store: TreeStore;

  constructor(rows: Rows, store: TreeStore) {
    this.rows = rows;
    this.store = store;
  }

  /**
   * How often the head folder at `path` changed along with its parent, older intervals
   * discounted by `decay` each (for the REST reader's choice between whole and level reads).
   */
  readonly changes = (path: string) => {
    const r = this.folders.get(path);
    if (r === undefined || this.rows.seen[r] === 0) return undefined;
    return { changed: this.rows.changed[r]!, seen: this.rows.seen[r]! };
  };

  /** Entries of the trees under `root` no newer snapshot held (marks them held). */
  fresh(root: number): number {
    const { store } = this;
    let total = 0;
    const visit = (t: number) => {
      if (t >= this.seen.length) {
        const bigger = new Uint8Array(Math.max(t + 1, this.seen.length * 2));
        bigger.set(this.seen);
        this.seen = bigger;
      }
      if (this.seen[t]) return;
      this.seen[t] = 1;
      const n = store.length(t);
      total += n;
      for (let i = 0; i < n; i++) if (store.isTree(t, i)) visit(store.ref(t, i));
    };
    visit(root);
    return total;
  }

  head(root: number): void {
    const { store, rows } = this;
    const visit = (t: number, row: number, path: string) => {
      const n = store.length(t);
      for (let i = 0; i < n; i++) {
        const mode = store.mode(t, i);
        if (mode === MODE.module) continue;
        const name = store.name(t, i);
        if (mode === MODE.tree) {
          const r = rows.add(row, name, true, 0);
          const kidPath = path ? `${path}/${name}` : name;
          this.folders.set(kidPath, r);
          visit(store.ref(t, i), r, kidPath);
        } else rows.add(row, name, false, 0);
      }
    };
    this.folders.set('', 0);
    visit(root, 0, '');
  }

  /** Snapshot j (older) against j - 1 (newer), with the authors listed between them. */
  diff(newer: number, older: number, j: number, between: Counts): void {
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

  /** Both trees are sorted by key (store.ts), so one merge pass pairs their entries. */
  private walk(newer: number, older: number, row: number, j: number) {
    const { store } = this;
    this.change(row, j);
    const nn = store.length(newer);
    const no = store.length(older);
    let a = 0;
    let b = 0;
    while (a < nn || b < no) {
      if (a < nn && store.mode(newer, a) === MODE.module) {
        a++;
        continue;
      }
      if (b < no && store.mode(older, b) === MODE.module) {
        b++;
        continue;
      }
      const ka = a < nn ? store.key(newer, a) : null;
      const kb = b < no ? store.key(older, b) : null;
      if (ka !== null && kb !== null && ka === kb) {
        const isTree = store.isTree(older, b);
        const name = store.name(older, b);
        const same = store.ref(newer, a) === store.ref(older, b);
        if (isTree) this.learn(row, name, !same);
        if (!same) {
          if (isTree) {
            // No row here means none below either, and none can be made once the cap is full.
            let r = this.rows.find(row, name, true);
            if (r === undefined && !this.full(j)) r = this.rows.add(row, name, true, j);
            if (r !== undefined) this.walk(store.ref(newer, a), store.ref(older, b), r, j);
          } else {
            const r = this.rows.find(row, name, false);
            if (r !== undefined) this.change(r, j);
          }
        }
        a++;
        b++;
      } else if (kb !== null && (ka === null || kb < ka)) {
        this.appear(older, b, row, j);
        b++;
      } else {
        this.vanish(newer, a, row, j);
        a++;
      }
    }
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
  private appear(older: number, i: number, row: number, j: number) {
    if (row < 0 || this.full(j)) return;
    const { rows, store } = this;
    const name = store.name(older, i);
    if (store.isTree(older, i)) {
      const r = rows.find(row, name, true) ?? rows.add(row, name, true, j);
      const kid = store.ref(older, i);
      const n = store.length(kid);
      for (let c = 0; c < n; c++) {
        if (store.mode(kid, c) !== MODE.module) this.appear(kid, c, r, j);
      }
      return;
    }
    if (rows.find(row, name, false) !== undefined) return;
    rows.add(row, name, false, j);
    if (++this.goneRows === GONE_CAP) this.goneFullAt = j;
  }

  /** Entry k of `newer` is at j - 1 but not at j: its rows' runs end. */
  private vanish(newer: number, k: number, row: number, j: number) {
    const { store } = this;
    const isTree = store.isTree(newer, k);
    const r = this.rows.find(row, store.name(newer, k), isTree);
    if (r === undefined) return;
    this.close(r, j);
    if (!isTree) return;
    const kid = store.ref(newer, k);
    const n = store.length(kid);
    for (let c = 0; c < n; c++) {
      if (store.mode(kid, c) !== MODE.module) this.vanish(kid, c, r, j);
    }
  }

  /** Authors listed in the interval count toward each top-level folder that changed in it. */
  private weigh(newer: number, older: number, between: Counts) {
    const { store } = this;
    const top = (t: number) => {
      const out = new Map<string, string>();
      const files: number[] = [];
      const n = store.length(t);
      for (let i = 0; i < n; i++) {
        const mode = store.mode(t, i);
        if (mode === MODE.tree) out.set(store.name(t, i), String(store.ref(t, i)));
        else if (mode !== MODE.module) files.push(store.ref(t, i));
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

export type { AccRow };
