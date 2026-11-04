import { litColor } from './color';

export type PaletteId = 'autumn' | 'spring' | 'summer' | 'winter';
/**
 * `activity`, `changes` and `owner` need the repo's history: leaves take how long ago their files
 * changed, how often they changed, or who owns their top-level folder.
 */
export type ColorBy = 'language' | 'folder' | 'activity' | 'changes' | 'owner';

/**
 * Leaf colors for `activity`, one per timeline/facts.ts AGES band and the same in every palette:
 * spring green for this month, autumn orange for this year, brown for older. Dead wood drops its
 * leaves, so its cool grey shows only in the legend and while that entry is highlighted.
 */
export const AGE_COLORS: readonly string[] = ['#6fb43f', '#ec8a2c', '#94603a', '#98a0a8'];
/**
 * Leaf colors for `changes`, one per timeline/facts.ts CHANGES band and the same in every palette:
 * a hot red for the busiest files, cooling through orange and gold to a quiet blue-grey.
 */
export const CHANGE_COLORS: readonly string[] = ['#d1352a', '#f08a24', '#f2c64a', '#9fb4c2'];
/** Bark of a branch whose every leaf is dead wood: weathered silver-grey. */
export const DEAD_BARK = '#a59f97';

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
  /** What falls from a rain or storm sky. */
  precip: 'rain' | 'snow';
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
      '#c2302c',
      '#f3a13a',
      '#a8385c',
      '#ead27c',
      '#f07a36',
      '#8f3b1d',
      '#ff8f5a',
    ],
    rest: '#c9a98a',
    precip: 'rain',
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
    precip: 'rain',
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
    precip: 'rain',
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
      '#a9c8e4',
      '#ffffff',
      '#6f9cc6',
      '#d6e4f0',
      '#8fb0c8',
      '#4f7aa6',
      '#e9eef7',
      '#c7bde0',
      '#b23c52',
    ],
    rest: '#bcc6cf',
    precip: 'snow',
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
