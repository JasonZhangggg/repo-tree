import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { completeTree, type Listed, type Listing } from './complete-tree';

type Node = { name: string; mode: string; sha: string; kids?: Node[] };

const blobSha = (path: string) => createHash('sha1').update(`blob ${path}`).digest('hex');

/** A real git tree (shas and all) for these paths, git-sorted the way git stores trees. */
function build(paths: string[]): Node {
  const root: Node = { name: '', mode: '040000', sha: '', kids: [] };
  for (const path of paths) {
    let at = root;
    const parts = path.split('/');
    parts.forEach((name, i) => {
      const leaf = i === parts.length - 1;
      let kid = at.kids!.find((k) => k.name === name);
      if (!kid) {
        kid = leaf
          ? { name, mode: '100644', sha: blobSha(path) }
          : { name, mode: '040000', sha: '', kids: [] };
        at.kids!.push(kid);
      }
      at = kid;
    });
  }
  const hash = (node: Node) => {
    const kids = node.kids!;
    for (const k of kids) if (k.kids) hash(k);
    // git sorts a folder as if its name ended in a slash.
    const key = (k: Node) => (k.kids ? `${k.name}/` : k.name);
    kids.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const body = Buffer.concat(
      kids.flatMap((k) => [
        Buffer.from(`${k.mode.replace(/^0+/, '')} ${k.name}\0`),
        Buffer.from(k.sha, 'hex'),
      ]),
    );
    node.sha = createHash('sha1')
      .update(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]))
      .digest('hex');
  };
  hash(root);
  return root;
}

const entry = (k: Node, path: string): Listed =>
  k.kids
    ? { path, mode: k.mode, type: 'tree', sha: k.sha }
    : { path, mode: k.mode, type: 'blob', sha: k.sha, size: path.length };

/** A GitHub stand-in: recursive listings stop after `max` entries, folders before contents. */
function server(root: Node, max: number) {
  const bySha = new Map<string, Node>();
  const index = (n: Node) => {
    bySha.set(n.sha, n);
    n.kids?.forEach(index);
  };
  index(root);
  const calls: string[] = [];
  const list = (sha: string, recursive: boolean): Listing => {
    const out: Listed[] = [];
    let truncated = false;
    const walk = (n: Node, prefix: string) => {
      for (const k of n.kids!) {
        if (out.length >= max) return void (truncated = true);
        out.push(entry(k, prefix + k.name));
        if (recursive && k.kids) walk(k, `${prefix}${k.name}/`);
      }
    };
    walk(bySha.get(sha)!, '');
    return { entries: out, truncated };
  };
  const fetchTree = async (sha: string, recursive: boolean) => {
    calls.push(`${sha.slice(0, 7)}${recursive ? ' r' : ''}`);
    return list(sha, recursive);
  };
  return { list, fetchTree, calls };
}

function allPaths(root: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node, prefix: string) => {
    for (const k of n.kids!) {
      out.push(prefix + k.name);
      if (k.kids) walk(k, `${prefix}${k.name}/`);
    }
  };
  walk(root, '');
  return out;
}

// Six top folders, one of them big with nested folders, 300-odd entries in all.
const PATHS = [
  'README.md',
  ...['a', 'b', 'c', 'e', 'f'].flatMap((d) =>
    Array.from({ length: 12 }, (_, i) => `${d}/file${i}.c`),
  ),
  ...Array.from({ length: 8 }, (_, s) =>
    Array.from({ length: 25 }, (_, i) => `d/sub${s}/deep/x${i}.c`),
  ).flat(),
  'zz.txt',
];

describe('completeTree', () => {
  test('a listing that was not cut short is used as it is, with no requests', async () => {
    const root = build(PATHS);
    const gh = server(root, 1e9);
    const done = await completeTree(root.sha, gh.list(root.sha, true), gh.fetchTree);
    expect(done).toMatchObject({ truncated: false, requests: 0 });
    expect(done.entries.map((e) => e.path)).toEqual(allPaths(root));
  });

  test('keeps what proves whole and reads only the folders cut off', async () => {
    const root = build(PATHS);
    const gh = server(root, 150);
    const first = gh.list(root.sha, true);
    expect(first.truncated).toBe(true);

    const done = await completeTree(root.sha, first, gh.fetchTree);

    expect(done.truncated).toBe(false);
    expect(done.entries.map((e) => e.path)).toEqual(allPaths(root));
    // The root's own entries; e and f whole; d whole, still cut, so its own entries and the
    // subfolders it lost. a, b, c and d's first subfolders are never read again.
    expect(done.requests).toBe(8);
    expect(gh.calls.filter((c) => c.endsWith(' r'))).toHaveLength(6);
  });

  test('splits a folder still too big for one listing, a level at a time', async () => {
    const root = build(PATHS);
    const gh = server(root, 60);
    const done = await completeTree(root.sha, gh.list(root.sha, true), gh.fetchTree);
    expect(done.truncated).toBe(false);
    expect(done.entries.map((e) => e.path)).toEqual(allPaths(root));
  });

  test('trusts no order: a shuffled cut listing still comes out whole', async () => {
    const root = build(PATHS);
    const gh = server(root, 150);
    const first = gh.list(root.sha, true);
    let seed = 7;
    const shuffled = first.entries
      .map((e) => ({ e, k: (seed = (seed * 1103515245 + 12345) & 0x7fffffff) }))
      .sort((a, b) => a.k - b.k)
      .map(({ e }) => e);
    // Shuffling breaks each folder's order, so only folders read again are trusted.
    const done = await completeTree(root.sha, { entries: shuffled, truncated: true }, gh.fetchTree);
    expect(done.truncated).toBe(false);
    expect(done.entries.map((e) => e.path).sort()).toEqual(allPaths(root).sort());
  });

  test('a failed read keeps the partial tree, marked cut short', async () => {
    const root = build(PATHS);
    const gh = server(root, 150);
    const first = gh.list(root.sha, true);
    const done = await completeTree(root.sha, first, async () => undefined);
    expect(done.truncated).toBe(true);
    expect(done.entries.length).toBeGreaterThan(0);
  });

  test('stops at the request cap', async () => {
    const root = build(PATHS);
    const gh = server(root, 20);
    const done = await completeTree(root.sha, gh.list(root.sha, true), gh.fetchTree, {
      maxRequests: 2,
    });
    expect(done.truncated).toBe(true);
    expect(gh.calls.length).toBe(2);
  });
});
