import { byId } from '../dom';

/** Label each moved button shows in the menu, where the desktop's short label would be unclear. */
const MENU_LABELS: Record<string, string> = { share: 'Copy link', export: 'Export PNG' };

/**
 * On a phone the bottom row keeps Timeline, Search and Settings, and the rest of the actions move
 * into a menu behind `More actions`. The buttons themselves move, so their handlers, shortcuts and
 * accessible names stay the same; on a wider screen they go back where they came from.
 */
export function mountMoreMenu(phone: MediaQueryList): void {
  const more = byId<HTMLButtonElement>('more');
  const menu = byId('more-menu');
  const timeline = byId('timeline');
  const settings = byId('settings-open');
  const ids = ['grow', 'spin', 'share', 'export', 'theme', 'signin'];
  const items = ids.map((id) => byId<HTMLButtonElement>(id));
  const desktopLabels = items.map((el) => el.querySelector('.label')?.textContent ?? null);

  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };

  const place = () => {
    setOpen(false);
    items.forEach((el, i) => {
      const label = el.querySelector('.label');
      // Only the buttons named in MENU_LABELS change label: others (theme, sign-in) keep theirs,
      // which their own modules keep current.
      const menuLabel = MENU_LABELS[ids[i]!];
      if (phone.matches) {
        menu.append(el);
        if (label && menuLabel) label.textContent = menuLabel;
      } else {
        const anchor = i < 2 ? timeline : settings;
        anchor.before(el);
        if (label && menuLabel) label.textContent = desktopLabels[i]!;
      }
    });
    // The way to the repo on GitHub, which the phone's repo row leaves to the menu, goes last;
    // signing in, which the rest depend on for GitHub's limit, goes first.
    menu.append(byId('open-github'));
    if (phone.matches) menu.prepend(byId('signin'));
  };

  more.addEventListener('click', () => setOpen(menu.hidden !== false));
  // Each action closes the menu once its own handler has run.
  menu.addEventListener('click', (event) => {
    if ((event.target as Element).closest('button, a')) setOpen(false);
  });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target as Element;
    if (!menu.hidden && !target.closest('#more-menu, #more')) setOpen(false);
  });
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.stopPropagation();
      setOpen(false);
      more.focus();
    },
    true,
  );
  phone.addEventListener('change', place);
  place();
}
