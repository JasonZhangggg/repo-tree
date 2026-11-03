import { expect, test } from 'vitest';
import { deltaE } from './color';

test('measures CIEDE2000 the way published reference values do', () => {
  expect(deltaE('#ffffff', '#000000')).toBeCloseTo(100, 1);
  expect(deltaE('#ff0000', '#00ff00')).toBeCloseTo(86.61, 1);
  expect(deltaE('#ff0000', '#0000ff')).toBeCloseTo(52.88, 1);
  expect(deltaE('#e5512c', '#e5512c')).toBe(0);
});
