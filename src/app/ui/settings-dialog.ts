import { DEFAULT_FILTERS } from '../../repo/hierarchy';
import { PALETTES } from '../../render/palette';
import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { COLOR_BYS, PALETTE_IDS, QUALITIES, type Settings } from '../settings';
import type { AppState } from '../state';
import { COLOR_BY_HINT, COLOR_BY_ICON, COLOR_BY_LABEL } from './color-by';
import { springTo, type Run } from './spring';
import {
  project,
  pushSample,
  releaseVelocity,
  rubberband,
  type Sample,
} from '../../render/momentum';

const QUALITY_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };
const FOLDER_NAME = /^[^/\\]{1,100}$/;

/** The settings popover (a drawer on phones, with a tab on top). Every control applies live. */
export function mountSettings(app: App): {
  open(focus?: 'token' | 'hidden'): void;
  close(): boolean;
} {
  const { store } = app;
  const dialog = byId('settings');
  const opener = byId('settings-open');
  const set = (patch: Partial<Settings>) => store.dispatch({ type: 'settings', patch });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const radioGroup = <T extends string>(
    label: string,
    values: readonly T[],
    current: T,
    text: (v: T) => string | Node[],
    pick: (v: T) => void,
    cls = 'seg',
  ) => {
    const group = h(
      'div',
      { class: cls, role: 'radiogroup', 'aria-label': label },
      ...values.map((v) => {
        const content = text(v);
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(v === current),
            tabindex: v === current ? '0' : '-1',
            'data-key': `${label}:${v}`,
            onclick: () => pick(v),
          },
          ...(typeof content === 'string' ? [content] : content),
        );
      }),
    );
    group.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const at = values.indexOf(current);
      const next = values[(at + step + values.length) % values.length]!;
      pick(next);
      focusAfter(`[data-key="${CSS.escape(`${label}:${next}`)}"]`);
    });
    return group;
  };

  const toggle = (
    label: string,
    note: string | null,
    checked: boolean,
    change: (on: boolean) => void,
    disabled = false,
  ) =>
    h(
      'label',
      { class: 'switch' },
      h('span', {}, label, note && h('small', {}, note)),
      h('input', {
        type: 'checkbox',
        role: 'switch',
        checked,
        disabled,
        'data-key': `switch:${label}`,
        onchange: (event: Event) => change((event.target as HTMLInputElement).checked),
      }),
    );

  /**
   * Color leaves by: a field showing the current way, which opens a menu of all five. The menu is
   * a radio group, so arrow keys and screen readers treat it like the other choices here.
   */
  let colorMenu: HTMLElement | null = null;
  const colorButton = () => dialog.querySelector<HTMLElement>('#color-pick');
  const setColorOpen = (open: boolean) => {
    if (!colorMenu) return;
    colorMenu.hidden = !open;
    colorButton()?.setAttribute('aria-expanded', String(open));
    if (open) colorMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  const colorPicker = (current: Settings['colorBy']) => {
    const menu = radioGroup(
      'Color leaves by',
      COLOR_BYS,
      current,
      (v) => [
        icon(...COLOR_BY_ICON[v]),
        h('span', { class: 'name' }, COLOR_BY_LABEL[v]),
        h('span', { class: 'hint' }, COLOR_BY_HINT[v]),
        icon(...ICONS.check),
      ],
      (colorBy) => {
        set({ colorBy });
        setColorOpen(false);
        focusAfter('#color-pick');
      },
      'pick-menu',
    );
    menu.hidden = true;
    colorMenu = menu;
    return h(
      'div',
      { class: 'pick-wrap' },
      h(
        'button',
        {
          type: 'button',
          class: 'pick',
          id: 'color-pick',
          'aria-haspopup': 'true',
          'aria-expanded': 'false',
          'aria-label': `Color leaves by: ${COLOR_BY_LABEL[current]}`,
          onclick: () => setColorOpen(colorMenu?.hidden === true),
        },
        icon(...COLOR_BY_ICON[current]),
        h('span', { class: 'name' }, COLOR_BY_LABEL[current]),
        h('span', { class: 'hint' }, COLOR_BY_HINT[current]),
        icon(...ICONS.chevron),
      ),
      menu,
    );
  };
  // A press anywhere else in the panel, or Escape, closes the menu before anything else.
  dialog.addEventListener(
    'pointerdown',
    (event) => {
      if (colorMenu && !colorMenu.hidden && !(event.target as Element).closest('.pick-wrap'))
        setColorOpen(false);
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || dialog.hidden || !colorMenu || colorMenu.hidden) return;
      event.stopPropagation();
      setColorOpen(false);
      colorButton()?.focus();
    },
    true,
  );

  const render = (state: AppState) => {
    const { settings, autoQuality } = state;
    const known = [...new Set([...DEFAULT_FILTERS.hidden, ...settings.hidden])];
    const hiddenSet = new Set(settings.hidden);

    const addFolder = h(
      'form',
      { class: 'inline-form' },
      h('input', {
        name: 'folder',
        'data-key': 'add-folder',
        oninput: (event: Event) => (event.target as HTMLInputElement).setCustomValidity(''),
        placeholder: 'Hide another folder name',
        'aria-label': 'Folder name to hide',
        autocomplete: 'off',
        spellcheck: 'false',
      }),
      h('button', { type: 'submit', class: 'btn' }, 'Hide'),
    );
    addFolder.addEventListener('submit', (event) => {
      event.preventDefault();
      const field = addFolder.elements.namedItem('folder') as HTMLInputElement;
      const name = field.value.trim();
      if (!FOLDER_NAME.test(name)) {
        field.setCustomValidity('Enter one folder name, without slashes.');
        field.reportValidity();
        return;
      }
      if (!hiddenSet.has(name)) set({ hidden: [...settings.hidden, name] });
    });

    const tokenField = settings.token
      ? h(
          'div',
          { class: 'token-saved' },
          h('span', {}, 'Token saved in this browser'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              id: 'token-remove',
              onclick: () => {
                set({ token: '' });
                focusAfter('#token-input');
              },
            },
            'Remove token',
          ),
        )
      : (() => {
          const form = h(
            'form',
            { class: 'inline-form' },
            h('input', {
              id: 'token-input',
              name: 'token',
              type: 'password',
              placeholder: 'ghp_… or github_pat_…',
              'aria-label': 'GitHub token',
              autocomplete: 'off',
              spellcheck: 'false',
            }),
            h('button', { type: 'submit', class: 'btn dark' }, 'Save'),
          );
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            const token = (form.elements.namedItem('token') as HTMLInputElement).value.trim();
            if (!token) return;
            set({ token });
            focusAfter('#token-remove');
            const { load } = store.get();
            if (load.phase === 'error') app.load(load.ref);
          });
          return form;
        })();

    dialog.replaceChildren(
      // A phone's drawer tab: tap it to close, or drag it (or the title) down. A pointer
      // affordance only: the X beside the title is the close button for keys and readers.
      h(
        'button',
        {
          type: 'button',
          class: 'settings-grip',
          'aria-hidden': 'true',
          tabindex: -1,
          onclick: () => close(),
        },
        h('span', { class: 'grip' }),
      ),
      h('h2', { id: 'settings-title' }, 'Settings'),
      h(
        'button',
        { type: 'button', class: 'close', 'aria-label': 'Close settings', onclick: () => close() },
        icon(...ICONS.close),
      ),
      h(
        'div',
        { class: 'field' },
        h('p', { class: 'h' }, 'Palette'),
        radioGroup(
          'Palette',
          PALETTE_IDS,
          settings.palette,
          (id) =>
            [
              h(
                'span',
                { class: 'dots', 'aria-hidden': 'true' },
                ...PALETTES[id].leaves.slice(0, 4).map((c) => h('i', { style: `--c:${c}` })),
              ),
              PALETTES[id].name,
            ] as Node[],
          (palette) => set({ palette }),
          'swatches',
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('p', { class: 'h' }, 'Color leaves by'),
        colorPicker(settings.colorBy),
        settings.colorBy === 'activity' &&
          h(
            'p',
            { class: 'note' },
            "From commit history: how recently each file changed, in the color scheme's own leaves, brightest for this month. Branches untouched for 3 years drop their leaves.",
          ),
        settings.colorBy === 'changes' &&
          h(
            'p',
            { class: 'note' },
            "From commit history: how often each file changed, a gradient in the color scheme's own leaves from lightest (rarely) to darkest (constantly). The busiest few glow.",
          ),
        settings.colorBy === 'owner' &&
          h(
            'p',
            { class: 'note' },
            'Each top-level folder takes its owner: the first CODEOWNERS entry, else its busiest recent commit author. Shows who to ask.',
          ),
      ),
      h(
        'div',
        { class: 'field' },
        h('p', { class: 'h' }, 'Quality'),
        radioGroup(
          'Quality',
          QUALITIES,
          settings.quality,
          (v) => QUALITY_LABEL[v],
          (quality) => set({ quality }),
        ),
        h(
          'p',
          { class: 'note' },
          settings.quality === 'auto'
            ? `Auto chose ${QUALITY_LABEL[autoQuality].toLowerCase()} here. Higher means more leaves, sharper shadows.`
            : 'Higher means more leaves, sharper shadows.',
        ),
      ),
      h(
        'div',
        { class: 'field' },
        toggle('Dark mode', null, settings.theme === 'dark', (dark) =>
          set({ theme: dark ? 'dark' : 'light' }),
        ),
        toggle('Spin', null, settings.spin, (spin) => set({ spin })),
        toggle('Folder labels', null, settings.labels, (labels) => set({ labels })),
        toggle('Ground', null, settings.ground, (ground) => set({ ground })),
        toggle('Weather', 'Shows CI from GitHub Actions', settings.weather, (weather) =>
          set({ weather }),
        ),
        toggle('Show PRs', 'Open pull requests perch as birds', settings.birds, (birds) =>
          set({ birds }),
        ),
        toggle(
          'Growth animation',
          reducedMotion.matches ? 'Off: your system asks for reduced motion' : null,
          settings.growAnim && !reducedMotion.matches,
          (growAnim) => set({ growAnim }),
          reducedMotion.matches,
        ),
      ),
      h(
        'div',
        { class: 'field', id: 'hidden-field' },
        h('p', { class: 'h' }, 'Hidden folders'),
        h('p', { class: 'note' }, 'Left out at any depth. Changes regrow the tree.'),
        h(
          'div',
          { class: 'chips' },
          ...known.map((name) =>
            h(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': String(hiddenSet.has(name)),
                'data-folder': name,
                'data-key': `chip:${name}`,
                title: hiddenSet.has(name) ? `Show ${name}` : `Hide ${name}`,
                onclick: () => {
                  set({
                    hidden: hiddenSet.has(name)
                      ? settings.hidden.filter((n) => n !== name)
                      : [...settings.hidden, name],
                  });
                },
              },
              name,
            ),
          ),
        ),
        addFolder,
      ),
      h(
        'div',
        { class: 'field', id: 'token-field' },
        h('p', { class: 'h' }, 'GitHub token'),
        h('p', { class: 'note' }, 'For private repos. Kept in this browser, sent only to GitHub.'),
        tokenField,
      ),
    );
  };

  const focusAfter = (selector: string) =>
    queueMicrotask(() => dialog.querySelector<HTMLElement>(selector)?.focus());

  store.subscribe((state, prev) => {
    if (
      dialog.hidden ||
      (state.settings === prev.settings && state.autoQuality === prev.autoQuality)
    )
      return;
    const key = (document.activeElement as HTMLElement | null)?.dataset?.key;
    render(state);
    if (key) dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  });

  const onOutside = (event: PointerEvent) => {
    if (!dialog.contains(event.target as Node) && !opener.contains(event.target as Node)) close();
  };

  function open(focus?: 'token' | 'hidden') {
    leaving?.cancel();
    leaving = null;
    render(store.get());
    dialog.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    const target =
      focus === 'token'
        ? '#token-input, #token-remove'
        : focus === 'hidden'
          ? '#hidden-field .chip'
          : '[role="radio"][aria-checked="true"]';
    dialog.querySelector<HTMLElement>(target)?.focus();
    if (focus) dialog.querySelector(`#${focus}-field`)?.scrollIntoView({ block: 'nearest' });
  }

  /** On a phone the drawer slides back down when closed by its X, Esc or a tap outside. */
  let leaving: Animation | null = null;
  const phone = matchMedia('(max-width: 760px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  function close(): boolean {
    if (dialog.hidden || leaving) return false;
    // A drag that closes it has already slid it out of sight.
    if (phone.matches && !reduce.matches && !dialog.style.transform) {
      const anim = dialog.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }],
        {
          duration: 200,
          easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
          fill: 'forwards',
        },
      );
      leaving = anim;
      anim.onfinish = () => {
        if (leaving !== anim) return;
        leaving = null;
        dialog.hidden = true;
        anim.cancel();
      };
    } else dialog.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (dialog.contains(document.activeElement) || document.activeElement === document.body)
      opener.focus();
    return true;
  }

  opener.addEventListener('click', () => (dialog.hidden || leaving ? open() : close()));
  dragDown(dialog, close);
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([tabindex="-1"]), input:not([disabled]), [tabindex="0"]',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  return { open, close };
}

/** A drag this far down, in px or share of the drawer's height, or a flick this fast, closes it. */
const CLOSE_AT = { px: 96, share: 0.3, flick: 0.5 };
/** How far the drawer gives when dragged up past where it rests (px). */
const DRAWER_GIVE = 36;

/**
 * On a phone the Settings drawer follows a finger dragged down from its tab or its title, and on
 * release closes, sliding the rest of the way, or springs back.
 */
function dragDown(dialog: HTMLElement, close: () => boolean): void {
  const phone = matchMedia('(max-width: 760px)');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let press: { id: number; y0: number; samples: Sample[]; moved: boolean } | null = null;
  let swallowClick = false;
  /** The spring a release hands the drawer to, until it rests in place or below the screen. */
  let run: Run | null = null;

  const reset = () => {
    run = null;
    dialog.style.removeProperty('transform');
    void dialog.offsetHeight;
    dialog.removeAttribute('data-dragging');
  };
  // Dragged up past where it rests the drawer gives a little; down it follows the finger.
  const offsetOf = (dy: number) => (dy < 0 ? rubberband(dy, DRAWER_GIVE) : dy);
  const show = (y: number) => (dialog.style.transform = `translateY(${y}px)`);

  dialog.addEventListener('pointerdown', (event) => {
    if (!phone.matches || press || !event.isPrimary || event.button > 0) return;
    if (!(event.target as Element).closest('.settings-grip, #settings-title')) return;
    swallowClick = false;
    // A drawer still springing back is caught where it is.
    if (run) {
      const y = run.stop();
      run = null;
      dialog.setPointerCapture(event.pointerId);
      press = { id: event.pointerId, y0: event.clientY - y, samples: [], moved: true };
      return;
    }
    press = { id: event.pointerId, y0: event.clientY, samples: [], moved: false };
  });
  dialog.addEventListener('pointermove', (event) => {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    const dy = event.clientY - p.y0;
    if (!p.moved) {
      if (Math.abs(dy) < 6) return;
      p.moved = true;
      dialog.setAttribute('data-dragging', '');
      dialog.setPointerCapture(p.id);
    }
    // A slow frame folds several moves into one event; each still says how fast the finger went.
    for (const e of event.getCoalescedEvents?.() ?? [event]) {
      pushSample(p.samples, { at: e.clientY, t: e.timeStamp });
    }
    show(offsetOf(dy));
  });
  /**
   * A release throws the drawer: shut when flung down or when its throw would carry it far
   * enough, else back up. A spring carries it on at the finger's speed either way.
   */
  const release = (event: PointerEvent) => {
    const p = press;
    if (!p || event.pointerId !== p.id) return;
    press = null;
    if (!p.moved) return;
    swallowClick = true;
    pushSample(p.samples, { at: event.clientY, t: event.timeStamp });
    const y = offsetOf(event.clientY - p.y0);
    const velocity = releaseVelocity(p.samples, event.timeStamp);
    const landing = y + project(velocity, 0.995);
    const height = dialog.offsetHeight;
    const shut =
      event.type !== 'pointercancel' &&
      (velocity > CLOSE_AT.flick || landing > Math.min(CLOSE_AT.px, height * CLOSE_AT.share));
    if (reduce.matches) {
      if (shut) close();
      reset();
      return;
    }
    run = springTo(
      y,
      shut ? height : 0,
      velocity * 1000,
      show,
      () => {
        if (shut) close();
        reset();
      },
      { response: 0.34 },
    );
  };
  dialog.addEventListener('pointerup', release);
  dialog.addEventListener('pointercancel', release);
  dialog.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );
}
