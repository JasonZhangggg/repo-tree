import { SKIES, type Sky } from '../repo/ci';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import type { ColorBy, PaletteId } from '../render/palette';
import { COLOR_BYS, PALETTE_IDS } from './settings';

/** Everything a shared URL restores: `#/owner/repo?branch=&palette=&colorBy=&sel=&hl=&wx=&t=&vs=`. */
export type ViewLink = {
  ref: RepoRef;
  palette?: PaletteId;
  colorBy?: ColorBy;
  /** The pinned folder's path. */
  sel?: string;
  /** The highlighted legend entry's label. */
  hl?: string;
  /** Weather to preview in place of the repo's own, for demos, tests and screenshots. */
  wx?: Sky;
  /** The timeline is open at this date (ms, UTC), written as YYYY-MM-DD; YYYY-MM and YYYY also read. */
  t?: number;
  /** The compare view is open with this repo (`owner/repo`, its default branch) beside the first. */
  vs?: RepoRef;
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
  const wx = query.get('wx');
  if (PALETTE_IDS.includes(palette as PaletteId)) link.palette = palette as PaletteId;
  if (COLOR_BYS.includes(colorBy as ColorBy)) link.colorBy = colorBy as ColorBy;
  if (sel) link.sel = sel;
  if (hl) link.hl = hl;
  if (SKIES.includes(wx as Sky)) link.wx = wx as Sky;
  const t = parseDay(query.get('t'));
  if (t !== undefined) link.t = t;
  const vs = parseRepoRef(query.get('vs') ?? '');
  if (!('kind' in vs)) link.vs = vs;
  return link;
}

export function formatLink({ ref, palette, colorBy, sel, hl, wx, t, vs }: ViewLink): string {
  const params: [string, string | undefined][] = [
    ['branch', ref.ref],
    ['palette', palette],
    ['colorBy', colorBy],
    ['sel', sel],
    ['hl', hl],
    ['wx', wx],
    ['t', t === undefined ? undefined : new Date(t).toISOString().slice(0, 10)],
    ['vs', vs && `${vs.owner}/${vs.repo}`],
  ];
  const query = params
    .filter((p): p is [string, string] => p[1] !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll('%2F', '/')}`)
    .join('&');
  return `#/${ref.owner}/${ref.repo}${query ? `?${query}` : ''}`;
}

/** A UTC date from YYYY-MM-DD, YYYY-MM or YYYY; anything else is no date. */
function parseDay(text: string | null): number | undefined {
  const match = text?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (!match) return undefined;
  const [year, month = 1, day = 1] = match
    .slice(1)
    .map((part) => (part ? Number(part) : undefined));
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31) return undefined;
  return Date.UTC(year!, month! - 1, day);
}
