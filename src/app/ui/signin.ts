import { HISTORY_URL } from '../../repo/history';
import { githubToken, onAuthChange, signIn, signOut, signedInToken } from '../../repo/auth';
import { describeRateLimit, fetchRateLimit } from '../../repo/rate-limit';
import type { App } from '../app';
import { byId, h } from '../dom';

/** What signing in lets Repo Tree see, said in the account panel and in Settings. */
export const PRIVACY =
  'public data only: no private repos, never file contents. Your token stays in this tab and goes only to GitHub and the Repo Tree history server, which never stores it.';

/**
 * The Sign in with GitHub button, last in the toolbar (in the More menu on a phone). Signing in lifts
 * GitHub's hourly limit from 60 requests per network address to 5,000 per visitor, for trees, CI
 * weather and history alike. Signed in, the same button opens the account panel: the requests left
 * this hour, what Repo Tree can see, and Sign out. Hidden when this build has no history server,
 * which is what signs visitors in.
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
    label.textContent = inside ? 'GitHub account' : 'Sign in';
    button.setAttribute('aria-label', inside ? 'GitHub account' : 'Sign in with GitHub');
    button.title = inside
      ? 'Signed in with GitHub'
      : 'Sign in with GitHub: 5,000 requests an hour instead of 60. Public data only.';
    button.dataset.signedIn = String(inside);
    if (inside) button.setAttribute('aria-haspopup', 'dialog');
    else button.removeAttribute('aria-haspopup');
    if (!inside) close();
  };

  const usage = h('p', { class: 'account-usage', id: 'account-usage', 'aria-live': 'polite' });
  const seeing = h(
    'p',
    { class: 'note', id: 'account-privacy', hidden: true },
    PRIVACY[0]!.toUpperCase() + PRIVACY.slice(1),
  );
  const seeButton = h(
    'button',
    {
      type: 'button',
      class: 'btn',
      id: 'account-see',
      'aria-expanded': 'false',
      'aria-controls': 'account-privacy',
      onclick: () => {
        seeing.hidden = !seeing.hidden;
        seeButton.setAttribute('aria-expanded', String(!seeing.hidden));
      },
    },
    'What Repo Tree can see',
  );
  const panel = h(
    'div',
    {
      class: 'account',
      id: 'account',
      role: 'dialog',
      'aria-label': 'GitHub account',
      hidden: true,
    },
    h('p', { class: 'h' }, 'Signed in with GitHub'),
    h('p', { class: 'account-label' }, 'Requests this hour'),
    usage,
    seeButton,
    seeing,
    h(
      'button',
      {
        type: 'button',
        class: 'btn dark',
        id: 'account-signout',
        onclick: () => {
          signOut();
          app.toast('Signed out of GitHub');
          button.focus();
        },
      },
      'Sign out',
    ),
  );
  document.body.append(panel);

  let asking: AbortController | null = null;
  const readUsage = () => {
    asking?.abort();
    const ask = (asking = new AbortController());
    usage.textContent = 'Checking…';
    void fetchRateLimit(githubToken(app.store.get().settings.token), ask.signal).then((rate) => {
      if (ask !== asking) return;
      usage.textContent = rate
        ? describeRateLimit(rate)
        : 'GitHub didn’t answer. Open this again to retry.';
    });
  };

  /** Under the button on a desktop; on a phone, whose button sits in the More menu, over the bottom row. */
  function open() {
    const at = button.getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 8)}px`;
    panel.style.right = `${Math.round(innerWidth - at.right)}px`;
    seeing.hidden = true;
    seeButton.setAttribute('aria-expanded', 'false');
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    readUsage();
    panel.querySelector<HTMLElement>('#account-signout')?.focus({ preventScroll: true });
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    asking?.abort();
    asking = null;
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node;
      if (!panel.hidden && !panel.contains(target) && !button.contains(target)) close();
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || panel.hidden) return;
      event.stopPropagation();
      close();
      button.focus();
    },
    true,
  );

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
    if (signedInToken() === null) void signInNow();
    else if (panel.hidden) open();
    else close();
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
