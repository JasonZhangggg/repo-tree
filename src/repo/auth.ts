/**
 * Sign in with GitHub through the history server. The token is kept in this browser
 * (localStorage, so a new tab, a reload or a relaunched home-screen app stays signed in) until
 * the visitor signs out or GitHub refuses it. It has no scopes, so it reads public data only.
 * It goes to GitHub, for every API read (trees, Actions runs, history), and to the history server
 * with an upload or a git fetch, and nowhere else: never into a share link. Signing out forgets
 * it in every tab.
 */

import { HISTORY_URL } from './history';

const KEY = 'repo-tree:github-signin';
/** For a page whose storage is blocked. */
let held: string | null = null;

const session = (): Storage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** Where a sign-in was kept before it outlived its tab: read once, then moved to localStorage. */
function adoptTabSignIn(): void {
  try {
    const old = sessionStorage.getItem(KEY);
    if (old === null) return;
    sessionStorage.removeItem(KEY);
    if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, old);
  } catch {
    // Blocked storage held no token either.
  }
}
adoptTabSignIn();

/** The signed-in visitor's GitHub token, or null. */
export function signedInToken(
  storage: Pick<Storage, 'getItem'> | undefined = session(),
): string | null {
  try {
    return storage?.getItem(KEY) ?? held;
  } catch {
    return held;
  }
}

/** Told when this tab, or another tab of this browser, signs in or out. */
const changes = new EventTarget();
export function onAuthChange(listener: () => void): void {
  changes.addEventListener('change', listener);
}
try {
  addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) changes.dispatchEvent(new Event('change'));
  });
} catch {
  // No window (a test or a worker): no other tabs to hear from.
}

/**
 * The token for a read of GitHub's API: the one pasted in Settings, which the visitor chose
 * deliberately (and may reach private repos), else the signed-in one. Undefined for neither.
 */
export function githubToken(manual: string | undefined): string | undefined {
  return manual || signedInToken() || undefined;
}

export function signOut(storage: Pick<Storage, 'removeItem'> | undefined = session()): void {
  held = null;
  try {
    storage?.removeItem(KEY);
  } catch {
    // Blocked storage held no token either.
  }
  changes.dispatchEvent(new Event('change'));
}

/**
 * Opens GitHub's sign-in in a popup (call it from a click, or the browser blocks it) and resolves
 * with the token once the server's callback page posts it, or null when the visitor closes the
 * popup, declines, or the popup is blocked.
 */
export function signIn(
  base: string | undefined = HISTORY_URL,
  win: Window = window,
  storage: Pick<Storage, 'setItem'> | undefined = session(),
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
        held = token;
        try {
          storage?.setItem(KEY, token);
        } catch {
          // Signed in for this page only.
        }
        changes.dispatchEvent(new Event('change'));
      }
      finish(token);
    };
    win.addEventListener('message', onMessage);
    const closed = setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);
  });
}
