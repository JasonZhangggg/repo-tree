import { describe, expect, test, vi } from 'vitest';
import { signIn, signOut, signedInToken } from './auth';

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

function fakeWindow(popup: object | null) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const opened: string[] = [];
  const win = {
    location: {
      href: 'https://jasonzhangggg.github.io/repo-tree/',
      origin: 'https://jasonzhangggg.github.io',
    },
    open: vi.fn((url: string) => {
      opened.push(url);
      return popup;
    }),
    addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
  };
  const post = (data: unknown, origin: string, source: unknown = popup) =>
    listeners.forEach((fn) => fn({ data, origin, source } as MessageEvent));
  return { win: win as unknown as Window, opened, post };
}

describe('signIn', () => {
  test('opens the server login for this origin and keeps the token the server posts', async () => {
    const popup = { closed: false };
    const { win, opened, post } = fakeWindow(popup);
    const storage = memory();
    const done = signIn('https://history.example', win, storage);
    expect(opened).toEqual([
      'https://history.example/v1/auth/login?origin=https%3A%2F%2Fjasonzhangggg.github.io',
    ]);
    post({ type: 'repo-tree-auth', token: 'gho_evil' }, 'https://evil.example');
    post({ type: 'repo-tree-auth', token: 'gho_good' }, 'https://history.example');
    expect(await done).toBe('gho_good');
    expect(signedInToken(storage)).toBe('gho_good');
    signOut(storage);
    expect(signedInToken(storage)).toBeNull();
  });

  test('resolves null when declined, blocked or history is off', async () => {
    const { win, post } = fakeWindow({ closed: false });
    const done = signIn('https://history.example', win, memory());
    post({ type: 'repo-tree-auth', error: 'denied' }, 'https://history.example');
    expect(await done).toBeNull();
    expect(await signIn('https://history.example', fakeWindow(null).win, memory())).toBeNull();
    expect(await signIn('', fakeWindow({}).win, memory())).toBeNull();
  });
});
