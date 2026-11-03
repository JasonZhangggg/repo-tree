import { litColor } from './color';

export type PaletteId = 'autumn' | 'spring' | 'summer' | 'winter';
export type ColorBy = 'language' | 'folder';

export type Palette = {
  id: PaletteId;
  name: string;
  bark: string;
  /** Radial background: `center` behind the crown fading to `edge` at the corners. */
  sky: { center: string; edge: string };
  /**
   * The mound under the tree. Grass faces mix `grass` and `meadow`; `cap` is the top of each
   * rock; flowers take `flowers` (none hides them); `litter` scatters fallen leaves in the leaf
   * colors; `blades` is the share of grass tufts shown.
   */
  ground: {
    grass: string;
    meadow: string;
    dirt: string;
    soil: string;
    stone: string;
    rock: string;
    cap: string;
    blade: string;
    flowers: readonly string[];
    litter: boolean;
    blades: number;
  };
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
    ground: {
      grass: '#4e7f2a',
      meadow: '#3d6d22',
      dirt: '#4a3121',
      soil: '#6e4a30',
      stone: '#5a524b',
      rock: '#575552',
      cap: '#6c6a66',
      blade: '#3f7424',
      flowers: ['#f08a2c', '#f6c13d', '#e8563a'],
      litter: true,
      blades: 1,
    },
    shadow: '#3c2d1e',
    light: { key: '#fff3e6', sky: '#ffffff', ground: '#afaba4' },
    leaves: [
      '#e5512c',
      '#f2c443',
      '#7a2246',
      '#6f9036',
      '#c8282c',
      '#d9781c',
      '#8a4a26',
      '#4a5a2c',
      '#c4688a',
    ],
    rest: '#9c8c7c',
  },
  spring: {
    id: 'spring',
    name: 'Spring blossom',
    bark: '#5b4a46',
    sky: { center: '#fdfbfb', edge: '#e0dadf' },
    ground: {
      grass: '#5e9a36',
      meadow: '#6faa40',
      dirt: '#4d3428',
      soil: '#724f3c',
      stone: '#625956',
      rock: '#5e5956',
      cap: '#726d6a',
      blade: '#4f8c2c',
      flowers: ['#f6a8c6', '#ffffff', '#e26c9a'],
      litter: true,
      blades: 1,
    },
    shadow: '#3a2a35',
    light: { key: '#fff4f2', sky: '#ffffff', ground: '#c4b8bf' },
    leaves: [
      '#f29bbb',
      '#80c45a',
      '#9a7ad0',
      '#6fb0e0',
      '#d2407e',
      '#f5864a',
      '#fbe3ea',
      '#f6cc4a',
      '#3f8a5a',
    ],
    rest: '#867a84',
  },
  summer: {
    id: 'summer',
    name: 'Summer green',
    bark: '#5e4b3c',
    sky: { center: '#fbfcf7', edge: '#d7ddcd' },
    ground: {
      grass: '#3f7f27',
      meadow: '#2f6c20',
      dirt: '#44301f',
      soil: '#664630',
      stone: '#57514b',
      rock: '#53514d',
      cap: '#686662',
      blade: '#2c6a1d',
      flowers: ['#f4d03f', '#ffffff', '#f2b53a'],
      litter: false,
      blades: 1,
    },
    shadow: '#22301c',
    light: { key: '#fff6dc', sky: '#ffffff', ground: '#b3b8a4' },
    leaves: [
      '#4f9a3a',
      '#f2b632',
      '#1f5e37',
      '#2a8a8c',
      '#e0603a',
      '#5a80d0',
      '#a82838',
      '#c070b0',
      '#7a7a2a',
    ],
    rest: '#8c9886',
  },
  winter: {
    id: 'winter',
    name: 'Winter',
    bark: '#55504e',
    sky: { center: '#f6f8fb', edge: '#c9d3de' },
    ground: {
      grass: '#c9d4e0',
      meadow: '#b9c6d4',
      dirt: '#5a4e48',
      soil: '#5e4e44',
      stone: '#4f4c4c',
      rock: '#62666c',
      cap: '#d2dbe6',
      blade: '#24452d',
      flowers: [],
      litter: false,
      blades: 0.35,
    },
    shadow: '#1e2a3a',
    light: { key: '#eef4ff', sky: '#ffffff', ground: '#aeb8c4' },
    leaves: [
      '#6aa2d8',
      '#2f6b55',
      '#b23c52',
      '#d9b04a',
      '#5a6b80',
      '#b4a3d8',
      '#eef3f8',
      '#2d4a7a',
      '#58b4a8',
    ],
    rest: '#86827c',
  },
};

/** What each slot, then the rest, looks like on a typical leaf, so swatches match the tree. */
export function slotColors(palette: Palette): string[] {
  return [...palette.leaves, palette.rest].map((hex) => litColor(hex, palette));
}

/** One legend row: the color, what it stands for, and how many files carry it. */
export type LegendEntry = { color: string; label: string; files: number };

/**
 * Ranks categories by file count, most first, and gives the first `leaves.length` of them
 * the palette's leaf colors in order; the rest share `palette.rest`. Legend rows carry each slot's
 * `slotColors`, as the leaves show it. `slotOf[i]` is the color
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

  const shown = slotColors(palette);
  const named = ranked.slice(0, ramp);
  const tail = ranked.slice(ramp);
  const legend = named.map((c, rank) => ({
    color: shown[rank]!,
    label: c.label,
    files: c.files,
  }));
  if (tail.length > 0) {
    legend.push({
      color: shown[ramp]!,
      label: tail.length === 1 ? tail[0]!.label : `${tail.length} more`,
      files: tail.reduce((sum, c) => sum + c.files, 0),
    });
  }
  return { slotOf, legend };
}
