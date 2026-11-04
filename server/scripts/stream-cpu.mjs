#!/usr/bin/env node
// What passing a 50 MB answer through a Worker costs in workerd (Miniflare, from node_modules):
// an untouched body, piped by the runtime, against the same body through `capped` (worker.ts,
// copied below as plain JS) and through a TransformStream counting bytes. CPU is the workerd
// process's own (/proc, user + system), median of 8 fetches; the chunks a fetch body arrives in
// are logged by the capped run.
//
//   node scripts/stream-cpu.mjs [port, default 9605]
import { readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { Miniflare } from 'miniflare';

const PORT = Number(process.argv[2] ?? 9605);
const BYTES = 50e6;
const script = `
function capped(body, max) {
  const reader = body.getReader();
  let n = 0, chunks = 0;
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { console.log('chunks ' + chunks + ', ' + Math.round(n / chunks) + ' bytes each'); return controller.close(); }
      n += value.byteLength; chunks++;
      if (n <= max) return controller.enqueue(value);
      controller.error(new Error('pack too large'));
      await reader.cancel().catch(() => undefined);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
}
function counted(body, max) {
  let n = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, c) { n += chunk.byteLength; if (n > max) c.error(new Error('too large')); else c.enqueue(chunk); },
  }));
}
export default {
  async fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const up = await fetch('http://127.0.0.1:${PORT}/');
    if (mode === 'capped') return new Response(capped(up.body, 2e8));
    if (mode === 'transform') return new Response(counted(up.body, 2e8));
    return new Response(up.body);
  },
};`;

const server = http
  .createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let left = BYTES;
    const buf = Buffer.alloc(65536, 7);
    const go = () => {
      while (left > 0) {
        left -= buf.length;
        if (!res.write(buf)) return res.once('drain', go);
      }
      res.end();
    };
    go();
  })
  .listen(PORT);
const mf = new Miniflare({ modules: true, script, compatibilityDate: '2024-09-23' });
await mf.ready;
const mine = readdirSync('/proc')
  .filter((p) => /^\d+$/.test(p))
  .filter((p) => {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
      return (
        readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('workerd') &&
        stat.split(') ')[1]?.split(' ')[1] === String(process.pid)
      );
    } catch {
      return false;
    }
  });
/** CPU ms of this run's workerd (clock ticks of 10 ms). */
const cpu = () =>
  mine.reduce((sum, p) => {
    const f = readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1]?.split(' ') ?? [];
    return sum + Number(f[11]) + Number(f[12]);
  }, 0) * 10;
const once = async (/** @type {string} */ mode) => {
  const res = await mf.dispatchFetch(`http://worker/${mode}`);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
  }
  if (n < BYTES) throw new Error(`${mode}: ${n} bytes`);
};
/** @type {Record<string, number>} */
const out = {};
for (const mode of ['untouched', 'capped', 'transform']) {
  await once(mode);
  const runs = [];
  for (let i = 0; i < 8; i++) {
    const before = cpu();
    await once(mode);
    runs.push(cpu() - before);
  }
  runs.sort((a, b) => a - b);
  out[`${mode}CpuMs`] = runs[4] ?? NaN;
}
console.log(JSON.stringify({ bytes: BYTES, workerdPid: mine, ...out }));
await mf.dispose();
server.close();
