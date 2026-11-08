import { fetchAccount, signIn, type Account } from '../../repo/auth';
import { closeButton, fill, h, icon, ICONS } from '../dom';

const FAQ_URL = './faq.html#what-can-it-see';
const REVOKE_URL = 'https://github.com/settings/applications';

type Step =
  | { kind: 'ask' }
  | { kind: 'waiting' }
  | { kind: 'failed' }
  | { kind: 'done'; account: Account | null };

/**
 * The screen every sign-in goes through. GitHub shows its own authorize screen only the first
 * time: once a visitor has approved the OAuth App, and is signed in to github.com, the popup
 * goes straight back and closes, and GitHub has no parameter to show the screen again. So this
 * says what signing in grants and what it doesn't, and its Authorize button opens the popup
 * (from the click, so no popup blocker stops it). Afterwards it says which account signed in.
 *
 * `ask` resolves with the token once the visitor has seen the confirmation and closed it, or
 * null when they decline or the sign-in doesn't finish.
 */
export function mountConsent(sign: () => Promise<string | null> = signIn): {
  ask(): Promise<string | null>;
  close(): boolean;
} {
  const scrim = h('div', { class: 'scrim', id: 'consent-scrim', hidden: true });
  const dialog = h('div', {
    class: 'dialog compute consent',
    id: 'consent',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'consent-title',
    hidden: true,
  });
  document.body.append(scrim, dialog);

  let current: { step: Step; token: string | null; done: (t: string | null) => void } | null = null;
  let back: HTMLElement | null = null;

  const item = (can: boolean, text: string) =>
    h(
      'li',
      { class: can ? 'consent-can' : 'consent-cannot' },
      icon(...(can ? ICONS.check : ICONS.close)),
      h('span', {}, text),
    );

  const render = () => {
    if (!current) return;
    const { step } = current;
    dialog.dataset.step = step.kind;
    const actions = (label: string, onclick: () => void) =>
      h(
        'div',
        { class: 'compute-actions' },
        h('button', { type: 'button', class: 'btn dark', onclick }, label),
      );
    if (step.kind === 'ask' || step.kind === 'failed') {
      fill(
        dialog,
        h(
          'div',
          { class: 'consent-head' },
          h('span', { class: 'consent-mark' }, icon(...ICONS.person)),
          h(
            'h2',
            { id: 'consent-title' },
            step.kind === 'ask' ? 'Sign in with GitHub' : 'Sign-in didn’t finish',
          ),
        ),
        step.kind === 'failed' &&
          h(
            'p',
            { class: 'compute-note', role: 'alert' },
            'The GitHub window closed before GitHub said yes, or the browser blocked it. Try again, and allow pop-ups for this site if it asks.',
          ),
        h('p', {}, 'Repo Tree asks GitHub for no permissions. Signing in lets it:'),
        h(
          'ul',
          { class: 'consent-list', 'aria-label': 'Repo Tree can' },
          item(true, 'Read public repositories with your own 5,000 requests an hour'),
          item(true, 'See your public username, to show who is signed in'),
        ),
        h('p', {}, 'It can’t:'),
        h(
          'ul',
          { class: 'consent-list', 'aria-label': 'Repo Tree can’t' },
          item(false, 'See your private repositories, email or settings'),
          item(false, 'Change anything on GitHub'),
        ),
        h(
          'p',
          { class: 'compute-fine' },
          'GitHub opens in a small window. If you’ve authorized Repo Tree before, GitHub skips its own screen and the window closes by itself. ',
          h('a', { href: FAQ_URL, target: '_blank', rel: 'noopener' }, 'More about sign-in'),
        ),
        actions(step.kind === 'ask' ? 'Authorize with GitHub' : 'Try again', () => void go()),
        closeButton('Not now', () => finish()),
      );
    } else if (step.kind === 'waiting') {
      fill(
        dialog,
        h(
          'div',
          { class: 'consent-head' },
          h('span', { class: 'consent-mark' }, icon(...ICONS.person)),
          h('h2', { id: 'consent-title' }, 'Waiting for GitHub…'),
        ),
        h(
          'p',
          { 'aria-live': 'polite' },
          'Finish in the GitHub window. It closes by itself once GitHub says yes.',
        ),
      );
    } else {
      const { account } = step;
      const avatar =
        account?.avatar &&
        h('img', {
          src: `${account.avatar}${account.avatar.includes('?') ? '&' : '?'}s=80`,
          alt: '',
          width: 40,
          height: 40,
          onerror: (event: Event) => (event.target as HTMLElement).remove(),
        });
      fill(
        dialog,
        h(
          'div',
          { class: 'consent-head' },
          h('span', { class: 'consent-mark consent-done' }, icon(...ICONS.check), avatar || null),
          h(
            'h2',
            { id: 'consent-title' },
            account ? `Signed in as @${account.login}` : 'Signed in with GitHub',
          ),
        ),
        h(
          'p',
          { role: 'status' },
          'Repo Tree now reads GitHub with your own 5,000 requests an hour. It still sees public data only.',
        ),
        h(
          'p',
          { class: 'compute-fine' },
          'Sign out any time from the GitHub button. To remove Repo Tree from your account, revoke it on GitHub under ',
          h('a', { href: REVOKE_URL, target: '_blank', rel: 'noopener' }, 'Settings, Applications'),
          '.',
        ),
        actions('Done', () => finish()),
      );
    }
    dialog.querySelector<HTMLElement>('.compute-actions button, .close')?.focus();
  };

  async function go() {
    if (!current) return;
    const asking = current;
    asking.step = { kind: 'waiting' };
    render();
    const token = await sign();
    if (current !== asking) return;
    if (!token) {
      asking.step = { kind: 'failed' };
      return render();
    }
    asking.token = token;
    const account = await fetchAccount(token);
    if (current !== asking) return;
    asking.step = { kind: 'done', account };
    render();
  }

  function finish() {
    const was = current;
    if (!was) return;
    current = null;
    dialog.hidden = true;
    scrim.hidden = true;
    delete dialog.dataset.step;
    was.done(was.token);
    if (back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }

  scrim.addEventListener('click', () => {
    if (current && current.step.kind !== 'waiting') finish();
  });

  return {
    ask() {
      if (current) finish();
      back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return new Promise((done) => {
        current = { step: { kind: 'ask' }, token: null, done };
        dialog.hidden = false;
        scrim.hidden = false;
        render();
      });
    },
    close() {
      if (!current) return false;
      // The popup is open: it ends by itself, signed in or not.
      if (current.step.kind !== 'waiting') finish();
      return true;
    },
  };
}
