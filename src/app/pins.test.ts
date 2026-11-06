import { describe, expect, test } from 'vitest';
import { addPin, MAX_PINS, mergePins, removePin } from './pins';

describe('pinned folders', () => {
  test('a new pin joins the end and one already there keeps its place', () => {
    expect(addPin(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(addPin(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
    expect(addPin(['a'], '')).toEqual(['a']);
  });

  test('keeps the newest MAX_PINS', () => {
    const many = Array.from({ length: MAX_PINS }, (_, i) => `f${i}`);
    expect(addPin(many, 'new')).toEqual([...many.slice(1), 'new']);
  });

  test('removes one, and merges a link into the stored ones', () => {
    expect(removePin(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(mergePins(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
