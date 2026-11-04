import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DAY = 24 * 60 * 60 * 1000;

export type Change = Record<string, string | null>;
export type Commit = { at: number; author?: string; files: Change };

/** A git repo whose commits land at the given times, oldest first. Null deletes a file. */
export function makeRepo(commits: Commit[]): { dir: string; shas: string[]; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'history-test-'));
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    }).trim();
  git(['init', '-q', '-b', 'main']);
  const shas: string[] = [];
  for (const c of commits) {
    // Files are written and removed first, then staged in one `git add -A`: a git process per
    // file makes setup slow enough to time out a test's hook on a busy CI runner.
    for (const [path, content] of Object.entries(c.files)) {
      const file = join(dir, path);
      if (content === null) {
        rmSync(file);
        continue;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    git(['add', '-A']);
    const date = new Date(c.at).toISOString();
    const name = c.author ?? 'ada';
    git(['commit', '-q', '--allow-empty', '-m', `at ${date}`], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: `${name}@example.com`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: `${name}@example.com`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
    shas.push(git(['rev-parse', 'HEAD']));
  }
  return { dir, shas, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: async <T>(key: string) => (data.has(key) ? (JSON.parse(data.get(key)!) as T) : null),
    put: async (key: string, value: unknown) => {
      data.set(key, JSON.stringify(value));
    },
  };
}
