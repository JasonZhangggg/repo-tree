import { growTree, type TreeModel } from '../grow/grow';
import { fetchSnapshot, loadSample, type LoadError, type Snapshot } from '../repo/github';
import { buildHierarchy } from '../repo/hierarchy';
import { cachedSnapshot, cacheSnapshot } from './cache';
import type { LoadRequest, LoadSource, WorkerMessage } from './load-in-worker';
import { indexRepo, type RepoIndex } from './repo-index';

const post = (message: WorkerMessage, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

self.onmessage = async ({ data: { source, filters, params } }: MessageEvent<LoadRequest>) => {
  post({ step: 'fetch' });
  const snapshot = await snapshotOf(source);
  if ('kind' in snapshot) return post({ error: snapshot });
  post({ step: 'build' });
  const dir = buildHierarchy(snapshot, filters);
  if (dir.fileCount === 0) return post({ error: { kind: 'empty' } });
  post({ step: 'grow' });
  const tree = growTree(dir, params);
  const index = indexRepo(dir);
  const { files, ...info } = snapshot;
  const paths = index.files.paths.join('\n');
  index.files.paths = [];
  post(
    { loaded: { info: { ...info, files: files.length }, tree, index }, paths },
    buffers(tree, index),
  );
};

async function snapshotOf(source: LoadSource): Promise<Snapshot | LoadError> {
  if (source.kind === 'sample') return loadSample(source.id, source.base);
  const { owner, repo, ref = '' } = source.ref;
  const key = `${owner}/${repo}@${ref}`.toLowerCase();
  const hit = source.fresh ? undefined : await cachedSnapshot(key);
  if (hit) {
    post({ branch: hit.branch });
    return hit;
  }
  const snapshot = await fetchSnapshot(source.ref, source.token, undefined, (branch) =>
    post({ branch }),
  );
  if (!('kind' in snapshot)) await cacheSnapshot(key, snapshot);
  return snapshot;
}

function buffers({ bark, leaves, nodes, folders, sprigs }: TreeModel, index: RepoIndex): ArrayBuffer[] {
  const arrays = [
    ...Object.values(bark),
    ...Object.values(leaves),
    ...Object.values(nodes),
    folders.range,
    ...Object.values(sprigs),
    ...Object.values(index.folders),
    index.files.size,
    index.files.folder,
  ];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}
