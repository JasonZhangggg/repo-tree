import { HISTORY_URL } from '../../repo/history';
import { githubToken, onAuthChange, signIn, signOut, signedInToken } from '../../repo/auth';
import { fetchRateLimit, formatCount, resetsIn } from '../../repo/rate-limit';
import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';

/** The questions page: how to read the tree, and what Repo Tree uses GitHub for and can see. */
export const FAQ_URL = './faq.html#github';

/**
 * The GitHub button, last in the toolbar (its own box beside the repo card on a phone). Signing in
 * lifts GitHub's hourly limit from 60 requests per network address to 5,000 per visitor, for trees,
 * CI weather and history alike. The button opens the account menu either way: the requests left
 * this hour over a meter, then Sign in with GitHub or Sign out, and a link to the questions page's
 * GitHub section (Login Q&A). Hidden when this build has no history server, which is what signs
 * visitors in.
 */
export function mountSignIn(
  app: App,
  { refreshRuns, sign = signIn }: { refreshRuns: () => void; sign?: () => Promise<string | null> },
): { signIn(): Promise<void> } {
  const button = byId<HTMLButtonElement>('signin');
  const label = button.querySelector('.label')!;
  button.hidden = !HISTORY_URL;

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  const sync = () => {
    const inside = signedInToken() !== null;
    label.textContent = inside ? 'GitHub account' : 'Sign in';
    button.setAttribute('aria-label', inside ? 'GitHub account' : 'Sign in');
    button.title = inside ? 'Signed in with GitHub' : 'Sign in with GitHub';
    button.dataset.signedIn = String(inside);
    panel.dataset.signedIn = String(inside);
    who.textContent = inside ? 'Signed in' : 'Not signed in';
    signInButton.hidden = inside;
    signOutButton.hidden = !inside;
    // Open, the menu follows: signed in from it, it shows the account's own budget.
    if (!panel.hidden) readUsage();
  };

  const usage = h('span', { class: 'account-count', id: 'account-usage', 'aria-live': 'polite' });
  const fillBar = h('i');
  const meter = h('div', { class: 'account-meter', 'aria-hidden': 'true' }, fillBar);
  const resets = h('p', { class: 'account-reset', id: 'account-reset' });
  const mark = button.querySelector('svg')?.cloneNode(true) ?? icon(...ICONS.person);
  const who = h('small', {}, 'Signed in');
  const signInButton = h(
    'button',
    {
      type: 'button',
      class: 'btn dark account-signin',
      id: 'account-signin',
      onclick: () => void signInNow(),
    },
    'Sign in with GitHub',
  );
  const signOutButton = h(
    'button',
    {
      type: 'button',
      class: 'account-item',
      id: 'account-signout',
      onclick: () => {
        close();
        signOut();
        app.toast('Signed out of GitHub');
        button.focus();
      },
    },
    icon(...ICONS.signout),
    h('span', {}, 'Sign out'),
  );
  const panel = h(
    'div',
    {
      class: 'account',
      id: 'account',
      role: 'dialog',
      'aria-label': 'GitHub account',
      tabindex: '-1',
      hidden: true,
    },
    h(
      'div',
      { class: 'account-head' },
      h('span', { class: 'account-mark' }, mark),
      h('span', { class: 'account-who' }, h('strong', {}, 'GitHub'), who),
    ),
    h(
      'div',
      { class: 'account-usage' },
      h(
        'div',
        { class: 'account-row' },
        h('span', { class: 'account-label' }, 'Requests left'),
        usage,
      ),
      meter,
      resets,
    ),
    signInButton,
    h('div', { class: 'account-sep', role: 'separator' }),
    h(
      'a',
      {
        class: 'account-item',
        id: 'account-faq',
        href: FAQ_URL,
        target: '_blank',
        rel: 'noopener',
      },
      icon(...ICONS.help),
      h('span', {}, 'Login Q&A'),
      icon(...ICONS.external),
    ),
    signOutButton,
  );
  document.body.append(panel);

  let asking: AbortController | null = null;
  const readUsage = () => {
    asking?.abort();
    const ask = (asking = new AbortController());
    panel.dataset.usage = 'checking';
    usage.textContent = 'Checking…';
    resets.textContent = '';
    void fetchRateLimit(githubToken(app.store.get().settings.token), ask.signal).then((rate) => {
      if (ask !== asking) return;
      panel.dataset.usage = rate ? 'read' : 'failed';
      if (!rate) {
        usage.textContent = 'GitHub didn’t answer. Open this again to retry.';
        return;
      }
      usage.textContent = `${formatCount(rate.remaining)} of ${formatCount(rate.limit)}`;
      const share = rate.limit ? rate.remaining / rate.limit : 0;
      fillBar.style.width = `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`;
      panel.dataset.low = String(share < 0.1);
      const when = resetsIn(rate);
      resets.textContent = when[0]!.toUpperCase() + when.slice(1);
    });
  };

  /** Under the button, its right edge on the button's. */
  function open() {
    const at = button.getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 8)}px`;
    panel.style.right = `${Math.round(innerWidth - at.right)}px`;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    readUsage();
    panel.focus({ preventScroll: true });
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

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
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
