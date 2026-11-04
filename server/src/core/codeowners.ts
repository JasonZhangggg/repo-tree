/** CODEOWNERS parsing and the folder lookup the owner colors need. */

export type OwnerRule = { pattern: string; owners: string[] };

/** Where GitHub looks, in its order of precedence. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern = '', ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Owners of a folder: the last rule that matches the folder itself or any file directly in it
 * whose name no extension rule singles out. '' is the root. Gitignore-style patterns: a leading
 * or inner slash anchors to the root, a trailing slash matches folders only, `*` stays inside one
 * segment and `**` crosses segments.
 */
export function ownersOf(folder: string, rules: readonly OwnerRule[]): string[] {
  const probes = folder ? [folder, `${folder}/\u0000`] : ['\u0000'];
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    const re = toRegExp(rule.pattern);
    if (probes.some((p) => re.test(p))) return rule.owners;
  }
  return [];
}

function toRegExp(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      body += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const start = anchored ? '^' : '^(?:.*/)?';
  // A match on a folder covers everything below it; a folder-only pattern needs something below.
  const end = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(start + body + end);
}
