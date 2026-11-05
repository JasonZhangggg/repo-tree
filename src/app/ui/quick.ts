import type { App } from '../app';
import { byId } from '../dom';
import { colorByPicker } from './color-by';

/**
 * On a phone, the drawer's bar carries Color leaves by beside its title, collapsed or open: a
 * compact picker that opens upward, so the drawer's most-used choice is one tap away. While a
 * folder is pinned it hides, and the drawer's own picker shows instead.
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
