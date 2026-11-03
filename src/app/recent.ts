const KEY = 'repo-tree:recent';
const LIMIT = 6;

export function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(name: string): void {
  const next = [name, ...readRecent().filter((r) => r.toLowerCase() !== name.toLowerCase())];
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, LIMIT)));
  } catch {
    // Private mode: recents just don't stick.
  }
}
