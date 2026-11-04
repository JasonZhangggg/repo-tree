import { DEFAULT_FILTERS } from '../../repo/hierarchy';
import { PALETTES } from '../../render/palette';
import type { App } from '../app';
import { byId, h, icon, ICONS } from '../dom';
import { COLOR_BYS, PALETTE_IDS, QUALITIES, type Settings } from '../settings';
import type { AppState } from '../state';

const COLOR_BY_LABEL = {
  language: 'Language',
  folder: 'Folder',
  activity: 'Activity',
  changes: 'Changes',
  owner: 'Owner',
};
const COLOR_BY_HINT = {
  language: 'File type',
  folder: 'Top-level folder',
  activity: 'Last change',
  changes: 'How often it changed',
  owner: 'Code owner',
};
const COLOR_BY_ICON = {
  language: ICONS.code,
  folder: ICONS.folder,
  activity: ICONS.clock,
  changes: ICONS.pulse,
  owner: ICONS.person,
};
const QUALITY_LABEL = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };
const FOLDER_NAME = /^[^/\\]{1,100}$/;

/** The settings popover (a bottom sheet on phones). Every control applies live. */
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
            "From commit history: how often each file changed, in the color scheme's own leaves, deepest for the busiest and palest for files that rarely change.",
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
        toggle('Spin', null, settings.spin, (spin) => set({ spin })),
        toggle('Folder labels', null, settings.labels, (labels) => set({ labels })),
        toggle('Ground', null, settings.ground, (ground) => set({ ground })),
        toggle('Weather', 'Shows CI from GitHub Actions', settings.weather, (weather) =>
          set({ weather }),
        ),
        toggle('Hotspots', 'Busiest files glow', settings.hotspots, (hotspots) =>
          set({ hotspots }),
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
        h(
          'p',
          { class: 'note' },
          'For private repos and a higher rate limit. Kept in this browser, sent only to GitHub.',
        ),
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

  function close(): boolean {
    if (dialog.hidden) return false;
    dialog.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (dialog.contains(document.activeElement) || document.activeElement === document.body)
      opener.focus();
    return true;
  }

  opener.addEventListener('click', () => (dialog.hidden ? open() : close()));
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
