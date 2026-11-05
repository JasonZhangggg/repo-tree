import { describe, expect, test } from 'vitest';
import { autoQuality, DEFAULT_SETTINGS, parseSettings } from './settings';

describe('parseSettings', () => {
  test('reads a first visit as the defaults', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  test("takes a first visit's theme from the system, then keeps the stored one", () => {
    expect(parseSettings(null, true).theme).toBe('dark');
    expect(parseSettings('{"theme":"light"}', true).theme).toBe('light');
    expect(parseSettings('{"theme":"dusk"}').theme).toBe('light');
  });

  test('falls back to the defaults on bad JSON', () => {
    expect(parseSettings('{"palette": "winter",')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"winter"')).toEqual(DEFAULT_SETTINGS);
  });

  test('keeps valid fields and replaces malformed ones', () => {
    const settings = parseSettings(
      JSON.stringify({
        palette: 'winter',
        colorBy: 'size',
        quality: 'low',
        spin: 'yes',
        labels: false,
        ground: false,
        weather: 'off',
        hotspots: true,
        hidden: ['dist', 7],
        token: 'ghp_x',
      }),
    );
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      palette: 'winter',
      quality: 'low',
      labels: false,
      ground: false,
      hotspots: true,
      token: 'ghp_x',
    });
  });
});

test('auto quality follows the device', () => {
  expect(autoQuality({ pixelRatio: 2, cores: 10 })).toBe('high');
  expect(autoQuality({ pixelRatio: 3, cores: 8 })).toBe('medium');
  expect(autoQuality({ pixelRatio: 1, cores: 2 })).toBe('low');
});
