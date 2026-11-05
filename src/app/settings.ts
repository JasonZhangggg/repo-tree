import type { Quality } from '../grow/grow';
import { DEFAULT_FILTERS } from '../repo/hierarchy';
import { PALETTES, type ColorBy, type PaletteId } from '../render/palette';

export type QualitySetting = 'auto' | Quality;
export type Theme = 'light' | 'dark';
export type Settings = {
  palette: PaletteId;
  colorBy: ColorBy;
  quality: QualitySetting;
  spin: boolean;
  labels: boolean;
  growAnim: boolean;
  ground: boolean;
  /** Sky and weather from the repo's recent GitHub Actions runs. */
  weather: boolean;
  /** The busiest files glow, from the repo's commit history. */
  hotspots: boolean;
  /** Light shows the day: dark turns the sky to night, the sun to a moon and the panels dark. */
  theme: Theme;
  hidden: string[];
  /** A GitHub token, kept in this browser and sent only to api.github.com. */
  token: string;
};

export const DEFAULT_SETTINGS: Settings = {
  palette: 'autumn',
  colorBy: 'language',
  quality: 'auto',
  spin: true,
  labels: true,
  growAnim: true,
  ground: true,
  weather: true,
  hotspots: false,
  theme: 'light',
  hidden: [...DEFAULT_FILTERS.hidden],
  token: '',
};

export const PALETTE_IDS = Object.keys(PALETTES) as PaletteId[];
export const COLOR_BYS: readonly ColorBy[] = ['language', 'folder', 'activity', 'changes', 'owner'];
export const THEMES: readonly Theme[] = ['light', 'dark'];
export const QUALITIES: readonly QualitySetting[] = ['auto', 'low', 'medium', 'high'];

const oneOf = <T>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/**
 * Reads stored settings; anything missing or malformed falls back to its default. A first visit
 * takes its theme from the system (`prefersDark`).
 */
export function parseSettings(raw: string | null, prefersDark = false): Settings {
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    if (typeof value === 'object' && value !== null) stored = value as Record<string, unknown>;
  } catch {
    // Corrupt storage reads as a first visit.
  }
  const d = DEFAULT_SETTINGS;
  const hidden = stored.hidden;
  return {
    palette: oneOf(PALETTE_IDS, stored.palette, d.palette),
    colorBy: oneOf(COLOR_BYS, stored.colorBy, d.colorBy),
    quality: oneOf(QUALITIES, stored.quality, d.quality),
    spin: bool(stored.spin, d.spin),
    labels: bool(stored.labels, d.labels),
    growAnim: bool(stored.growAnim, d.growAnim),
    ground: bool(stored.ground, d.ground),
    weather: bool(stored.weather, d.weather),
    hotspots: bool(stored.hotspots, d.hotspots),
    theme: oneOf(THEMES, stored.theme, prefersDark ? 'dark' : d.theme),
    hidden: Array.isArray(hidden) && hidden.every((h) => typeof h === 'string') ? hidden : d.hidden,
    token: typeof stored.token === 'string' ? stored.token : d.token,
  };
}

/** The starting tier for 'auto', from what the device says about itself. */
export function autoQuality(device: { pixelRatio: number; cores: number }): Quality {
  if (device.cores >= 8 && device.pixelRatio <= 2) return 'high';
  if (device.cores >= 4) return 'medium';
  return 'low';
}

export const STEP_DOWN: Record<Quality, Quality> = { high: 'medium', medium: 'low', low: 'low' };
