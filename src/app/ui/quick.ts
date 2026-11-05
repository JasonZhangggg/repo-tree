import { onAuthChange, signOut, signedInToken } from '../../repo/auth';
import { HISTORY_URL } from '../../repo/history';
import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';

const MOON = ['M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z'];
const GITHUB = [
  'M9 19c-4 1.5-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
];

/**
 * On a phone, the drawer opens on a row of quick switches: Dark mode, Spin and the GitHub
 * sign-in, which otherwise sit in Settings and the More menu. Each shows its state, and a tap
 * flips it in place.
 */
export function mountQuick(app: App): void {
  const { store } = app;
  const row = byId('quick');

  const chip = (label: string, paths: string[], onclick: () => void) =>
    h(
      'button',
      { type: 'button', class: 'quick-chip', 'aria-pressed': 'false', onclick },
      icon(...paths),
      h('span', {}, label),
    ) as HTMLButtonElement;

  const dark = chip('Dark mode', MOON, () =>
    store.dispatch({
      type: 'settings',
      patch: { theme: store.get().settings.theme === 'dark' ? 'light' : 'dark' },
    }),
  );
  const spin = chip('Spin', ICONS.play, () =>
    store.dispatch({ type: 'settings', patch: { spin: !store.get().settings.spin } }),
  );
  const github = chip('Sign in', GITHUB, () => {
    if (signedInToken() !== null) {
      signOut();
      app.toast('Signed out of GitHub');
    } else app.signIn();
  });
  github.removeAttribute('aria-pressed');
  github.hidden = !HISTORY_URL;
  row.replaceChildren(dark, spin, github);

  const sync = () => {
    const { theme, spin: spinning } = store.get().settings;
    dark.setAttribute('aria-pressed', String(theme === 'dark'));
    spin.setAttribute('aria-pressed', String(spinning));
    const inside = signedInToken() !== null;
    github.querySelector('span')!.textContent = inside ? 'Signed in' : 'Sign in';
    github.setAttribute(
      'aria-label',
      inside ? 'Signed in with GitHub: sign out' : 'Sign in with GitHub',
    );
    github.dataset.signedIn = String(inside);
  };
  store.subscribe((state, prev) => {
    if (state.settings !== prev.settings) sync();
  });
  onAuthChange(sync);
  sync();
}
