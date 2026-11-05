import { h, icon, ICONS } from '../dom';

/** Every key the page answers, in the order a visitor learns them. */
export const SHORTCUTS: { keys: string[]; does: string }[] = [
  { keys: ['/'], does: 'Search folders and files' },
  { keys: ['Esc'], does: 'Close, or clear the pin and the highlight' },
  { keys: ['F'], does: 'Reset the view to the whole tree' },
  { keys: ['Space'], does: 'Spin or pause' },
  { keys: ['G'], does: 'Grow the tree again' },
  { keys: ['D'], does: 'Dark or light mode' },
  { keys: ['T'], does: 'Open or close the timeline' },
  { keys: ['?'], does: 'Show these shortcuts' },
];

/**
 * Keyboard shortcuts as a small modal dialog, opened with `?` or from the hint under the tree.
 * A native dialog traps focus and closes on Escape by itself.
 */
export function mountShortcuts(): { open(): void; isOpen(): boolean } {
  const dialog = h(
    'dialog',
    { class: 'shortcuts', 'aria-labelledby': 'shortcuts-title' },
    h(
      'div',
      { class: 'shortcuts-head' },
      h('h2', { id: 'shortcuts-title' }, 'Keyboard shortcuts'),
      h(
        'button',
        {
          type: 'button',
          class: 'close',
          'aria-label': 'Close',
          onclick: () => dialog.close(),
        },
        icon(...ICONS.close),
      ),
    ),
    h(
      'dl',
      {},
      ...SHORTCUTS.flatMap(({ keys, does }) => [
        h('dt', {}, ...keys.map((k) => h('kbd', {}, k))),
        h('dd', {}, does),
      ]),
    ),
  );
  // A click on the backdrop lands on the dialog itself, outside its content box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);
  return {
    open: () => {
      if (!dialog.open) dialog.showModal();
    },
    isOpen: () => dialog.open,
  };
}
