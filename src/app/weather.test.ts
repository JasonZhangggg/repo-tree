import { describe, expect, test } from 'vitest';
import { ciHealth, type CiRun } from '../repo/ci';
import { describeWeather, shortVerdict } from './weather';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const runs = (pattern: string): CiRun[] =>
  [...pattern].map((c, i) => ({ passed: c === '.', at: NOW - (i + 2) * HOUR }));
const copy = (pattern: string) => {
  const health = ciHealth(runs(pattern));
  return describeWeather(health.sky, health, NOW);
};

describe('describeWeather', () => {
  test('names the runs behind each sky', () => {
    expect(copy('.'.repeat(20))).toEqual({ verdict: 'CI passing', detail: '20 of 20 recent runs' });
    expect(copy('..x.')).toEqual({ verdict: 'CI mostly passing', detail: '3 of 4 recent runs' });
    expect(copy('x...')).toEqual({ verdict: 'CI failing', detail: 'last run failed 2 hours ago' });
    expect(copy('.x.x.x')).toEqual({ verdict: 'CI flaky', detail: '3 of 6 recent runs' });
    expect(copy('xxxxx.')).toEqual({ verdict: 'CI failing', detail: 'last 5 runs failed' });
    expect(copy('')).toEqual({ verdict: 'No recent CI runs', detail: '' });
    expect(copy('.')).toEqual({ verdict: 'CI passing', detail: '1 of 1 recent run' });
  });

  test('every verdict has a short form that still says CI', () => {
    expect(shortVerdict('CI passing')).toBe('CI passing');
    expect(shortVerdict('CI mostly passing')).toBe('CI mostly ok');
    expect(shortVerdict('No recent CI runs')).toBe('No CI runs');
    expect(shortVerdict('Weather preview')).toBe('Preview');
  });

  test('a preview claims nothing about CI', () => {
    expect(describeWeather('cloudy', null, NOW)).toEqual({
      verdict: 'Weather preview',
      detail: 'partly cloudy',
    });
  });
});
