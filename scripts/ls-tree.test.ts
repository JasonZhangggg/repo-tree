import { expect, test } from 'vitest';
import { toTreeResponse } from './ls-tree.mjs';

const API = 'https://api.github.com/repos/octo/demo';

// Captured from `git ls-tree -r -t -l -z HEAD` on a repo with a symlink, an executable,
// a submodule and a path holding a space, a tab and a non-ASCII character.
const output = [
  '120000 blob e0e63473c2593040d7d1c67637864821b28cef4b       6\tlink',
  '100755 blob 1a2485251c33a70432394c93fb89330ef214bfc9      10\trun.sh',
  '040000 tree a0718396b375d2985445606f7c397493cb21f6c4       -\tsrc',
  '040000 tree 169a8c05d2dd2ff0a8082ef7e0103508f9888543       -\tsrc/a b',
  '100644 blob 45b983be36b73c0788dc9cbcb76cbb80fc7bb057       3\tsrc/a b/tab\tü.ts',
  '040000 tree 572e85c9899d5fb69110eab1df80bed6b9991abe       -\tvendor',
  '160000 commit 1111111111111111111111111111111111111111       -\tvendor/lib',
  '',
].join('\0');

test('matches the GitHub recursive trees response', () => {
  expect(toTreeResponse(output, { fullName: 'octo/demo', treeSha: 'f00d' })).toEqual({
    sha: 'f00d',
    url: `${API}/git/trees/f00d`,
    truncated: false,
    tree: [
      {
        path: 'link',
        mode: '120000',
        type: 'blob',
        sha: 'e0e63473c2593040d7d1c67637864821b28cef4b',
        size: 6,
        url: `${API}/git/blobs/e0e63473c2593040d7d1c67637864821b28cef4b`,
      },
      {
        path: 'run.sh',
        mode: '100755',
        type: 'blob',
        sha: '1a2485251c33a70432394c93fb89330ef214bfc9',
        size: 10,
        url: `${API}/git/blobs/1a2485251c33a70432394c93fb89330ef214bfc9`,
      },
      {
        path: 'src',
        mode: '040000',
        type: 'tree',
        sha: 'a0718396b375d2985445606f7c397493cb21f6c4',
        url: `${API}/git/trees/a0718396b375d2985445606f7c397493cb21f6c4`,
      },
      {
        path: 'src/a b',
        mode: '040000',
        type: 'tree',
        sha: '169a8c05d2dd2ff0a8082ef7e0103508f9888543',
        url: `${API}/git/trees/169a8c05d2dd2ff0a8082ef7e0103508f9888543`,
      },
      {
        path: 'src/a b/tab\tü.ts',
        mode: '100644',
        type: 'blob',
        sha: '45b983be36b73c0788dc9cbcb76cbb80fc7bb057',
        size: 3,
        url: `${API}/git/blobs/45b983be36b73c0788dc9cbcb76cbb80fc7bb057`,
      },
      {
        path: 'vendor',
        mode: '040000',
        type: 'tree',
        sha: '572e85c9899d5fb69110eab1df80bed6b9991abe',
        url: `${API}/git/trees/572e85c9899d5fb69110eab1df80bed6b9991abe`,
      },
      {
        path: 'vendor/lib',
        mode: '160000',
        type: 'commit',
        sha: '1111111111111111111111111111111111111111',
      },
    ],
  });
});

test('slim keeps only path, mode, type and size per entry', () => {
  const { sha, tree } = toTreeResponse(output, {
    fullName: 'octo/demo',
    treeSha: 'f00d',
    slim: true,
  });
  expect(sha).toBe('f00d');
  expect(tree.map((e) => Object.keys(e))).toEqual([
    ['path', 'mode', 'type', 'size'],
    ['path', 'mode', 'type', 'size'],
    ['path', 'mode', 'type'],
    ['path', 'mode', 'type'],
    ['path', 'mode', 'type', 'size'],
    ['path', 'mode', 'type'],
    ['path', 'mode', 'type'],
  ]);
});
