/**
 * Pruned incremental reading of a repo's tree snapshots, for hosts that hold every snapshot's
 * tree in memory (the browser engine, src/core/engine.ts).
 *
 * A snapshot is read against the newer one already in memory: a folder whose tree sha did not
 * change is that same object (structural sharing, never a copy), and a folder whose sha appears
 * anywhere in the newer snapshot (a move or a rename) is reused too. Only changed folders are
 * fetched, each one either whole (`?recursive=1`, one request) or one level at a time (its own
 * listing, then the same choice for each changed child). `choose` picks by an expected cost
 * built from the newer snapshot's sizes and how often each folder changed in the intervals
 * read so far.
 *
 * A recursive listing GitHub cut short (`truncated`, past 100,000 entries or 7 MB) is not
 * thrown away: every folder in it whose entries hash to its own sha is complete, whatever order
 * GitHub listed them in, and only the others are read again.
 */

import { UpstreamError, isRecord } from './github';

/** Entry modes, as git stores them. */
export const MODE = { file: 0, exec: 1, link: 2, tree: 3, module: 4 } as const;
const MODE_TEXT = ['100644', '100755', '120000', '40000', '160000'] as const;
type Mode = (typeof MODE)[keyof typeof MODE];

/**
 * One folder of one snapshot. Immutable once built, so snapshots share every folder that did not
 * change. `kids[i]` is the folder entry i points to (null for files and submodules).
 */
export type Node = {
  readonly sha: string;
  readonly names: readonly string[];
  readonly shas: readonly string[];
  readonly modes: Uint8Array;
  readonly kids: readonly (Node | null)[];
  /** Entries anywhere below this folder. */
  readonly count: number;
};

export type TreeFetch = (sha: string, recursive: boolean) => Promise<unknown>;

export type Plan = {
  /** What one request costs, in the gzipped bytes it is worth. */
  requestBytes: number;
  /** Gzipped bytes per tree entry in a listing (GitHub's url per entry is most of it). */
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
 * Tuned on linux and vite against scripts/fake-github.mjs (scripts/measure.mjs --plan). A tree
 * entry costs 37 to 40 gzipped bytes as GitHub serves it. Linux, all 65 snapshots:
 *   requestBytes  6,000: 6,015 tree requests, 4.24M entries listed
 *   requestBytes 12,000: 1,574 tree requests, 4.80M entries (the default)
 *   requestBytes 25,000:   988 tree requests, 5.11M entries
 * Reading every snapshot whole lists 5.5M; no planner can go below about 3.1M (the entries of
 * every distinct tree object), or 4.2M at 1,800 requests, knowing the answers in advance.
 * Without `adapt` the default costs 2,648 requests for 5.01M entries; `decay` below 1 or
 * scaling the odds by interval length (tried) bought bytes at worse than 4 KB a request.
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
 * `seen` also changed (the engine discounts older intervals). Undefined for a folder never seen.
 */
export type ChangeStats = (path: string) => { changed: number; seen: number } | undefined;

export type ReadStats = {
  requests: number;
  recursive: number;
  level: number;
  /** Changed folders reused from elsewhere in the newer snapshot (moves and renames). */
  moved: number;
  /** Folders kept from a truncated listing because their entries hash to their sha. */
  salvaged: number;
  truncated: number;
  /** Entries listed by all those requests. */
  entries: number;
};

type Flat = { path: string; mode: Mode; sha: string };

/** One string per distinct name, shared by every snapshot that lists it (one table per reader). */
function interner(): (name: string) => string {
  const names = new Map<string, string>();
  return (name) => {
    const known = names.get(name);
    if (known !== undefined) return known;
    names.set(name, name);
    return name;
  };
}

function modeOf(text: unknown, type: unknown): Mode | null {
  switch (text) {
    case '100644':
      return MODE.file;
    case '100755':
      return MODE.exec;
    case '120000':
      return MODE.link;
    case '040000':
    case '40000':
      return MODE.tree;
    case '160000':
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

function makeNode(
  sha: string,
  entries: readonly Flat[],
  names: readonly string[],
  intern: (name: string) => string,
): Node {
  const n = entries.length;
  const modes = new Uint8Array(n);
  const shas: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    modes[i] = entries[i]!.mode;
    shas[i] = entries[i]!.sha;
  }
  return { sha, names: names.map(intern), shas, modes, kids: new Array(n).fill(null), count: n };
}

/** Builds a node with its kids filled; count follows them. */
function withKids(base: Node, kids: (Node | null)[]): Node {
  let count = base.names.length;
  for (const k of kids) if (k) count += k.count;
  return { ...base, kids, count };
}

/** Every folder of a snapshot by sha, to reuse moved and renamed folders. */
export function indexFolders(root: Node): Map<string, Node> {
  const index = new Map<string, Node>();
  const visit = (node: Node) => {
    if (index.has(node.sha)) return;
    index.set(node.sha, node);
    for (const k of node.kids) if (k) visit(k);
  };
  visit(root);
  return index;
}

/** git's object id for a tree with these entries, in this order. */
async function treeSha(
  names: readonly string[],
  modes: ArrayLike<number>,
  shas: readonly string[],
) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (let i = 0; i < names.length; i++) {
    const head = enc.encode(`${MODE_TEXT[modes[i] as Mode]} ${names[i]}\0`);
    const id = hexBytes(shas[i]!);
    parts.push(head, id);
    length += head.length + id.length;
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

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The entries of a recursive listing grouped by folder ('' is the listed tree itself). */
function groupByFolder(
  entries: readonly Flat[],
): Map<string, { entries: Flat[]; names: string[] }> {
  const groups = new Map<string, { entries: Flat[]; names: string[] }>();
  for (const e of entries) {
    const slash = e.path.lastIndexOf('/');
    const folder = slash < 0 ? '' : e.path.slice(0, slash);
    let g = groups.get(folder);
    if (!g) groups.set(folder, (g = { entries: [], names: [] }));
    g.entries.push(e);
    g.names.push(slash < 0 ? e.path : e.path.slice(slash + 1));
  }
  return groups;
}

export type Reader = {
  /**
   * Snapshot `sha`'s whole tree, read against the newer snapshot `newer` (null for the first).
   * `changes(path)` says how often that folder changed along with its parent; `intervals`
   * counts the intervals read so far.
   */
  read(sha: string, newer: Node | null, changes: ChangeStats, intervals: number): Promise<Node>;
  /**
   * Starts reading tree `sha` whole before its turn, for a snapshot expected to be read whole
   * anyway (its newer neighbour was): snapshots then download side by side instead of one
   * after another. `read` takes it from there, whatever it would have chosen.
   */
  prefetch(sha: string): void;
  /** Whether the last `read` fetched its root whole. */
  readonly lastWhole: boolean;
  readonly stats: ReadStats;
};

/**
 * A pruned reader over `fetchTree`, which returns a /git/trees body (and may run several at a
 * time; the caller bounds concurrency).
 */
export function treeReader(fetchTree: TreeFetch, partial: Partial<Plan> = {}): Reader {
  const plan: Plan = { ...DEFAULT_PLAN, ...partial };
  const intern = interner();
  const stats: ReadStats = {
    requests: 0,
    recursive: 0,
    level: 0,
    moved: 0,
    salvaged: 0,
    truncated: 0,
    entries: 0,
  };

  const early = new Map<string, ReturnType<typeof list>>();
  let lastWhole = false;

  function prefetch(sha: string) {
    if (early.has(sha)) return;
    const pending = list(sha, true);
    pending.catch(() => undefined);
    early.set(sha, pending);
  }

  async function list(sha: string, recursive: boolean) {
    stats.requests++;
    if (recursive) stats.recursive++;
    else stats.level++;
    const listing = parseListing(await fetchTree(sha, recursive));
    if (listing.truncated) stats.truncated++;
    stats.entries += listing.entries.length;
    return listing;
  }

  async function read(
    rootSha: string,
    newer: Node | null,
    changes: ChangeStats,
    intervals: number,
  ): Promise<Node> {
    lastWhole = false;
    if (newer && newer.sha === rootSha) return newer;
    const index = newer ? indexFolders(newer) : new Map<string, Node>();
    let expected = new Map<Node, number>();
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
    const cost = (old: Node, path: string): number => {
      const known = expected.get(old);
      if (known !== undefined) return known;
      const whole = plan.requestBytes + plan.entryBytes * old.count;
      let level = plan.requestBytes + plan.entryBytes * old.names.length;
      for (let i = 0; i < old.kids.length && level < whole; i++) {
        const kid = old.kids[i];
        if (!kid) continue;
        const kidPath = path ? `${path}/${old.names[i]}` : old.names[i]!;
        level += odds(kidPath) * cost(kid, kidPath);
      }
      const best = Math.min(whole, level);
      expected.set(old, best);
      return best;
    };

    const choose = (old: Node | undefined, path: string): boolean => {
      // A folder new at this path has no sizes to go by; most are small, so read it whole.
      if (!old) return true;
      // An over-limit listing would be cut short; read those a level at a time.
      if (old.count > 90_000) return false;
      expected = new Map();
      return plan.requestBytes + plan.entryBytes * old.count <= cost(old, path);
    };

    const kidOf = (old: Node | undefined, name: string): Node | undefined => {
      if (!old) return undefined;
      const i = old.names.indexOf(name);
      return i >= 0 ? (old.kids[i] ?? undefined) : undefined;
    };

    /** The folder `sha` at `path`, whose counterpart in the newer snapshot is `old`. */
    async function resolve(sha: string, old: Node | undefined, path: string): Promise<Node> {
      if (old && old.sha === sha) return old;
      const moved = index.get(sha);
      if (moved) {
        stats.moved++;
        return moved;
      }
      const started = early.get(sha);
      if (started) early.delete(sha);
      if (started || choose(old, path)) {
        if (path === '') lastWhole = true;
        const listing = await (started ?? list(sha, true));
        return fromRecursive(sha, listing.entries, listing.truncated, old, path);
      }
      const { entries } = await list(sha, false);
      return fromLevel(
        makeNode(
          sha,
          entries,
          entries.map((e) => e.path),
          intern,
        ),
        old,
        path,
      );
    }

    /** Fills a folder known one level deep: unchanged kids are shared, changed ones resolved. */
    async function fromLevel(base: Node, old: Node | undefined, path: string): Promise<Node> {
      if (old && intervals > 0) {
        base.names.forEach((name, i) => {
          const was = base.modes[i] === MODE.tree ? kidOf(old, name) : undefined;
          if (!was) return;
          predicted += learnt(path ? `${path}/${name}` : name);
          if (was.sha !== base.shas[i] && !index.has(base.shas[i]!)) observed++;
        });
      }
      const kids = await Promise.all(
        base.names.map((name, i) =>
          base.modes[i] === MODE.tree
            ? resolve(base.shas[i]!, kidOf(old, name), path ? `${path}/${name}` : name)
            : null,
        ),
      );
      return withKids(base, kids);
    }

    /**
     * Builds a folder from its recursive listing. Folders that also exist in the newer snapshot
     * are swapped for those objects, so a whole read costs memory only for what changed. A
     * truncated listing keeps the folders that hash to their sha and reads the rest again.
     */
    async function fromRecursive(
      sha: string,
      entries: readonly Flat[],
      truncated: boolean,
      old: Node | undefined,
      path: string,
    ): Promise<Node> {
      const groups = groupByFolder(entries);
      /** Entries the listing holds below a folder. */
      const below = (folder: string) => {
        const prefix = `${folder}/`;
        let n = 0;
        for (const e of entries) if (e.path.startsWith(prefix)) n++;
        return n;
      };
      const build = async (
        folder: string,
        folderSha: string,
        oldHere: Node | undefined,
      ): Promise<Node> => {
        const shared = index.get(folderSha);
        if (shared) return shared;
        const g = groups.get(folder);
        const base = makeNode(folderSha, g?.entries ?? [], g?.names ?? [], intern);
        if (truncated) {
          const ok =
            g !== undefined && (await treeSha(base.names, base.modes, base.shas)) === folderSha;
          if (!ok) {
            // Read this folder's own listing; kids the listing held completely are kept below.
            const { entries: own } = await list(folderSha, false);
            const fresh = makeNode(
              folderSha,
              own,
              own.map((e) => e.path),
              intern,
            );
            // Many subfolders missing from the listing would cost a request each: past the
            // bytes of what the listing held below this folder, read the folder whole instead.
            const missing = fresh.names.filter(
              (name, i) =>
                fresh.modes[i] === MODE.tree &&
                !groups.has(folder ? `${folder}/${name}` : name) &&
                kidOf(oldHere, name)?.sha !== fresh.shas[i],
            ).length;
            if (folder && missing * plan.requestBytes > plan.entryBytes * below(folder)) {
              const whole = await list(folderSha, true);
              return fromRecursive(
                folderSha,
                whole.entries,
                whole.truncated,
                oldHere,
                join(path, folder),
              );
            }
            const kids = await Promise.all(
              fresh.names.map((name, i) => {
                if (fresh.modes[i] !== MODE.tree) return null;
                const kidPath = folder ? `${folder}/${name}` : name;
                const kidSha = fresh.shas[i]!;
                const oldKid = kidOf(oldHere, name);
                if (oldKid?.sha === kidSha) return oldKid;
                return groups.has(kidPath)
                  ? build(kidPath, kidSha, oldKid)
                  : resolve(kidSha, oldKid, join(path, kidPath));
              }),
            );
            return withKids(fresh, kids);
          }
          stats.salvaged++;
        }
        const kids = await Promise.all(
          base.names.map((name, i) => {
            if (base.modes[i] !== MODE.tree) return null;
            const kidPath = folder ? `${folder}/${name}` : name;
            return build(kidPath, base.shas[i]!, kidOf(oldHere, name));
          }),
        );
        return withKids(base, kids);
      };
      return build('', sha, old);
    }

    return resolve(rootSha, newer ?? undefined, '');
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

const join = (a: string, b: string) => (a && b ? `${a}/${b}` : a || b);
