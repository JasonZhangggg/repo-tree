/**
 * Filling in a recursive tree listing that GitHub cut short. GitHub stops a `?recursive=1`
 * listing at about 100,000 entries or 7 MB, signed in or not, and says `truncated: true`. Linux
 * is past that. What it did list is kept wherever it can be proved whole: a folder whose listed
 * entries hash to the folder's own sha (git's tree id) is complete, whatever order GitHub
 * listed them in. Only the rest is read again, starting from the root's own entries: each
 * folder not proved whole is read whole by its sha (one request for its whole subtree), and one
 * still cut short is read a level at a time the same way. Linux, just over the limit, costs
 * four requests more.
 */

export type Listed = { path: string; mode: string; type: string; sha: string; size?: number };
export type Listing = { entries: Listed[]; truncated: boolean };
/** Reads tree `sha` (whole with `recursive`); `undefined` when it cannot, which stops filling. */
export type ListTree = (sha: string, recursive: boolean) => Promise<Listing | undefined>;

export type Completed = {
  /** Every entry, folders before their contents, in git's order within each folder. */
  entries: Listed[];
  /** Whether some folder could not be read in full (a rate limit, an error, the cap). */
  truncated: boolean;
  requests: number;
};

export type CompleteOptions = {
  /** Reads at once. */
  concurrency?: number;
  /** Reads at most, so a giant monorepo cannot spend a visitor's hourly budget. */
  maxRequests?: number;
};

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const folderOf = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

export async function completeTree(
  rootSha: string,
  first: Listing,
  list: ListTree,
  { concurrency = 6, maxRequests = 150 }: CompleteOptions = {},
): Promise<Completed> {
  /** Each folder's own entries, in listing order (git's order within one folder). */
  const kids = new Map<string, Listed[]>();
  const add = (entries: readonly Listed[], prefix: string) => {
    for (const e of entries) {
      const path = join(prefix, e.path);
      const folder = folderOf(path);
      let group = kids.get(folder);
      if (!group) kids.set(folder, (group = []));
      group.push({ ...e, path });
    }
  };
  add(first.entries, '');
  if (!first.truncated) return { entries: flatten(kids), truncated: false, requests: 0 };

  let requests = 0;
  let gaveUp = false;
  let active = 0;
  const waiting: (() => void)[] = [];
  const read = async (sha: string, recursive: boolean): Promise<Listing | undefined> => {
    if (gaveUp || requests >= maxRequests) {
      gaveUp = true;
      return undefined;
    }
    requests++;
    if (active >= concurrency) await new Promise<void>((go) => waiting.push(go));
    active++;
    try {
      const listing = await list(sha, recursive);
      if (!listing) gaveUp = true;
      return listing;
    } finally {
      active--;
      waiting.shift()?.();
    }
  };

  /** Drops what is known under `path` before a fresh read replaces it. */
  const forget = (path: string, deep: boolean) => {
    kids.delete(path);
    if (!deep) return;
    const prefix = `${path}/`;
    for (const folder of [...kids.keys()]) if (folder.startsWith(prefix)) kids.delete(folder);
  };

  /** Makes folder `path` (tree `sha`) and everything under it complete, as far as it can. */
  const resolve = async (path: string, sha: string, readWhole: boolean): Promise<void> => {
    const own = kids.get(path);
    if (!own || !(await hashesTo(own, sha))) {
      // One recursive read usually brings a missing or cut folder back whole, cheaper than
      // reading each of its missing subfolders on its own.
      if (readWhole) {
        const whole = await read(sha, true);
        if (!whole) return;
        forget(path, true);
        add(whole.entries, path);
        if (!whole.truncated) return;
        // Cut short again: keep what proves whole below, and read this level on its own.
        if (await hashesTo(kids.get(path) ?? [], sha)) return resolve(path, sha, false);
      }
      const level = await read(sha, false);
      if (!level) return;
      forget(path, false);
      add(level.entries, path);
    }
    const subfolders = (kids.get(path) ?? []).filter((e) => e.type === 'tree');
    await Promise.all(subfolders.map((e) => resolve(e.path, e.sha, true)));
  };

  await resolve('', rootSha, false);
  return { entries: flatten(kids), truncated: gaveUp, requests };
}

/** Walks from the root, so folders dropped and read again appear once, in place. */
function flatten(kids: Map<string, Listed[]>): Listed[] {
  const out: Listed[] = [];
  const visit = (folder: string) => {
    for (const e of kids.get(folder) ?? []) {
      out.push(e);
      if (e.type === 'tree') visit(e.path);
    }
  };
  visit('');
  return out;
}

const encoder = new TextEncoder();

/** Whether these entries (one folder's, in listing order) are exactly the tree `sha`. */
async function hashesTo(entries: readonly Listed[], sha: string): Promise<boolean> {
  if (entries.length === 0 || !/^[0-9a-f]{40}$/.test(sha)) return false;
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const e of entries) {
    if (!/^[0-9a-f]{40}$/.test(e.sha)) return false;
    // git writes a folder's mode as 40000; GitHub shows it as 040000.
    const head = encoder.encode(`${e.mode.replace(/^0+/, '')} ${nameOf(e.path)}\0`);
    const id = new Uint8Array(20);
    for (let i = 0; i < 20; i++) id[i] = parseInt(e.sha.slice(2 * i, 2 * i + 2), 16);
    parts.push(head, id);
    length += head.length + 20;
  }
  const prefix = encoder.encode(`tree ${length}\0`);
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
  return hex === sha;
}
