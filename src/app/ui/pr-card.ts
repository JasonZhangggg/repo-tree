import type { App } from '../app';
import { githubToken } from '../../repo/auth';
import { birdsOf, pullsOf } from '../birds';
import { byId, h, icon, ICONS } from '../dom';
import { ago, plural } from '../format';

/**
 * What a bird stands for, shown when it is clicked or tapped: its pull request, where it
 * perches, the other PRs on the same branch, and a warning before the link leaves for GitHub.
 */
export function mountPrCard(app: App): { open(bird: number): boolean } {
  const { store } = app;
  const card = byId('pr-card');
  const scrim = byId('pr-scrim');
  let opener: Element | null = null;

  const close = () => {
    card.hidden = scrim.hidden = true;
    (opener as HTMLElement | null)?.focus?.();
    opener = null;
  };
  scrim.addEventListener('pointerdown', close);
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || card.hidden) return;
      event.stopPropagation();
      close();
    },
    true,
  );

  const open = (index: number) => {
    const state = store.get();
    const birds = birdsOf(state);
    const bird = birds?.[index];
    if (!bird || !state.repo) return false;
    const { pull, folder, color } = bird;
    const { total } = pullsOf(state)!;
    const shown = birds!.length;
    const { branch } = state.repo.info;
    const signedIn = !!githubToken(state.settings.token);
    const path = state.repo.tree.folders.path[folder]!;
    const where = path ? h('code', {}, `${path}/`) : 'the top of the repo';
    const mates = birds!.filter((b) => b.folder === folder && b !== bird);
    const done = h('button', { type: 'button', class: 'btn', onclick: close }, 'Not now');
    card.style.setProperty('--bird', color);
    card.replaceChildren(
      h(
        'div',
        { class: 'ci-head' },
        h('span', { class: 'ci-glyph pr-glyph', 'aria-hidden': 'true' }, icon(...ICONS.bird)),
        h('h2', { id: 'pr-title' }, pull.title),
      ),
      h(
        'p',
        { class: 'pr-meta' },
        `#${pull.number} by ${pull.author}${pull.draft ? ' · draft' : ''} · updated ${ago(pull.updatedAt, Date.now())}`,
      ),
      h(
        'p',
        {},
        `Changes ${plural(pull.files.length, 'file')}${pull.files.length >= 100 ? ' or more' : ''}, `,
        path ? 'most in ' : 'mostly at ',
        where,
        '.',
      ),
      mates.length
        ? h(
            'p',
            { class: 'compute-note' },
            `Also perched here: ${mates.map((m) => `#${m.pull.number}`).join(', ')}. PRs that change the same folder may conflict.`,
          )
        : '',
      h(
        'p',
        { class: 'compute-fine' },
        shown < total
          ? `The tree shows ${shown} of ${total} open pull requests into ${branch}, the most recently updated.${signedIn ? '' : ' Sign in to see more.'} `
          : '',
        'Opens GitHub in a new tab.',
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'a',
          {
            class: 'btn dark',
            href: pull.url,
            target: '_blank',
            rel: 'noopener',
            onclick: close,
          },
          'Open pull request',
        ),
        done,
      ),
    );
    opener = document.activeElement;
    card.hidden = scrim.hidden = false;
    card.querySelector<HTMLElement>('.btn.dark')!.focus();
    return true;
  };

  store.subscribe((state, prev) => {
    if (!card.hidden && (state.repo !== prev.repo || birdsOf(state) !== birdsOf(prev))) close();
  });

  return { open };
}
