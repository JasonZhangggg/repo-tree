export type RepoRef = { owner: string; repo: string; ref?: string } & {
  readonly __brand: 'RepoRef';
};
export type ParseError = { kind: 'invalid-ref' };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
const INVALID: ParseError = { kind: 'invalid-ref' };

export function parseRepoRef(input: string): RepoRef | ParseError {
  const text = input.trim();
  const prefix = URL_PREFIX.exec(text);
  // Spaces around the slash (`owner / repo`) are a typing slip, not part of either name.
  if (!prefix) return toRef(text.split('/').map((part) => part.trim()));

  const path = text.slice(prefix[0].length).split(/[?#]/)[0] ?? '';
  const [owner = '', repo = '', view, ...rest] = path.split('/').filter(Boolean);
  if (view !== 'tree') return toRef([owner, repo]);
  const ref = decode(rest.join('/'));
  if (!ref) return INVALID;
  return toRef([owner, repo], ref);
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function toRef(segments: string[], ref?: string): RepoRef | ParseError {
  if (segments.length !== 2) return INVALID;
  const [owner = '', name = ''] = segments;
  const repo = name.endsWith('.git') ? name.slice(0, -4) : name;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return INVALID;
  return (ref === undefined ? { owner, repo } : { owner, repo, ref }) as RepoRef;
}
