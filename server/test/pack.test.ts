import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InflateError, inflateAt } from '../src/core/inflate';
import {
  MAX_WANTS,
  PackError,
  PackReader,
  applyDelta,
  checkFetchRequest,
  fetchPack,
  fetchRequest,
  parseCommit,
  parseTree,
  pktLine,
  type PackObject,
} from '../src/core/pack';
import { gitOid } from '../src/core/sha1';
import { MODE, TreeStore } from '../src/core/store';
import { DAY, makeRepo, type Commit } from './repo';

const enc = new TextEncoder();

describe('inflate', () => {
  const samples = [
    new Uint8Array(0),
    enc.encode('a'),
    enc.encode('tree entries, tree entries, tree entries '.repeat(500)),
    new Uint8Array(randomBytes(70_000)),
    // Mostly text with some noise: dynamic blocks, long matches, literals.
    new Uint8Array(
      Buffer.concat(
        Array.from({ length: 200 }, (_, i) =>
          Buffer.concat([Buffer.from(`100644 file-${i % 37}.ts\0`), randomBytes(20)]),
        ),
      ),
    ),
  ];

  it('inflates what zlib deflates, at every level, and says where the stream ends', () => {
    for (const data of samples) {
      for (const level of [0, 1, 6, 9]) {
        const z = deflateSync(data, { level });
        const src = new Uint8Array(z.length + 7);
        src.set(z, 3);
        const got = inflateAt(src, 3, src.length, data.length);
        expect(got).not.toBeNull();
        expect(Buffer.from(got!.out).equals(Buffer.from(data))).toBe(true);
        expect(got!.end).toBe(3 + z.length);
      }
    }
  });

  it('waits for more when the input stops short, and fails when no more will come', () => {
    const data = samples[2]!;
    const z = deflateSync(data);
    for (const cut of [1, 2, 5, z.length >> 1, z.length - 4, z.length - 1]) {
      expect(inflateAt(z, 0, cut, data.length)).toBeNull();
      expect(() => inflateAt(z, 0, cut, data.length, true)).toThrow(InflateError);
    }
  });

  it('refuses a stream longer or shorter than the size it was given', () => {
    const data = samples[2]!;
    const z = deflateSync(data);
    expect(() => inflateAt(z, 0, z.length, data.length - 1, true)).toThrow(InflateError);
    expect(() => inflateAt(z, 0, z.length, data.length + 1, true)).toThrow(InflateError);
    expect(() => inflateAt(enc.encode('not zlib'), 0, 8, 1)).toThrow(InflateError);
  });
});

describe('git object ids', () => {
  it('match git hash-object for every padding length', () => {
    for (let n = 0; n < 200; n++) {
      const data = new Uint8Array(randomBytes(n));
      const want = createHash('sha1').update(`blob ${n}\0`).update(data).digest('hex');
      expect(gitOid('blob', data)).toBe(want);
    }
    const big = new Uint8Array(randomBytes(300_000));
    expect(gitOid('tree', big)).toBe(
      createHash('sha1').update(`tree ${big.length}\0`).update(big).digest('hex'),
    );
  });
});

describe('deltas', () => {
  it('refuses a result bigger than any object may be', () => {
    // base size 0, result size 2^30.
    const delta = new Uint8Array([0, 0x80, 0x80, 0x80, 0x80, 0x04]);
    expect(() => applyDelta(new Uint8Array(0), delta)).toThrow(/too large/);
  });

  it('copies from the base and inserts new bytes', () => {
    const base = enc.encode('hello, world');
    // base size 12, result size 11: copy 7 bytes at 0, insert "there".
    const delta = new Uint8Array([12, 12, 0x80 | 0x10, 7, 5, ...enc.encode('there')]);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe('hello, there');
    expect(() => applyDelta(enc.encode('short'), delta)).toThrow(PackError);
  });
});

// Enough similar trees for git to store most as deltas: one folder of many files, changed a
// little each commit, a few names past ASCII, a symlink, an executable and a submodule.
const COMMITS: Commit[] = Array.from({ length: 24 }, (_, i) => ({
  at: Date.UTC(2026, 0, 1) + i * 7 * DAY,
  files: Object.fromEntries([
    ...Array.from({ length: 60 }, (_, f) => [`src/lib/module-${f}.ts`, `v${f % (i + 1)}`]),
    [`docs/note-${i % 5}.md`, `n${i}`],
    ['naïve/Ünïcode-名前.txt', `u${i >> 2}`],
    [`deep/a/b/c/d/${i % 3}.txt`, String(i)],
  ]),
}));

let repo: ReturnType<typeof makeRepo>;
const git = (args: string[], input?: string | Uint8Array) =>
  execFileSync('git', ['-C', repo.dir, ...args], {
    ...(input !== undefined ? { input } : {}),
    maxBuffer: 1 << 28,
    env: { ...process.env, GIT_PROTOCOL: 'version=2' },
  });

beforeAll(() => {
  repo = makeRepo(COMMITS);
  const head = repo.shas[repo.shas.length - 1]!;
  // A symlink, an executable and a submodule, as git stores them.
  const blob = git(['hash-object', '-w', '--stdin'], 'target').toString().trim();
  const tree = git(
    ['mktree'],
    [
      `120000 blob ${blob}\tlink`,
      `100755 blob ${blob}\trun.sh`,
      `160000 commit ${repo.shas[0]}\tvendor`,
      `040000 tree ${git(['rev-parse', `${head}^{tree}`])
        .toString()
        .trim()}\tall`,
    ].join('\n') + '\n',
  )
    .toString()
    .trim();
  const commit = git(['commit-tree', tree, '-p', head, '-m', 'modes'], undefined).toString().trim();
  git(['update-ref', 'refs/heads/main', commit]);
  repo.shas.push(commit);
  git(['gc', '-q', '--aggressive']);
});
afterAll(() => repo.remove());

/** What `git upload-pack` answers to a request, as github.com would. */
function uploadPack(body: Uint8Array): Uint8Array {
  return new Uint8Array(
    execFileSync(
      'git',
      [
        '-c',
        'uploadpack.allowFilter=true',
        '-c',
        'uploadpack.allowAnySHA1InWant=true',
        'upload-pack',
        '--stateless-rpc',
        repo.dir,
      ],
      { input: body, maxBuffer: 1 << 28, env: { ...process.env, GIT_PROTOCOL: 'version=2' } },
    ),
  );
}

/** Reads a response in chunks of the given sizes (cycled). */
function read(
  res: Uint8Array,
  sizes: number[],
  options: { cacheBytes?: number; segmentBytes?: number } = {},
) {
  const objects: PackObject[] = [];
  const reader = new PackReader({ onObject: (o) => objects.push(o), ...options });
  for (let at = 0, k = 0; at < res.length; k++) {
    const n = sizes[k % sizes.length]!;
    reader.push(res.subarray(at, at + n));
    at += n;
  }
  return { objects, stats: reader.end() };
}

/** Every object `git cat-file` knows by these ids, as `oid type size`. */
function catFile(oids: string[]): string[] {
  return git(['cat-file', '--batch-check'], oids.join('\n') + '\n')
    .toString()
    .trim()
    .split('\n');
}

describe('pack reader', () => {
  it('reads every tree and commit of a real pack, deltas resolved, each named as git names it', () => {
    const res = uploadPack(fetchRequest(repo.shas));
    const { objects, stats } = read(res, [65536]);
    expect(stats.deltas).toBeGreaterThan(10);
    expect(stats.shallow).toBe(repo.shas.length);
    expect(objects.some((o) => o.type === 'blob')).toBe(false);
    expect(catFile(objects.map((o) => o.oid))).toEqual(
      objects.map((o) => `${o.oid} ${o.type} ${o.data.length}`),
    );
    // Every tree of every commit, and nothing else.
    const trees = new Set(
      git(['rev-list', '--objects', '--no-walk', '--filter=blob:none', ...repo.shas])
        .toString()
        .trim()
        .split('\n')
        .map((l) => l.split(' ')[0]!),
    );
    expect(new Set(objects.map((o) => o.oid))).toEqual(trees);
    const head = objects.find((o) => o.oid === repo.shas[repo.shas.length - 1]);
    expect(parseCommit(head!.data)).toEqual({
      tree: git(['rev-parse', 'HEAD^{tree}']).toString().trim(),
      parents: [repo.shas[repo.shas.length - 2]],
    });
  });

  it('reads the same objects however the stream is cut, with no cache and tiny segments', () => {
    const res = uploadPack(fetchRequest(repo.shas));
    const whole = read(res, [res.length]).objects.map((o) => o.oid);
    expect(read(res, [1]).objects.map((o) => o.oid)).toEqual(whole);
    expect(read(res, [7, 1, 4093, 3, 65536]).objects.map((o) => o.oid)).toEqual(whole);
    const cold = read(res, [999], { cacheBytes: 0, segmentBytes: 64 });
    expect(cold.objects.map((o) => o.oid)).toEqual(whole);
    expect(cold.stats.reinflated).toBeGreaterThan(0);
  });

  it('resolves deltas against a base named by its id (no ofs-delta asked)', () => {
    const body = new TextDecoder()
      .decode(fetchRequest(repo.shas))
      .replace(pktLine('ofs-delta\n'), '');
    const res = uploadPack(enc.encode(body));
    const { objects, stats } = read(res, [4096]);
    expect(stats.deltas).toBeGreaterThan(0);
    expect(catFile(objects.map((o) => o.oid))).toEqual(
      objects.map((o) => `${o.oid} ${o.type} ${o.data.length}`),
    );
  });

  it('parses trees as git lists them: modes, names past ASCII, submodules', () => {
    const res = uploadPack(fetchRequest([repo.shas[repo.shas.length - 1]!]));
    const byOid = new Map(read(res, [65536]).objects.map((o) => [o.oid, o]));
    const root = git(['rev-parse', 'HEAD^{tree}']).toString().trim();
    for (const oid of [root, git(['rev-parse', 'HEAD:all']).toString().trim()]) {
      const listed = git(['ls-tree', '-z', oid])
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const [meta = '', name] = line.split('\t');
          return { name, oid: meta.split(' ')[2] };
        });
      const entries = parseTree(byOid.get(oid)!.data);
      expect(entries.map(({ name, oid }) => ({ name, oid }))).toEqual(listed);
    }
    expect(parseTree(byOid.get(root)!.data).map((e) => [e.name, e.mode])).toEqual([
      ['all', MODE.tree],
      ['link', MODE.link],
      ['run.sh', MODE.exec],
      ['vendor', MODE.module],
    ]);
  });

  it('fills a tree store the way the GraphQL reader does', async () => {
    const res = uploadPack(fetchRequest(repo.shas));
    const raw = new TreeStore();
    const viaEntries = new TreeStore();
    const got = await fetchPack(repo.shas, raw, {
      url: 'https://history.test/v1/git/acme/app/git-upload-pack',
      token: 't',
      fetch: (async () => new Response(res)) as unknown as typeof fetch,
    });
    for (const o of read(res, [65536]).objects) {
      if (o.type === 'tree') viaEntries.add(viaEntries.id(o.oid), parseTree(o.data));
    }
    expect(got.commits.size).toBe(repo.shas.length);
    expect(raw.trees).toBe(viaEntries.trees);
    for (let t = 0; t < raw.trees; t++) {
      const u = viaEntries.id(raw.oids[t]!);
      const rows = (s: TreeStore, id: number) =>
        Array.from({ length: s.length(id) }, (_, i) => [
          s.key(id, i),
          s.mode(id, i),
          s.isTree(id, i) ? s.oids[s.ref(id, i)] : s.ref(id, i),
          s.keptOid(id, i),
        ]);
      expect(rows(raw, t)).toEqual(rows(viaEntries, u));
    }
  });

  it('fails on a blob, a remote error, a cut-short answer, or bytes past the end', () => {
    const noFilter = new TextDecoder()
      .decode(fetchRequest([repo.shas[0]!]))
      .replace(pktLine('filter blob:none\n'), '');
    expect(() => read(uploadPack(enc.encode(noFilter)), [65536])).toThrow(/blob in pack/);
    const res = uploadPack(fetchRequest(repo.shas));
    expect(() => read(res.subarray(0, res.length >> 1), [65536])).toThrow(/truncated/);
    expect(() => read(res.subarray(0, res.length - 4), [65536])).toThrow(/truncated/);
    const err = enc.encode(`${pktLine('packfile\n')}${pktLine('\x03fatal: no such object\n')}0000`);
    expect(() => read(err, [65536])).toThrow(/remote: fatal: no such object/);
    expect(() => read(enc.encode(`${pktLine('ERR upload-pack: not our ref')}0000`), [9])).toThrow(
      /ERR upload-pack/,
    );
    const extra = new Uint8Array(res.length + 4);
    extra.set(res);
    extra.set(enc.encode('0000'), res.length);
    expect(() => read(extra, [65536])).toThrow(/past the end/);
  });
});

describe('fetch request check', () => {
  const sha = 'a'.repeat(40);
  const body = (args: string[], caps = ['agent=repo-tree', 'object-format=sha1']) =>
    enc.encode(
      [pktLine('command=fetch\n'), ...caps.map((c) => pktLine(`${c}\n`)), '0001']
        .concat(args.map((a) => pktLine(`${a}\n`)))
        .join('') + '0000',
    );
  const BASE = ['no-progress', 'ofs-delta', 'deepen 1', 'filter blob:none', `want ${sha}`, 'done'];

  it('takes what the pack client sends', () => {
    expect(checkFetchRequest(fetchRequest([sha, 'b'.repeat(40)]))).toEqual({
      ok: true,
      wants: [sha, 'b'.repeat(40)],
    });
    expect(checkFetchRequest(body(BASE))).toEqual({ ok: true, wants: [sha] });
    expect(checkFetchRequest(body([...BASE, `want ${sha}`]))).toEqual({ ok: true, wants: [sha] });
    const most = Array.from({ length: MAX_WANTS }, (_, i) => i.toString(16).padStart(40, '0'));
    expect(checkFetchRequest(fetchRequest(most)).ok).toBe(true);
  });

  it('refuses anything that could pull blobs, or more than it should', () => {
    const without = (arg: string) => body(BASE.filter((a) => a !== arg));
    const swap = (arg: string, by: string) => body(BASE.map((a) => (a === arg ? by : a)));
    const refused = [
      without('filter blob:none'),
      swap('filter blob:none', 'filter blob:limit=1000000'),
      swap('filter blob:none', 'filter tree:0'),
      without('deepen 1'),
      swap('deepen 1', 'deepen 2'),
      swap('deepen 1', 'deepen-since 0'),
      without('done'),
      without(`want ${sha}`),
      body([...BASE, `have ${sha}`]),
      body([...BASE, 'include-tag']),
      body([...BASE, 'thin-pack']),
      body([...BASE, 'want-ref refs/heads/main']),
      body([...BASE, 'packfile-uris https']),
      body([...BASE, 'filter blob:none']),
      swap(`want ${sha}`, 'want HEAD'),
      body(BASE, ['agent=x', 'object-format=sha256']),
      body(BASE, ['server-option=x']),
      fetchRequest(
        Array.from({ length: MAX_WANTS + 1 }, (_, i) => i.toString(16).padStart(40, '0')),
      ),
      enc.encode(new TextDecoder().decode(body(BASE)).replace('command=fetch', 'command=ls-refs')),
      enc.encode('zzzz'),
      // A byte-order mark a decoder would drop, and a byte past ASCII.
      new Uint8Array([0xef, 0xbb, 0xbf, ...body(BASE)]),
      enc.encode(
        new TextDecoder().decode(body(BASE)).replace('command=fetch', 'command=fetc\u00e9'),
      ),
      enc.encode(new TextDecoder().decode(body(BASE)).replace('done\n', 'do\nne')),
      body(BASE).subarray(0, 30),
      new Uint8Array(70_000),
    ];
    for (const b of refused) expect(checkFetchRequest(b).ok).toBe(false);
  });
});

/** A response holding a pack of these raw objects (type, header bytes after the size, data). */
function syntheticPack(
  objects: { type: number; extra?: number[]; data: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [enc.encode('PACK'), new Uint8Array([0, 0, 0, 2])];
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, objects.length);
  parts.push(count);
  for (const o of objects) {
    const head: number[] = [];
    let size = o.data.length;
    let c = (o.type << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      head.push(c | 0x80);
      c = size & 0x7f;
      size = Math.floor(size / 128);
    }
    head.push(c, ...(o.extra ?? []));
    parts.push(new Uint8Array(head), new Uint8Array(deflateSync(o.data, { level: 1 })));
  }
  parts.push(new Uint8Array(20));
  const pack = Buffer.concat(parts);
  const out: Buffer[] = [Buffer.from(pktLine('packfile\n'))];
  for (let at = 0; at < pack.length; at += 65515) {
    const part = pack.subarray(at, at + 65515);
    out.push(Buffer.from((part.length + 5).toString(16).padStart(4, '0')), Buffer.from([1]), part);
  }
  out.push(Buffer.from('0000'));
  return new Uint8Array(Buffer.concat(out));
}

describe('pack reader limits', () => {
  it('reads a big object in a few tries as it streams in, not one per chunk', () => {
    const timed = (mb: number) => {
      const data = new Uint8Array(randomBytes(mb << 20));
      const res = syntheticPack([{ type: 1, data }]);
      const t0 = performance.now();
      const { objects, stats } = read(res, [65536]);
      expect(objects[0]!.oid).toBe(gitOid('commit', data));
      return { ms: performance.now() - t0, retries: stats.retries };
    };
    const small = timed(16);
    const big = timed(64);
    // 1,024 chunks of 64 KiB: a try each would inflate 32 GB in all.
    expect(big.retries).toBeLessThan(40);
    expect(big.ms / small.ms).toBeLessThan(8);
  }, 60_000);

  it('refuses a delta whose base is itself', () => {
    const res = syntheticPack([
      { type: 1, data: enc.encode('tree ' + 'a'.repeat(40) + '\n\nx') },
      { type: 6, extra: [0], data: new Uint8Array([0, 1, 1, 120]) },
    ]);
    expect(() => read(res, [65536])).toThrow(/bad ofs delta/);
  });

  it('gives up on a pack past its byte cap', async () => {
    const res = uploadPack(fetchRequest(repo.shas));
    const how = {
      url: 'https://history.test/v1/git/acme/app/git-upload-pack',
      token: 't',
      fetch: (async () => new Response(res)) as unknown as typeof fetch,
    };
    await expect(
      fetchPack(repo.shas, new TreeStore(), { ...how, maxBytes: res.length >> 1 }),
    ).rejects.toThrow(/pack too large/);
    await expect(
      fetchPack(repo.shas, new TreeStore(), { ...how, maxBytes: res.length }),
    ).resolves.toMatchObject({ bytes: res.length });
  });
});
