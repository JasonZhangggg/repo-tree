import type { App } from '../app';
import { byId } from '../dom';
import { colorByPicker } from './color-by';

/**
 * On a phone, the collapsed drawer's bar carries Color leaves by beside its title: a compact
 * picker that opens upward, so the drawer's most-used choice is one tap away without opening it.
 * It hides while the drawer is open, where the full picker is, or while a folder is pinned.
 */
export function mountQuick(app: App): void {
  const { store } = app;
  const picker = colorByPicker('quick-color-pick', (colorBy) =>
    store.dispatch({ type: 'settings', patch: { colorBy } }),
  );
  byId('quick').replaceChildren(picker.element);
  store.subscribe((state, prev) => {
    if (state.settings.colorBy !== prev.settings.colorBy) picker.render(state.settings.colorBy);
  });
  picker.render(store.get().settings.colorBy);
}
