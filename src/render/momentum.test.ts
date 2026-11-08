import { describe, expect, test } from 'vitest';
import {
  band,
  coast,
  project,
  pushSample,
  releaseVelocity,
  rubberband,
  springStep,
  unband,
  type Sample,
} from './momentum';

describe('releaseVelocity', () => {
  const drag = (speed: number, until: number): Sample[] => {
    const samples: Sample[] = [];
    for (let t = 0; t <= until; t += 16) pushSample(samples, { at: t * speed, t });
    return samples;
  };

  test('reads the speed of the last stretch of a drag', () => {
    expect(releaseVelocity(drag(2, 320), 330)).toBeCloseTo(2, 5);
  });

  test('a finger that held still before lifting throws nothing', () => {
    expect(releaseVelocity(drag(2, 320), 320 + 120)).toBe(0);
  });

  test('a release sample where the finger stopped brings the speed down', () => {
    const samples = drag(2, 320);
    pushSample(samples, { at: 320 * 2, t: 400 });
    expect(releaseVelocity(samples, 400)).toBeLessThan(1);
  });

  test('keeps only recent samples', () => {
    expect(drag(1, 2000).length).toBeLessThan(15);
  });
});

test('a throw carries further the faster it goes', () => {
  expect(project(0)).toBe(0);
  expect(project(1)).toBeCloseTo(499, 0);
  expect(project(-1, 0.99)).toBeCloseTo(-99, 0);
});

describe('rubber-banding', () => {
  test('gives less the further it is pulled, and never past its limit', () => {
    expect(rubberband(0, 40)).toBe(0);
    const near = rubberband(20, 40);
    const far = rubberband(2000, 40);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(20);
    expect(far).toBeLessThan(40);
    expect(rubberband(-20, 40)).toBe(-near);
  });

  test('band clamps softly on both sides and unband undoes it', () => {
    expect(band(5, 0, 10, 2)).toBe(5);
    expect(band(14, 0, 10, 2)).toBeLessThan(12);
    expect(band(-4, 0, 10, 2)).toBeGreaterThan(-2);
    for (const raw of [-6, -1, 3, 10, 11, 30]) {
      expect(unband(band(raw, 0, 10, 2), 0, 10, 2)).toBeCloseTo(raw, 6);
    }
  });
});

describe('coast', () => {
  const run = (f: { x: number; v: number }, opts: Parameters<typeof coast>[2], fps = 60) => {
    let frames = 0;
    let furthest = f.x;
    while (coast(f, 1 / fps, opts) && frames < 2000) {
      frames++;
      furthest = Math.max(furthest, f.x);
    }
    return { frames, furthest };
  };

  test('slows a throw to rest about v·tau further on, at any frame rate', () => {
    const slow = { x: 0, v: 2 };
    const fast = { x: 0, v: 2 };
    run(slow, { tau: 0.4 }, 30);
    run(fast, { tau: 0.4 }, 144);
    expect(slow.x).toBeCloseTo(0.8, 1);
    expect(fast.x).toBeCloseTo(slow.x, 2);
  });

  test('a throw into an edge sinks past it a little and settles on it', () => {
    const f = { x: 0.9, v: 3 };
    const { furthest } = run(f, { hi: 1, tau: 0.4, response: 0.4 });
    expect(furthest).toBeGreaterThan(1);
    expect(furthest).toBeLessThan(1.2);
    expect(f.x).toBe(1);
    expect(f.v).toBe(0);
  });

  test('something left past an edge springs back to it', () => {
    const f = { x: -0.3, v: 0 };
    run(f, { lo: 0 });
    expect(f.x).toBe(0);
  });
});

test('a spring carries a release on at its speed and rests on its goal', () => {
  const f = { x: 0, v: 3000 };
  springStep(f, 100, 1 / 60, { response: 0.4 });
  expect(f.x).toBeGreaterThan(30);
  let frames = 0;
  while (springStep(f, 100, 1 / 60, { response: 0.4 }) && frames < 600) frames++;
  expect(f.x).toBe(100);
  expect(frames).toBeLessThan(120);
});
