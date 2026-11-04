import type { LoadStep } from '../../load/load-in-worker';
import { actionsUrl } from '../../repo/ci';
import { parseRepoRef } from '../../repo/ref';
import { PALETTES } from '../../render/palette';
import { githubUrl, type App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { describeError, type ErrorAction } from '../errors';
import { compact, count, plural } from '../format';
import { readRecent } from '../recent';
import { SAMPLES } from '../samples';
import { weatherOf, type AppState } from '../state';
import { describeWeather } from '../weather';

const STEPS: { step: LoadStep; label: string }[] = [
  { step: 'fetch', label: 'Fetching' },
  { step: 'build', label: 'Sorting' },
  { step: 'grow', label: 'Growing' },
];

export function mountHeader(app: App): void {
  const { store } = app;
  const form = byId<HTMLFormElement>('repo-form');
  const input = byId<HTMLInputElement>('repo-input');
  const error = byId('repo-error');
  const suggest = byId('suggest');
  const link = byId<HTMLAnchorElement>('repo-link');
  const meta = byId('repo-meta');
  const status = byId('status');
  const samples = byId('samples');
  const weatherChip = byId<HTMLAnchorElement>('weather');

  const setInvalid = (message: string) => {
    error.textContent = message;
    input.setAttribute('aria-invalid', String(!!message));
    form.toggleAttribute('data-invalid', !!message);
  };

  const closeSuggest = () => {
    suggest.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  const choose = (name: string) => {
    const ref = parseRepoRef(name);
    if ('kind' in ref) return;
    input.value = '';
    setInvalid('');
    closeSuggest();
    input.blur();
    app.load(ref);
  };

  const openSuggest = () => {
    const recent = readRecent();
    const row = (label: string, glyph: string[], note?: string) =>
      h(
        'button',
        { type: 'button', onclick: () => choose(label) },
        icon(...glyph),
        h('span', {}, label),
        note && h('small', {}, note),
      );
    suggest.replaceChildren(
      ...(recent.length
        ? [h('p', { class: 'h' }, 'Recent'), ...recent.map((r) => row(r, ICONS.history))]
        : []),
      h('p', { class: 'h' }, 'Bundled samples'),
      ...SAMPLES.map((s) => row(`${s.owner}/${s.repo}`, ICONS.sample, `${compact(s.files)} files`)),
    );
    suggest.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    // An empty Grow is a request to pick one, so offer the list instead of scolding.
    if (!text) {
      input.focus();
      return openSuggest();
    }
    const ref = parseRepoRef(text);
    if ('kind' in ref)
      return setInvalid('Use owner/repo, like vitejs/vite, or paste a GitHub URL.');
    input.value = '';
    closeSuggest();
    input.blur();
    app.load(ref);
  });
  input.addEventListener('input', () => setInvalid(''));
  // The hint is about what was typed, so it goes when the field does.
  input.addEventListener('blur', () => {
    if (!input.value.trim()) setInvalid('');
  });
  input.addEventListener('focus', openSuggest);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !suggest.hidden) {
      event.preventDefault();
      suggest.querySelector('button')?.focus();
    }
    if (event.key === 'Escape') {
      closeSuggest();
      setInvalid('');
      input.blur();
    }
  });
  suggest.addEventListener('keydown', (event) => {
    const items = [...suggest.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = at + (event.key === 'ArrowDown' ? 1 : -1);
      (next < 0 ? input : items[Math.min(next, items.length - 1)]!).focus();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeSuggest();
      input.focus();
    }
  });
  // A tap on a suggestion must reach its click. iOS Safari doesn't focus a tapped button, so
  // the input blurs with no related target and the list would close before the click lands.
  // A press inside the list keeps the input focused and holds the list open until it ends.
  let pressing = false;
  suggest.addEventListener('pointerdown', () => (pressing = true));
  suggest.addEventListener('mousedown', (event) => event.preventDefault());
  const release = () => {
    if (!pressing) return;
    pressing = false;
    // iOS sends the click after pointerup and touchend, so check a moment later whether
    // focus really left before closing.
    setTimeout(() => {
      if (!form.contains(document.activeElement)) closeSuggest();
    }, 400);
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  form.addEventListener('focusout', (event) => {
    if (pressing) return;
    if (!form.contains(event.relatedTarget as Node | null)) closeSuggest();
  });

  samples.replaceChildren(
    ...SAMPLES.map((s) =>
      h(
        'button',
        {
          type: 'button',
          'data-sample': s.id,
          'aria-pressed': 'false',
          onclick: () => choose(`${s.owner}/${s.repo}`),
        },
        s.label,
        h('small', {}, compact(s.files)),
      ),
    ),
  );

  const runAction = (action: ErrorAction, state: AppState) => {
    if (action === 'retry' && state.load.phase === 'error') app.load(state.load.ref);
    if (action === 'token') app.openSettings('token');
    if (action === 'settings') app.openSettings('hidden');
  };
  const ACTION_LABEL: Record<ErrorAction, string> = {
    retry: 'Try again',
    token: 'Add a token',
    settings: 'Hidden folders',
  };

  let loadingId: number | null = null;
  const renderStatus = (state: AppState) => {
    const { load, repo, notice } = state;
    if (load.phase === 'loading') {
      if (loadingId !== load.id) {
        loadingId = load.id;
        status.replaceChildren(
          h(
            'div',
            { class: 'status loading' },
            h(
              'div',
              { class: 'status-head' },
              h(
                'div',
                {},
                h('strong', {}, `Growing ${load.ref.owner}/${load.ref.repo}`),
                h(
                  'ol',
                  { class: 'steps', 'aria-label': 'Progress' },
                  ...STEPS.map((s) => h('li', { 'data-step': s.step }, h('i'), s.label)),
                ),
              ),
              h(
                'button',
                { type: 'button', class: 'btn', onclick: () => app.cancelLoad() },
                'Cancel',
              ),
            ),
            h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i')),
          ),
        );
      }
      const at = STEPS.findIndex((s) => s.step === load.step);
      status.querySelectorAll<HTMLElement>('.steps li').forEach((li, i) => {
        li.dataset.state = i < at ? 'done' : i === at ? 'now' : 'todo';
      });
      status
        .querySelector<HTMLElement>('.progress')!
        .style.setProperty('--done', String((at + 0.6) / STEPS.length));
      return;
    }
    loadingId = null;
    if (load.phase === 'error') {
      const copy = describeError(load.error, load.ref, !!state.settings.token);
      status.replaceChildren(
        h(
          'div',
          { class: 'status error', role: 'alert' },
          h(
            'div',
            { class: 'status-head' },
            h(
              'span',
              { class: 'badge' },
              icon(...(load.error.kind === 'rate-limited' ? ICONS.clock : ICONS.alert)),
            ),
            h('div', {}, h('strong', {}, copy.title), h('p', {}, copy.body)),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn',
                'aria-label': 'Dismiss',
                onclick: () => store.dispatch({ type: 'dismiss-error' }),
              },
              icon(...ICONS.close),
            ),
          ),
          h(
            'div',
            { class: 'actions' },
            ...copy.actions.map((action, i) =>
              h(
                'button',
                {
                  type: 'button',
                  class: i === 0 ? 'btn dark' : 'btn',
                  onclick: () => runAction(action, store.get()),
                },
                ACTION_LABEL[action],
              ),
            ),
          ),
        ),
      );
      return;
    }
    if (notice === 'truncated' && repo) {
      status.replaceChildren(
        h(
          'div',
          { class: 'status notice', role: 'status' },
          h(
            'div',
            { class: 'status-head' },
            h('span', { class: 'badge' }, icon(...ICONS.alert)),
            h(
              'div',
              {},
              h('strong', {}, 'Showing part of this repository'),
              h(
                'p',
                {},
                `GitHub cut the file list short at ${count(repo.info.files)} files, so some folders are missing from the tree.`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn',
                'aria-label': 'Dismiss',
                onclick: () => store.dispatch({ type: 'dismiss-notice' }),
              },
              icon(...ICONS.close),
            ),
          ),
        ),
      );
      return;
    }
    status.replaceChildren();
  };

  const renderTitle = (state: AppState) => {
    const { repo, load } = state;
    const shownRef = repo?.info.ref ?? (load.phase === 'idle' ? null : load.ref);
    if (!shownRef) return;
    link.replaceChildren(
      h('span', {}, `${shownRef.owner}/${shownRef.repo}`),
      icon(...ICONS.external),
    );
    if (!repo) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      fill(meta);
      return;
    }
    link.removeAttribute('aria-disabled');
    link.href = githubUrl(repo.info.ref);
    link.title = 'Open on GitHub';
    const { folders } = repo.index;
    const langs = repo.index.langs.filter((l) => l !== 'Other').length;
    const dot = (cls = 'dot') => h('span', { class: cls, 'aria-hidden': 'true' }, '·');
    fill(
      meta,
      h('span', { class: 'branch', title: 'Branch' }, icon(...ICONS.branch), repo.info.branch),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': 'Reload from GitHub',
          title: 'Reload from GitHub, skipping the cache',
          // The ref as it was asked for: pinning the branch here would make the reload a
          // branch link, which reads history but is never offered to compute one.
          onclick: () => app.load(repo.info.ref, { fresh: true }),
        },
        icon(...ICONS.reload),
      ),
      repo.sample
        ? h(
            'span',
            { class: 'opt', title: 'Bundled with the app. Reload for the live tree.' },
            'snapshot',
          )
        : null,
      repo.sample ? dot('dot opt') : null,
      h('span', {}, plural(folders.files[0]!, 'file')),
      dot('dot opt'),
      h('span', { class: 'opt' }, plural(folders.files.length - 1, 'folder')),
      dot('dot opt'),
      h('span', { class: 'opt' }, plural(langs, 'language')),
    );
    for (const button of samples.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.sample === repo.sample));
    }
  };

  /** The weather chip under the title: what the sky stands for, linking to the Actions runs. */
  const renderWeather = (state: AppState) => {
    const weather = weatherOf(state);
    if (!weather || !state.repo) {
      weatherChip.hidden = true;
      return;
    }
    const { sky, health } = weather;
    const { ref, branch } = state.repo.info;
    const { verdict, detail } = describeWeather(sky, health, Date.now());
    const snow = PALETTES[state.settings.palette].precip === 'snow';
    const glyph = snow && (sky === 'rain' || sky === 'storm') ? 'snow' : sky;
    weatherChip.hidden = false;
    weatherChip.dataset.sky = sky;
    if (health) weatherChip.href = actionsUrl(ref, branch);
    else weatherChip.removeAttribute('href');
    weatherChip.title = !health
      ? 'A weather preview from the link, not this repository’s CI'
      : health.runs
        ? `Weather from the last ${plural(health.runs, 'finished GitHub Actions run')} on ${branch}`
        : `No finished GitHub Actions runs on ${branch}`;
    weatherChip.setAttribute('aria-label', detail ? `${verdict}, ${detail}` : verdict);
    fill(
      weatherChip,
      icon(...ICONS[glyph]),
      h('strong', {}, verdict),
      detail && h('span', {}, detail),
    );
  };

  const render = (state: AppState, prev?: AppState) => {
    if (!prev || state.load !== prev.load || state.repo !== prev.repo) renderTitle(state);
    if (
      !prev ||
      state.repo !== prev.repo ||
      state.ci !== prev.ci ||
      state.preview !== prev.preview ||
      state.settings.weather !== prev.settings.weather ||
      state.settings.palette !== prev.settings.palette
    ) {
      renderWeather(state);
    }
    if (
      !prev ||
      state.load !== prev.load ||
      state.notice !== prev.notice ||
      state.settings.token !== prev.settings.token
    ) {
      renderStatus(state);
    }
  };
  store.subscribe(render);
  render(store.get());
}
