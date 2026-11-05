import { describe, expect, test } from 'vitest';
import { growGround, KIND } from '../grow/ground';
import { swayOf } from './ground';

describe('swayOf', () => {
  const { cover } = growGround({ trunk: 0.3, front: 0, rocks: [] }, { seed: 7, quality: 'medium' });
  const sway = swayOf(cover);

  test('bends grass from its root: the root holds still and the tip sways most', () => {
    for (let v = 0; v < cover.blades; v += 3) {
      const ys = [1, 4, 7].map((o) => cover.position[3 * v + o]!);
      const tip = ys.indexOf(Math.max(...ys));
      expect(Math.min(sway[v]!, sway[v + 1]!, sway[v + 2]!)).toBe(0);
      expect(sway[v + tip]).toBeGreaterThan(0);
    }
  });

  test("moves a flower's head as one with its stem's tip, and leaves fallen leaves still", () => {
    for (let v = 0; v < cover.kind.length; v += 3) {
      if (cover.kind[v] === KIND.flower) {
        expect(sway[v]).toBeGreaterThan(0);
        expect(sway[v + 1]).toBe(sway[v]);
      }
      if (cover.kind[v] === KIND.litter) expect(sway[v]).toBe(0);
    }
  });
});
