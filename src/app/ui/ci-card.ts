import { actionsUrl } from '../../repo/ci';
import { PALETTES } from '../../render/palette';
import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { weatherOf } from '../state';
import { describeWeather } from '../weather';

/**
 * What the sky stands for, shown when the sun or a cloud is tapped: the CI verdict, and a
 * warning before the link leaves for the repo's GitHub Actions runs.
 */
export function mountCiCard(app: App): { open(): boolean } {
  const { store } = app;
  const card = byId('ci-card');
  const scrim = byId('ci-scrim');
  let opener: Element | null = null;

  const close = () => {
    card.hidden = scrim.hidden = true;
    (opener as HTMLElement | null)?.focus?.();
    opener = null;
  };
  // A fresh press closes it: the click that ends the tap opening it lands on the scrim too.
  scrim.addEventListener('pointerdown', close);
  // Escape closes it wherever focus is: a tap on the sky can leave focus outside the card.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || card.hidden) return;
      event.stopPropagation();
      close();
    },
    true,
  );

  const open = () => {
    const state = store.get();
    const weather = weatherOf(state);
    if (!weather || !state.repo) return false;
    const { sky, health } = weather;
    const { ref, branch } = state.repo.info;
    const { verdict, detail } = describeWeather(sky, health, Date.now());
    const snow = PALETTES[state.settings.palette].precip === 'snow';
    const glyph = snow && (sky === 'rain' || sky === 'storm') ? 'snow' : sky;
    const name = `${ref.owner}/${ref.repo}`;
    const done = h(
      'button',
      { type: 'button', class: 'btn', onclick: close },
      health ? 'Not now' : 'OK',
    );
    card.dataset.sky = sky;
    card.replaceChildren(
      h(
        'div',
        { class: 'ci-head' },
        h('span', { class: 'ci-glyph', 'aria-hidden': 'true' }, icon(...ICONS[glyph])),
        h('h2', { id: 'ci-title' }, verdict),
      ),
      h(
        'p',
        {},
        health
          ? `The sun and clouds over the tree show ${name}’s GitHub Actions runs on ${branch}${
              health.runs ? `: ${detail}` : ', which has none finished yet'
            }.`
          : `This sky is a preview from the link (${detail}), not ${name}’s CI.`,
      ),
      health
        ? h('p', { class: 'compute-fine' }, 'Opening the runs takes you to GitHub in a new tab.')
        : '',
      h(
        'div',
        { class: 'actions' },
        health
          ? h(
              'a',
              {
                class: 'btn dark',
                href: actionsUrl(ref, branch),
                target: '_blank',
                rel: 'noopener',
                onclick: close,
              },
              'Open GitHub Actions',
            )
          : '',
        done,
      ),
    );
    opener = document.activeElement;
    card.hidden = scrim.hidden = false;
    (card.querySelector<HTMLElement>('.btn.dark') ?? done).focus();
    return true;
  };

  store.subscribe((state, prev) => {
    if (!card.hidden && state.repo !== prev.repo) close();
  });

  return { open };
}
