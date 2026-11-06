import type { LoadStep } from '../../load/load-in-worker';
import { actionsUrl } from '../../repo/ci';
import { parseRepoRef, type RepoRef } from '../../repo/ref';
import { PALETTES } from '../../render/palette';
import { githubUrl, type App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { githubToken, signedInToken } from '../../repo/auth';
import { HISTORY_URL } from '../../repo/history';
import { describeError, type ErrorAction } from '../errors';
import { compact, count, plural } from '../format';
import { readRecent } from '../recent';
import { SAMPLES } from '../samples';
import { partnerChoices } from '../compare';
import { ciFailed, ciOf, MAX_COMPARED, sameRef, type AppState } from '../state';
import type { Loaded } from '../../load/load-in-worker';
import { describeWeather, shortVerdict } from '../weather';

const plainOf = (ref: { owner: string; repo: string }) =>
  ({ owner: ref.owner, repo: ref.repo }) as RepoRef;

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
  const title = byId('title');
  const link = byId<HTMLButtonElement>('repo-link');
  const meta = byId('repo-meta');
  const status = byId('status');
  const alerts = byId('alerts');
  const notices = byId('notices');
  const weatherChip = byId<HTMLAnchorElement>('weather');
  const switcher = byId<HTMLButtonElement>('repo-switch');

  /**
   * The repo field folds into the repo card, and the card's GitHub mark or the repo's name opens
   * it there, in the card's place.
   */
  const setOpen = (open: boolean) => {
    document.body.toggleAttribute('data-repo-open', open);
    switcher.setAttribute('aria-expanded', String(open));
    link.setAttribute('aria-expanded', String(open));
  };
  const openField = () => {
    setOpen(true);
    input.focus();
  };
  switcher.addEventListener('click', openField);
  // The name opens the field too; the branch chip and the GitHub button are the ways to GitHub.
  link.addEventListener('click', openField);

  const setInvalid = (message: string) => {
    error.textContent = message;
    input.setAttribute('aria-invalid', String(!!message));
    form.toggleAttribute('data-invalid', !!message);
    // The hint takes the list's place under the field rather than covering it.
    if (message) closeSuggest();
  };

  const closeSuggest = () => {
    suggest.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  /**
   * The field grows a repo in place of the one on show, unless the repo card's "Compare with
   * another repo" asked it to add one beside instead: then a Compare tag shows in the field until
   * it picks one or loses focus. There is no Grow button: a pick from the list grows at once,
   * and Enter takes what is typed.
   */
  const mode = byId('repo-mode');
  const adding = () => form.hasAttribute('data-adding');
  const setAdding = (on: boolean) => {
    if (on === adding()) return;
    form.toggleAttribute('data-adding', on);
    mode.hidden = !on;
    const repo = store.get().repo;
    input.placeholder =
      on && repo
        ? `Compare ${repo.info.ref.owner}/${repo.info.ref.repo} with…`
        : 'owner/repo or GitHub URL';
  };
  form.addEventListener('repo-add', () => {
    setInvalid('');
    setAdding(true);
    openField();
  });

  /** Grows the repo, or in adding mode puts it beside the others; false when it can't be added. */
  const take = (ref: RepoRef): boolean => {
    if (!adding()) {
      app.load(ref);
      return true;
    }
    const { repo, compare } = store.get();
    const plainRef = { owner: ref.owner, repo: ref.repo } as RepoRef;
    if (
      (repo && sameRef(plainRef, plainOf(repo.info.ref))) ||
      compare.some((r) => sameRef(r, plainRef))
    ) {
      setInvalid('That one is already in the comparison. Pick another.');
      return false;
    }
    if (compare.length + 1 >= MAX_COMPARED) {
      setInvalid(`${MAX_COMPARED} repos is the most at once. Remove one to add another.`);
      return false;
    }
    store.dispatch({ type: 'compare', refs: [...compare, plainRef] });
    return true;
  };

  const choose = (name: string) => {
    const ref = parseRepoRef(name);
    if ('kind' in ref) return;
    if (!take(ref)) return;
    input.value = '';
    setInvalid('');
    closeSuggest();
    setAdding(false);
    input.blur();
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
    const sampleRow = (ref: { owner: string; repo: string }) => {
      const sample = SAMPLES.find((s) => sameRef(plainOf(s), plainOf(ref)))!;
      return row(`${ref.owner}/${ref.repo}`, ICONS.sample, `${compact(sample.files)} files`);
    };
    if (adding()) {
      // Only repos not already compared.
      const { repo, compare } = store.get();
      const taken = [...(repo ? [plainOf(repo.info.ref)] : []), ...compare];
      const choices = partnerChoices(taken, recent);
      suggest.replaceChildren(
        ...(choices.recent.length
          ? [
              h('p', { class: 'h' }, 'Recent'),
              ...choices.recent.map((r) => row(`${r.owner}/${r.repo}`, ICONS.history)),
            ]
          : []),
        ...(choices.samples.length
          ? [h('p', { class: 'h' }, 'Bundled samples'), ...choices.samples.map(sampleRow)]
          : []),
      );
    } else {
      suggest.replaceChildren(
        ...(recent.length
          ? [h('p', { class: 'h' }, 'Recent'), ...recent.map((r) => row(r, ICONS.history))]
          : []),
        h('p', { class: 'h' }, 'Bundled samples'),
        ...SAMPLES.map(sampleRow),
      );
    }
    suggest.hidden = !suggest.childElementCount;
    input.setAttribute('aria-expanded', String(!suggest.hidden));
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    // An empty Enter is a request to pick one, so offer the list instead of scolding.
    if (!text) {
      input.focus();
      return openSuggest();
    }
    const ref = parseRepoRef(text);
    if ('kind' in ref)
      return setInvalid('Use owner/repo, like vitejs/vite, or paste a GitHub URL.');
    if (!take(ref)) return;
    input.value = '';
    closeSuggest();
    setAdding(false);
    input.blur();
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
      setAdding(false);
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
      if (form.contains(document.activeElement)) return;
      closeSuggest();
      setAdding(false);
      setOpen(false);
    }, 400);
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  // iOS Safari keeps a field focused when the tap lands on something that can't take focus, like
  // the tree's canvas, so no focusout comes. A press anywhere outside closes the field itself.
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Element;
      if (target.closest('#repo-form, #repo-switch, #repo-link')) return;
      if (!document.body.hasAttribute('data-repo-open') && suggest.hidden) return;
      if (form.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      closeSuggest();
      setAdding(false);
      setOpen(false);
    },
    true,
  );
  form.addEventListener('focusout', (event) => {
    if (pressing) return;
    if (form.contains(event.relatedTarget as Node | null)) return;
    closeSuggest();
    // Clicking out takes the field back to growing in place.
    if (!input.value.trim()) setInvalid('');
    setAdding(false);
    setOpen(false);
  });

  const runAction = (action: ErrorAction, state: AppState) => {
    if (action === 'retry' && state.load.phase === 'error') app.load(state.load.ref);
    if (action === 'signin') app.signIn();
    if (action === 'token') app.openSettings('token');
    if (action === 'settings') app.openSettings('hidden');
  };
  const ACTION_LABEL: Record<ErrorAction, string> = {
    signin: 'Sign in with GitHub',
    retry: 'Try again',
    token: 'Add a token',
    settings: 'Hidden folders',
  };

  let loadingId: number | null = null;
  const renderStatus = (state: AppState) => {
    const { load, repo, notice } = state;
    if (load.phase === 'loading') {
      notices.replaceChildren();
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
    status.replaceChildren();
    if (load.phase === 'error') {
      const copy = describeError(load.error, load.ref, {
        hasToken: !!githubToken(state.settings.token),
        signedIn: !state.settings.token && signedInToken() !== null,
        canSignIn: !!HISTORY_URL,
      });
      notices.replaceChildren(
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
      notices.replaceChildren(
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
              h('strong', {}, 'Partial tree'),
              h(
                'p',
                {},
                `GitHub stopped at ${count(repo.info.files)} files, so some folders are missing.`,
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
    notices.replaceChildren();
  };

  const renderTitle = (state: AppState) => {
    const { repo, load } = state;
    const shownRef = repo?.info.ref ?? (load.phase === 'idle' ? null : load.ref);
    if (!shownRef) return;
    title.dataset.repo = `${shownRef.owner}/${shownRef.repo}`;
    link.replaceChildren(
      h('span', {}, `${shownRef.owner}/${shownRef.repo}`),
      icon(...ICONS.chevron),
    );
    link.title = 'Change repository';
    title.toggleAttribute('data-loading', !repo);
    if (!repo) {
      fill(meta);
      return;
    }
    byId<HTMLAnchorElement>('open-github').href = githubUrl(repo.info.ref);
    fill(meta, ...repoMeta(repo, () => app.load(repo.info.ref, { fresh: true })));
  };

  /** The weather chip under the title: what the sky stands for, linking to the Actions runs. */
  const renderWeather = (state: AppState) => paintWeather(weatherChip, state, state.repo);

  const render = (state: AppState, prev?: AppState) => {
    if (!prev || state.load !== prev.load || state.repo !== prev.repo) renderTitle(state);
    if (
      !prev ||
      state.repo !== prev.repo ||
      state.ci !== prev.ci ||
      state.preview !== prev.preview ||
      state.compare !== prev.compare ||
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
  placeAlerts(alerts);
  document.body.toggleAttribute('data-shell', true);
  const retry = (event: Event) => {
    if (weatherChip.dataset.sky !== 'unknown') return;
    event.preventDefault();
    app.refreshRuns();
  };
  weatherChip.addEventListener('click', retry);
  weatherChip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') retry(event);
  });
  render(store.get());
}

/**
 * The repo card's second line: the branch (a link to it), reload, whether it is a bundled
 * snapshot, its files, folders and languages, and a link to GitHub. Each card has one, alike.
 */
export function repoMeta(repo: Loaded & { sample?: string }, reload: () => void): (Node | null)[] {
  const { folders } = repo.index;
  const langs = repo.index.langs.filter((l) => l !== 'Other').length;
  // Not `.dot`: that class is the label anchors' dot, absolutely placed.
  const sep = (cls = 'sep') => h('span', { class: cls, 'aria-hidden': 'true' }, '·');
  return [
    h(
      'a',
      {
        // On a phone the default branch goes unsaid; a branch asked for by link still shows.
        class: repo.info.ref.ref === undefined ? 'branch default' : 'branch',
        href: githubUrl(repo.info.ref, repo.info.branch),
        target: '_blank',
        rel: 'noopener',
        title: `Open ${repo.info.branch} on GitHub`,
      },
      icon(...ICONS.branch),
      h('span', {}, repo.info.branch),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-btn',
        'aria-label': 'Reload from GitHub',
        title: 'Reload from GitHub, skipping the cache',
        // The ref as it was asked for: pinning the branch here would make the reload a
        // branch link, which reads history but is never offered to compute one.
        onclick: reload,
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
    repo.sample ? sep('sep opt') : null,
    h('span', { class: 'files' }, plural(folders.files[0]!, 'file')),
    sep('sep opt'),
    h('span', { class: 'opt' }, plural(folders.files.length - 1, 'folder')),
    sep('sep opt langs'),
    h('span', { class: 'opt langs' }, plural(langs, 'language')),
    // A phone keeps this in its More menu.
    h(
      'a',
      {
        class: 'icon-btn gh',
        href: githubUrl(repo.info.ref),
        target: '_blank',
        rel: 'noopener',
        'aria-label': 'Open on GitHub',
        title: 'Open on GitHub',
      },
      icon(...ICONS.external),
    ),
  ];
}

/**
 * A repo card's weather chip: what its CI's sky stands for, linking to the Actions runs, or that
 * GitHub didn't send them (a tap asks again, through the chip's own click handler). Hidden with
 * weather off or before the runs arrive.
 */
export function paintWeather(chip: HTMLAnchorElement, state: AppState, repo: Loaded | null): void {
  const weather = ciOf(state, repo);
  chip.removeAttribute('role');
  chip.removeAttribute('tabindex');
  if (ciFailed(state, repo)) {
    // Said rather than left out, so a missing sky reads as GitHub not answering; a tap asks again.
    chip.hidden = false;
    chip.dataset.sky = 'unknown';
    chip.removeAttribute('href');
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.title =
      'GitHub didn’t send this repository’s CI runs (its rate limit, or the network). Tap to try again.';
    chip.setAttribute('aria-label', 'CI unavailable, try again');
    fill(
      chip,
      icon(...ICONS.cloudy),
      h('strong', {}, 'CI unavailable'),
      h('b', { class: 'short', 'aria-hidden': 'true' }, 'CI unavailable'),
    );
    return;
  }
  if (!weather || !repo) {
    chip.hidden = true;
    return;
  }
  const { sky, health } = weather;
  const { ref, branch } = repo.info;
  const { verdict, detail } = describeWeather(sky, health, Date.now());
  const snow = PALETTES[state.settings.palette].precip === 'snow';
  const glyph = snow && (sky === 'rain' || sky === 'storm') ? 'snow' : sky;
  chip.hidden = false;
  chip.dataset.sky = sky;
  if (health) chip.href = actionsUrl(ref, branch);
  else chip.removeAttribute('href');
  chip.title = !health
    ? 'A weather preview from the link, not this repository’s CI'
    : health.runs
      ? `Weather from the last ${plural(health.runs, 'finished GitHub Actions run')} on ${branch}`
      : `No finished GitHub Actions runs on ${branch}`;
  chip.setAttribute('aria-label', detail ? `${verdict}, ${detail}` : verdict);
  fill(
    chip,
    icon(...ICONS[glyph]),
    h('strong', {}, verdict),
    h('b', { class: 'short', 'aria-hidden': 'true' }, shortVerdict(verdict)),
    detail && h('span', {}, detail),
  );
}

/**
 * Keeps the errors and notices in their own place, clear of the tree and the cards. On a desktop
 * that is the bottom left, just above the bottom row's buttons (or the timeline, while it shows).
 * On a phone it is a full-width row right under whichever card is up top: the repo card, or the
 * repo field open in its place.
 */
function placeAlerts(alerts: HTMLElement): void {
  const phone = matchMedia('(max-width: 760px)');
  const shown = (el: Element | null) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return box.width && box.height && getComputedStyle(el).visibility !== 'hidden' ? box : null;
  };
  const GAP = 12;
  const place = () => {
    if (!alerts.querySelector(':scope > :not(:empty)')) return;
    if (phone.matches) {
      const above = ['#repo-form', '#title']
        .map((sel) => shown(document.querySelector(sel)))
        .filter((b): b is DOMRect => !!b);
      alerts.style.top = `${Math.round(Math.max(0, ...above.map((b) => b.bottom)) + GAP - 2)}px`;
      alerts.style.bottom = 'auto';
      return;
    }
    const below = ['#timeline', '#grow', '#spin', '#scrubber']
      .map((sel) => shown(document.querySelector(sel)))
      .filter((b): b is DOMRect => !!b && b.top > innerHeight / 2);
    const top = Math.min(innerHeight, ...below.map((b) => b.top));
    alerts.style.top = 'auto';
    alerts.style.bottom = `${Math.round(innerHeight - top + GAP)}px`;
  };
  const resize = new ResizeObserver(place);
  for (const sel of ['#repo-form', '#title', '#scrubber', '#alerts']) {
    const el = document.querySelector(sel);
    if (el) resize.observe(el);
  }
  new MutationObserver(place).observe(alerts, { childList: true, subtree: true });
  new MutationObserver(place).observe(document.body, { attributes: true });
  const scrubber = document.querySelector('#scrubber');
  if (scrubber) new MutationObserver(place).observe(scrubber, { attributes: true });
  addEventListener('resize', place);
  phone.addEventListener('change', place);
  place();
}
