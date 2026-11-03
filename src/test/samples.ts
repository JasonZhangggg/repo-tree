import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { loadSample, type Snapshot } from '../repo/github';

export type SampleId = 'mathiasbynens-dotfiles' | 'vitejs-vite' | 'torvalds-linux';

export async function sample(id: SampleId): Promise<Snapshot> {
  const body = readFileSync(new URL(`../../public/samples/${id}.json.gz`, import.meta.url));
  vi.stubGlobal('fetch', async () => new Response(body));
  try {
    const snapshot = await loadSample(id);
    if ('kind' in snapshot) throw new Error(`sample ${id}: ${snapshot.kind}`);
    return snapshot;
  } finally {
    vi.unstubAllGlobals();
  }
}
