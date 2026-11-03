const API = 'https://api.github.com/repos';

/** @typedef {{ path: string, mode: string, type: string, sha?: string, size?: number, url?: string }} TreeEntry */

/**
 * Turns `git ls-tree -r -t -l -z` output into the body GitHub returns for
 * GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1. `slim` drops each entry's
 * sha and url, which the app never reads, so large fixtures stay small.
 *
 * @param {string} output
 * @param {{ fullName: string, treeSha: string, slim?: boolean }} options
 */
export function toTreeResponse(output, { fullName, treeSha, slim = false }) {
  const tree = output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', type = '', sha = '', size = ''] = record.slice(0, tab).split(/ +/);
      /** @type {TreeEntry} */
      const entry = { path: record.slice(tab + 1), mode, type };
      if (!slim) entry.sha = sha;
      if (type === 'blob') entry.size = Number(size);
      // Submodule entries carry no url in the API response.
      if (!slim && type !== 'commit') entry.url = `${API}/${fullName}/git/${type}s/${sha}`;
      return entry;
    });
  return { sha: treeSha, url: `${API}/${fullName}/git/trees/${treeSha}`, tree, truncated: false };
}
