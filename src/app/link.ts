import { parseRepoRef, type RepoRef } from '../repo/ref';
import type { ColorBy, PaletteId } from '../render/palette';
import { COLOR_BYS, PALETTE_IDS } from './settings';

/** Everything a shared URL restores: `#/owner/repo?branch=&palette=&colorBy=&sel=&hl=`. */
export type ViewLink = {
  ref: RepoRef;
  palette?: PaletteId;
  colorBy?: ColorBy;
  /** The pinned folder's path. */
  sel?: string;
  /** The highlighted legend entry's label. */
  hl?: string;
};

export function parseLink(hash: string): ViewLink | null {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?', 2);
  const query = new URLSearchParams(search);
  const branch = query.get('branch');
  const parsed = parseRepoRef(path);
  if ('kind' in parsed) return null;
  const ref = (branch ? { ...parsed, ref: branch } : parsed) as RepoRef;
  const link: ViewLink = { ref };
  const palette = query.get('palette');
  const colorBy = query.get('colorBy');
  const sel = query.get('sel');
  const hl = query.get('hl');
  if (PALETTE_IDS.includes(palette as PaletteId)) link.palette = palette as PaletteId;
  if (COLOR_BYS.includes(colorBy as ColorBy)) link.colorBy = colorBy as ColorBy;
  if (sel) link.sel = sel;
  if (hl) link.hl = hl;
  return link;
}

export function formatLink({ ref, palette, colorBy, sel, hl }: ViewLink): string {
  const params: [string, string | undefined][] = [
    ['branch', ref.ref],
    ['palette', palette],
    ['colorBy', colorBy],
    ['sel', sel],
    ['hl', hl],
  ];
  const query = params
    .filter((p): p is [string, string] => p[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll('%2F', '/')}`)
    .join('&');
  return `#/${ref.owner}/${ref.repo}${query ? `?${query}` : ''}`;
}
