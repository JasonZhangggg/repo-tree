import { byId } from '../dom';

/** Label each moved button shows in the menu, where the desktop's short label would be unclear. */
const MENU_LABELS: Record<string, string> = { share: 'Copy link', export: 'Export PNG' };

/**
 * On a phone the bottom row keeps Timeline, Dark mode (just left of Search), Search and Settings,
 * and a short menu behind `More actions` holds Copy link, Export PNG and Open on GitHub; Sign in,
 * or the GitHub account once signed in, is a bubble of its own at the top right. Grow again and
 * Spin, which the desktop shows as buttons, are left off the phone: Spin is a switch in Settings,
 * and a tree regrows when it loads. The buttons themselves move, so their
 * handlers, shortcuts and accessible names stay the same; on a wider screen they go back.
 */
export function mountMoreMenu(phone: MediaQueryList): void {
  const more = byId<HTMLButtonElement>('more');
  const menu = byId('more-menu');
  /** Into the menu on a phone, in this order; back into the toolbar on a desktop. */
  const moved = ['share', 'export'].map((id) => byId<HTMLButtonElement>(id));
  const signin = byId<HTMLButtonElement>('signin');
  const desktopLabels = moved.map((el) => el.querySelector('.label')?.textContent ?? null);
  /** Desktop only. */
  const dropped = ['grow', 'spin'].map((id) => byId<HTMLButtonElement>(id));
  const theme = byId<HTMLButtonElement>('theme');
  const search = byId<HTMLButtonElement>('search-open');
  const settings = byId<HTMLButtonElement>('settings-open');

  const setOpen = (open: boolean) => {
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };

  const place = () => {
    setOpen(false);
    moved.forEach((el, i) => {
      const label = el.querySelector('.label');
      // Only the buttons named in MENU_LABELS change label: sign-in keeps its own, which its
      // module keeps current.
      const menuLabel = MENU_LABELS[el.id];
      if (phone.matches) {
        menu.append(el);
        if (label && menuLabel) label.textContent = menuLabel;
      } else {
        // Desktop: Share and PNG share one group.
        byId('share-group').append(el);
        if (label && menuLabel) label.textContent = desktopLabels[i]!;
      }
    });
    // Sign in stands last in the desktop toolbar, after the view group; on a phone, whose
    // toolbar hides under the repo card, it floats at the top right.
    if (phone.matches) document.body.append(signin);
    else more.before(signin);
    signin.classList.toggle('bubble', phone.matches);
    dropped.forEach((el) => el.classList.toggle('phone-off', phone.matches));
    // Dark mode sits just left of Search on a phone, and in the view group on a desktop.
    if (phone.matches) search.before(theme);
    else settings.before(theme);
    // The way to the repo on GitHub, which the phone's repo row leaves to the menu, goes last.
    menu.append(byId('open-github'));
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
