/**
 * Where a history computation's time and bytes went, so a real run explains itself: wall time
 * per phase, and per kind of GitHub request its count, bytes and latency, the time spent waiting
 * out rate limits, and the GraphQL batches. The engine fills one (EngineOptions.trace); the page
 * adds the upload and logs `formatTrace` (repo/compute-history.ts, app/ui/history-compute.ts).
 */

export type RequestKind =
  'listing' | 'probe' | 'pack' | 'tree' | 'graphql' | 'commit' | 'blob' | 'upload';

/** The phases, in the order a run starts them. They overlap: most run side by side. */
export const PHASES = [
  'listings',
  'probes',
  'head tree',
  'pack',
  'graphql',
  'rest',
  'recent',
  'upload',
] as const;
export type Phase = (typeof PHASES)[number];

export type KindSummary = {
  kind: RequestKind;
  requests: number;
  /** Body bytes as read (decoded). */
  bytes: number;
  /** Bytes on the wire (gzipped), where the host could tell. */
  wire?: number;
  meanMs: number;
  p90Ms: number;
};

export type TraceSummary = {
  /** From the first request to the end of the run (the upload included once the page adds it). */
  ms: number;
  /** Phases that ran: when each started (ms from the run's start) and how long it took. */
  phases: { name: Phase; from: number; ms: number }[];
  kinds: KindSummary[];
  requests: number;
  bytes: number;
  /** Time spent waiting out rate limits or Retry-After, summed over requests. */
  waitedMs: number;
  retried: number;
  /** GraphQL batch sizes sent, size → queries. */
  batches: Record<string, number>;
  /** GraphQL queries GitHub failed (each split and resent). */
  failed: number;
  /**
   * The first tree reader did not read them all: the pack failed (GraphQL, then REST, read the
   * rest), or, without a pack, GraphQL gave up or was not used (REST read them).
   */
  fellBack: boolean;
  /** Milliseconds of main-thread work folding trees and summarizing. */
  cpuMs: number;
};

export type Trace = {
  begin(phase: Phase): void;
  end(phase: Phase): void;
  /** One HTTP exchange: its latency, body bytes, and wire bytes when known. */
  request(kind: RequestKind, ms: number, bytes: number, wire?: number): void;
  waited(ms: number): void;
  batch(size: number, ok: boolean): void;
  cpu(ms: number): void;
  retried: number;
  fellBack: boolean;
  /** Bytes read so far, for an honest progress line. */
  readonly bytes: number;
  summary(): TraceSummary;
};

/** The kind of a GitHub API path, as the engine asks for them. */
export function kindOf(path: string): RequestKind {
  if (path.startsWith('/graphql')) return 'graphql';
  if (/\/git\/trees\//.test(path)) return 'tree';
  if (/\/git\/blobs\//.test(path)) return 'blob';
  if (/\/commits\/[0-9a-f]{40}/.test(path)) return 'commit';
  return /[?&]until=/.test(path) ? 'probe' : 'listing';
}

export function tracer(now: () => number = () => performance.now()): Trace {
  const start = now();
  const spans = new Map<Phase, { from: number; to: number | null }>();
  const kinds = new Map<RequestKind, { ms: number[]; bytes: number; wire: number }>();
  const batches: Record<string, number> = {};
  let waitedMs = 0;
  let failed = 0;
  let cpuMs = 0;
  let bytes = 0;
  return {
    retried: 0,
    fellBack: false,
    get bytes() {
      return bytes;
    },
    begin(phase) {
      if (!spans.has(phase)) spans.set(phase, { from: now() - start, to: null });
    },
    end(phase) {
      const span = spans.get(phase);
      if (span && span.to === null) span.to = now() - start;
    },
    request(kind, ms, size, wire) {
      let k = kinds.get(kind);
      if (!k) kinds.set(kind, (k = { ms: [], bytes: 0, wire: 0 }));
      k.ms.push(ms);
      k.bytes += size;
      k.wire += wire ?? 0;
      bytes += size;
    },
    waited(ms) {
      waitedMs += ms;
    },
    batch(size, ok) {
      if (!ok) failed++;
      else batches[size] = (batches[size] ?? 0) + 1;
    },
    cpu(ms) {
      cpuMs += ms;
    },
    summary() {
      const at = now() - start;
      const list: KindSummary[] = [...kinds].map(([kind, k]) => {
        const sorted = [...k.ms].sort((a, b) => a - b);
        const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
        return {
          kind,
          requests: sorted.length,
          bytes: k.bytes,
          ...(k.wire > 0 ? { wire: k.wire } : {}),
          meanMs: Math.round(mean),
          p90Ms: Math.round(
            sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? 0,
          ),
        };
      });
      return {
        ms: Math.round(at),
        phases: PHASES.flatMap((name) => {
          const span = spans.get(name);
          return span
            ? [{ name, from: Math.round(span.from), ms: Math.round((span.to ?? at) - span.from) }]
            : [];
        }),
        kinds: list,
        requests: list.reduce((n, k) => n + k.requests, 0),
        bytes: list.reduce((n, k) => n + k.bytes, 0),
        waitedMs: Math.round(waitedMs),
        retried: this.retried,
        batches: { ...batches },
        failed,
        fellBack: this.fellBack,
        cpuMs: Math.round(cpuMs),
      };
    },
  };
}

/** Adds the upload, which the page makes after the engine's run, to a run's summary. */
export function withUpload(
  s: TraceSummary,
  upload: { from: number; ms: number; bytes: number },
): TraceSummary {
  return {
    ...s,
    ms: Math.round(Math.max(s.ms, upload.from + upload.ms)),
    phases: [
      ...s.phases,
      { name: 'upload', from: Math.round(upload.from), ms: Math.round(upload.ms) },
    ],
    kinds: [
      ...s.kinds,
      {
        kind: 'upload',
        requests: 1,
        bytes: upload.bytes,
        meanMs: Math.round(upload.ms),
        p90Ms: Math.round(upload.ms),
      },
    ],
    requests: s.requests + 1,
  };
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;

/**
 * One line: total, then each phase's wall time, then per kind its requests, bytes and mean/p90
 * latency, then waits, batches and whether the first tree reader (the pack, else GraphQL) fell back.
 */
export function formatTrace(repo: string, s: TraceSummary): string {
  const phases = s.phases.map((p) => `${p.name} ${sec(p.ms)}`).join(', ');
  const kinds = s.kinds
    .map(
      (k) =>
        `${k.kind} ${k.requests} req ${mb(k.wire ?? k.bytes)}${k.wire ? ' gz' : ''} ` +
        `${k.meanMs}/${k.p90Ms} ms`,
    )
    .join(', ');
  const batches = Object.entries(s.batches)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([size, n]) => `${size}x${n}`)
    .join(' ');
  return (
    `history ${repo}: ${sec(s.ms)}, ${s.requests} requests, ${mb(s.bytes)} | ${phases} | ` +
    `${kinds} (mean/p90) | waited ${sec(s.waitedMs)}, retried ${s.retried} | ` +
    `graphql batches ${batches || 'none'}${s.failed ? `, ${s.failed} failed` : ''} | ` +
    `fell back: ${s.fellBack ? 'yes' : 'no'} | cpu ${sec(s.cpuMs)}`
  );
}
