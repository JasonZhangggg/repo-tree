type Child = Node | string | null | undefined | false;
type Props = Record<
  string,
  string | number | boolean | null | undefined | ((event: never) => void)
>;

/** Creates an element. `on*` props add listeners, `true` sets an empty attribute, nullish skips. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  return fill(el, ...children) as HTMLElementTagNameMap[K];
}

/** Replaces an element's children, skipping empty ones. */
export function fill(el: Element, ...children: Child[]): Element {
  el.replaceChildren(...children.filter((c): c is Node | string => !!c || c === ''));
  return el;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const SVG = 'http://www.w3.org/2000/svg';

/** An inline icon from path data on a 24px grid. */
export function icon(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export const ICONS = {
  close: ['M6 6l12 12M18 6 6 18'],
  external: ['M14 5h5v5m0-5-8 8', 'M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4'],
  folder: ['M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z'],
  file: [
    'M7 3.5h6.5l4 4V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z',
    'M13 3.5V8h4.5',
  ],
  branch: [
    'M7 4v10m0 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm10-6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm0 0c0 4-10 2-10 6',
  ],
  reload: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4'],
  alert: ['M12 8v5m0 3.2v.3'],
  clock: ['M12 7.5V12l3 2', 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z'],
  play: ['M8 6.5v11l9-5.5Z'],
  pause: ['M9 6v12m6-12v12'],
  history: ['M4 12a8 8 0 1 0 2.4-5.7L4 8.5', 'M4 4v4.5h4.5', 'M12 8v4l2.5 1.5'],
  sample: ['M12 20v-8m0 2c-3 0-5-2-5-5 3 0 5 2 5 5Zm0-2c0-3 2-5 5-5 0 3-2 5-5 5Z'],
  sunny: [
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    'M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  ],
  cloudy: [
    'M12 2.5v2M5.3 5.3l1.4 1.4M19.5 12h2M18.7 5.3l-1.4 1.4',
    'M15.9 12.6a4 4 0 0 0-5.9-4.1',
    'M13 21.5H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z',
  ],
  rain: ['M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2', 'M16 14v6M8 14v6M12 16v6'],
  storm: ['M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9', 'm13 12-3 5h4l-3 5'],
  snow: [
    'M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2',
    'M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01',
  ],
  clear: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17Z', 'M8.5 12h7'],
};
