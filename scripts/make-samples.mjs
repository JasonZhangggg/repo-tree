#!/usr/bin/env node
// Regenerates public/samples/ with make-fixture.mjs and writes its index.json.
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const SAMPLES = [
  { label: 'Small', repo: 'mathiasbynens/dotfiles' },
  { label: 'Medium', repo: 'vitejs/vite' },
  { label: 'Large', repo: 'torvalds/linux' },
];
const dir = new URL('../public/samples/', import.meta.url);

const index = SAMPLES.map(({ label, repo }) => {
  const file = `${repo.replace('/', '-')}.json.gz`;
  const out = new URL(file, dir).pathname;
  execFileSync(
    'node',
    [new URL('make-fixture.mjs', import.meta.url).pathname, repo, out, '--slim'],
    {
      stdio: 'inherit',
    },
  );
  /** @type {{ tree: { tree: { type: string }[] } }} */
  const fixture = JSON.parse(gunzipSync(readFileSync(out)).toString());
  const files = fixture.tree.tree.filter((e) => e.type === 'blob').length;
  return { label, repo, file, files };
});

const tmp = new URL(`index.json.${process.pid}.tmp`, dir);
writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
renameSync(tmp, new URL('index.json', dir));
