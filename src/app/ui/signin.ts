import { HISTORY_URL } from '../../repo/history';
import { onAuthChange, signIn, signOut, signedInToken } from '../../repo/auth';
import type { App } from '../app';
import { byId } from '../dom';

/**
 * The Sign in with GitHub button, beside Settings (in the More menu on a phone). Signing in lifts
 * GitHub's hourly limit from 60 requests per network address to 5,000 per visitor, for trees, CI
 * weather and history alike; signed in, the same button signs out. Hidden when this build has no
 * history server, which is what signs visitors in.
 */
export function mountSignIn(
  app: App,
  { refreshRuns, sign = signIn }: { refreshRuns: () => void; sign?: () => Promise<string | null> },
): { signIn(): Promise<void> } {
  const button = byId<HTMLButtonElement>('signin');
  const label = button.querySelector('.label')!;
  button.hidden = !HISTORY_URL;

  const sync = () => {
    const inside = signedInToken() !== null;
    // Short on a desktop's toolbar; the phone's menu has room to say what it is.
    label.textContent = inside ? 'Sign out' : 'Sign in';
    button.setAttribute('aria-label', inside ? 'Sign out of GitHub' : 'Sign in with GitHub');
    button.title = inside
      ? 'Signed in with GitHub: 5,000 requests an hour. Click to sign out.'
      : 'Sign in with GitHub: 5,000 requests an hour instead of 60. Public data only: no private repos, never file contents.';
    button.dataset.signedIn = String(inside);
  };

  /** Signs in, then reads again what the old limit may have cost: the tree, or its weather. */
  async function signInNow() {
    const token = await sign();
    if (!token) return;
    app.toast('Signed in with GitHub');
    const { load } = app.store.get();
    if (load.phase === 'error') app.load(load.ref);
    else refreshRuns();
  }

  button.addEventListener('click', () => {
    if (signedInToken() !== null) {
      signOut();
      app.toast('Signed out of GitHub');
    } else {
      void signInNow();
    }
  });
  // A sign-in token GitHub refuses has expired: forget it, so the next read goes without.
  app.store.subscribe((state, prev) => {
    if (
      state.load !== prev.load &&
      state.load.phase === 'error' &&
      state.load.error.kind === 'unauthorized' &&
      !state.settings.token
    ) {
      signOut();
    }
  });
  onAuthChange(sync);
  sync();
  return { signIn: signInNow };
}
