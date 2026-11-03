export type PaletteId = 'autumn' | 'spring' | 'summer' | 'winter';
export type ColorBy = 'language' | 'folder';

export type Palette = {
  id: PaletteId;
  name: string;
  bark: string;
  /** Radial background: `center` behind the crown fading to `edge` at the corners. */
  sky: { center: string; edge: string };
  /** Tint of the cast shadow and the contact shadow under the trunk. */
  shadow: string;
  light: { key: string; sky: string; ground: string };
  /** Leaf colors in the order the most common languages or folders take them. */
  leaves: readonly string[];
  /** Shared by every language or folder past the end of `leaves`. */
  rest: string;
};

export const PALETTES: Record<PaletteId, Palette> = {
  autumn: {
    id: 'autumn',
    name: 'Autumn',
    bark: '#6b5d53',
    sky: { center: '#fdfcfa', edge: '#dedad3' },
    shadow: '#3c2d1e',
    light: { key: '#fff3e6', sky: '#ffffff', ground: '#afaba4' },
    leaves: [
      '#e5512c',
      '#f2c443',
      '#c2302c',
      '#f3a13a',
      '#a8385c',
      '#ead27c',
      '#f07a36',
      '#8f3b1d',
      '#ff8f5a',
    ],
    rest: '#c9a98a',
  },
  spring: {
    id: 'spring',
    name: 'Spring blossom',
    bark: '#5b4a46',
    sky: { center: '#fdfbfb', edge: '#e0dadf' },
    shadow: '#3a2a35',
    light: { key: '#fff4f2', sky: '#ffffff', ground: '#c4b8bf' },
    leaves: [
      '#f29bbb',
      '#fde8ef',
      '#e0628f',
      '#a8d26c',
      '#f7c1d4',
      '#c94f8a',
      '#fff8fa',
      '#f5b19c',
      '#b98ad0',
    ],
    rest: '#e6cbd3',
  },
  summer: {
    id: 'summer',
    name: 'Summer green',
    bark: '#5e4b3c',
    sky: { center: '#fbfcf7', edge: '#d7ddcd' },
    shadow: '#22301c',
    light: { key: '#fff6dc', sky: '#ffffff', ground: '#b3b8a4' },
    leaves: [
      '#4f9a3a',
      '#9cc84a',
      '#2c7346',
      '#c4d65a',
      '#3c9b7c',
      '#79a93a',
      '#1f5e37',
      '#e3c548',
      '#8fcf86',
    ],
    rest: '#a8b98f',
  },
  winter: {
    id: 'winter',
    name: 'Winter',
    bark: '#55504e',
    sky: { center: '#f6f8fb', edge: '#c9d3de' },
    shadow: '#1e2a3a',
    light: { key: '#eef4ff', sky: '#ffffff', ground: '#aeb8c4' },
    leaves: [
      '#a9c8e4',
      '#ffffff',
      '#6f9cc6',
      '#d6e4f0',
      '#b23c52',
      '#8fb0c8',
      '#e9eef7',
      '#4f7aa6',
      '#c7bde0',
    ],
    rest: '#bcc6cf',
  },
};

/** One legend row: the color, what it stands for, and how many files carry it. */
export type LegendEntry = { color: string; label: string; files: number };

/**
 * Ranks categories by file count, most first, and gives the first `leaves.length` of them
 * the palette's leaf colors in order; the rest share `palette.rest`. `slotOf[i]` is the color
 * slot of `categories[i]` (the rest share slot `leaves.length`), so the same repo always maps
 * the same way and a palette switch only swaps the colors behind the slots.
 */
export function leafMapping(
  categories: ReadonlyArray<{ label: string; files: number }>,
  palette: Palette,
): { slotOf: number[]; legend: LegendEntry[] } {
  const ramp = palette.leaves.length;
  const ranked = categories
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.files - a.files || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const slotOf = new Array<number>(categories.length);
  ranked.forEach((c, rank) => (slotOf[c.i] = Math.min(rank, ramp)));

  const named = ranked.slice(0, ramp);
  const tail = ranked.slice(ramp);
  const legend = named.map((c, rank) => ({
    color: palette.leaves[rank]!,
    label: c.label,
    files: c.files,
  }));
  if (tail.length > 0) {
    legend.push({
      color: palette.rest,
      label: tail.length === 1 ? tail[0]!.label : `${tail.length} more`,
      files: tail.reduce((sum, c) => sum + c.files, 0),
    });
  }
  return { slotOf, legend };
}
