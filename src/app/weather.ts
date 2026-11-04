import type { CiHealth, Sky } from '../repo/ci';
import { ago, count } from './format';

/** The weather chip's words: a short verdict, then the runs behind it. */
export type WeatherCopy = { verdict: string; detail: string };

const SKY_NAME: Record<Sky, string> = {
  clear: 'clear',
  sunny: 'sunny',
  cloudy: 'partly cloudy',
  rain: 'rain',
  storm: 'storm',
};

/**
 * Says what the weather stands for. With no health it is a preview from a link, which claims
 * nothing about the repo's CI.
 */
export function describeWeather(sky: Sky, health: CiHealth | null, now: number): WeatherCopy {
  if (!health) return { verdict: 'Weather preview', detail: SKY_NAME[sky] };
  const { runs, passed, streak, latest } = health;
  const tally = `${count(passed)} of ${count(runs)} recent ${runs === 1 ? 'run' : 'runs'}`;
  switch (sky) {
    case 'clear':
      return { verdict: 'No recent CI runs', detail: '' };
    case 'sunny':
      return { verdict: 'CI passing', detail: tally };
    case 'cloudy':
      return { verdict: 'CI mostly passing', detail: tally };
    case 'rain':
      return streak > 0 && latest
        ? { verdict: 'CI failing', detail: `last run failed ${ago(latest.at, now)}` }
        : { verdict: 'CI flaky', detail: tally };
    case 'storm':
      return { verdict: 'CI failing', detail: `last ${count(streak)} runs failed` };
  }
}
