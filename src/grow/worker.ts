import { buildHierarchy } from '../repo/hierarchy';
import { growTree, type TreeModel } from './grow';
import type { GrowRequest } from './grow-in-worker';

self.onmessage = (event: MessageEvent<GrowRequest>) => {
  const request = event.data;
  const dir = 'dir' in request ? request.dir : buildHierarchy(request.snapshot, request.filters);
  const tree = growTree(dir, request.params);
  self.postMessage(tree, { transfer: buffers(tree) });
};

function buffers({ bark, leaves, nodes, folders }: TreeModel): ArrayBuffer[] {
  const arrays = [
    ...Object.values(bark),
    ...Object.values(leaves),
    ...Object.values(nodes),
    folders.range,
  ];
  return arrays.map((array) => array.buffer as ArrayBuffer);
}
