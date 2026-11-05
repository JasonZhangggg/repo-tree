import type { ColorBy } from '../../render/palette';
import { h, icon, ICONS } from '../dom';
import { COLOR_BYS } from '../settings';

/** How each way of coloring leaves is named, hinted and drawn, in Settings and the side panel. */
export const COLOR_BY_LABEL = {
  language: 'Language',
  folder: 'Folder',
  activity: 'Activity',
  changes: 'Changes',
  owner: 'Owner',
};
export const COLOR_BY_HINT = {
  language: 'File type',
  folder: 'Top-level folder',
  activity: 'Last change',
  changes: 'How often it changed',
  owner: 'Code owner',
};
export const COLOR_BY_ICON = {
  language: ICONS.code,
  folder: ICONS.folder,
  activity: ICONS.clock,
  changes: ICONS.pulse,
  owner: ICONS.person,
};

/**
 * Color leaves by as a dropdown: a field showing the current way, which opens a menu of all
 * five. The menu is a radio group, so arrow keys and screen readers treat it like any other
 * choice. A press outside it, or Escape, closes it. `render` shows the current way.
 */
export function colorByPicker(
  id: string,
  pick: (colorBy: ColorBy) => void,
): { element: HTMLElement; render(current: ColorBy): void } {
  let current: ColorBy = 'language';
  const field = h('button', {
    type: 'button',
    class: 'pick',
    id,
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
  });
  const options = COLOR_BYS.map((v) =>
    h(
      'button',
      { type: 'button', role: 'radio', 'data-color-by': v, onclick: () => choose(v) },
      icon(...COLOR_BY_ICON[v]),
      h('span', { class: 'name' }, COLOR_BY_LABEL[v]),
      h('span', { class: 'hint' }, COLOR_BY_HINT[v]),
      icon(...ICONS.check),
    ),
  );
  const menu = h(
    'div',
    { class: 'pick-menu', role: 'radiogroup', 'aria-label': 'Color leaves by' },
    ...options,
  );
  menu.hidden = true;
  const element = h('div', { class: 'pick-wrap' }, field, menu);
  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    field.setAttribute('aria-expanded', String(open));
    if (open) options[COLOR_BYS.indexOf(current)]!.focus();
  };
  const choose = (v: ColorBy) => {
    pick(v);
    setOpen(false);
    field.focus();
  };
  field.addEventListener('click', () => setOpen(menu.hidden === true));
  menu.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(Math.max(0, at) + step + options.length) % options.length]!.focus();
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!menu.hidden && !element.contains(event.target as Node)) setOpen(false);
    },
    true,
  );
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.stopPropagation();
      setOpen(false);
      field.focus();
    },
    true,
  );
  return {
    element,
    render(next) {
      current = next;
      field.setAttribute('aria-label', `Color leaves by: ${COLOR_BY_LABEL[next]}`);
      field.replaceChildren(
        icon(...COLOR_BY_ICON[next]),
        h('span', { class: 'name' }, COLOR_BY_LABEL[next]),
        h('span', { class: 'hint' }, COLOR_BY_HINT[next]),
        icon(...ICONS.chevron),
      );
      for (const option of options) {
        const on = option.dataset.colorBy === next;
        option.setAttribute('aria-checked', String(on));
        option.tabIndex = on ? 0 : -1;
      }
    },
  };
}
