/**
 * Sign in with GitHub through the history server. The token stays in this browser's
 * localStorage, is sent only as the Authorization header of history requests, and never goes
 * into a share link. Signing out forgets it.
 */

import { HISTORY_URL } from './history';

const KEY = 'repo-tree:github-signin';

/** The signed-in visitor's GitHub token, or null. */
export function signedInToken(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  try {
    return storage.getItem(KEY);
  } catch {
    return null;
  }
}

export function signOut(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    // Blocked storage held no token either.
  }
}

/**
 * Opens GitHub's sign-in in a popup (call it from a click, or the browser blocks it) and resolves
 * with the token once the server's callback page posts it, or null when the visitor closes the
 * popup, declines, or the popup is blocked.
 */
export function signIn(
  base: string | undefined = HISTORY_URL,
  win: Window = window,
  storage: Pick<Storage, 'setItem'> = localStorage,
): Promise<string | null> {
  if (!base) return Promise.resolve(null);
  const server = new URL(base, win.location.href);
  const url = new URL('v1/auth/login', server.href.endsWith('/') ? server : `${server.href}/`);
  url.searchParams.set('origin', win.location.origin);
  const popup = win.open(url.href, 'repo-tree-signin', 'popup,width=520,height=720');
  if (!popup) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (token: string | null) => {
      win.removeEventListener('message', onMessage);
      clearInterval(closed);
      resolve(token);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== server.origin || event.source !== popup) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      if (data.type !== 'repo-tree-auth') return;
      const token = 'token' in data && typeof data.token === 'string' ? data.token : null;
      if (token) {
        try {
          storage.setItem(KEY, token);
        } catch {
          // Signed in for this page only.
        }
      }
      finish(token);
    };
    win.addEventListener('message', onMessage);
    const closed = setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);
  });
}
