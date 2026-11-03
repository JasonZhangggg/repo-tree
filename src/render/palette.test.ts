import { describe, expect, test } from 'vitest';
import { deltaE, litColor } from './color';
import { leafMapping, PALETTES, slotColors } from './palette';

const autumn = PALETTES.autumn;
const ramp = autumn.leaves.length;
const shown = slotColors(autumn);
const langs = (...files: number[]) => files.map((n, i) => ({ label: `L${i}`, files: n }));

describe('leafMapping', () => {
  test('gives every palette a ramp of the same length, so slots survive a palette switch', () => {
    for (const palette of Object.values(PALETTES)) expect(palette.leaves).toHaveLength(ramp);
  });

  test('gives the most common categories the ramp colors in order', () => {
    const { slotOf, legend } = leafMapping(langs(5, 40, 12), autumn);

    expect(slotOf).toEqual([2, 0, 1]);
    expect(legend).toEqual([
      { color: shown[0], label: 'L1', files: 40 },
      { color: shown[1], label: 'L2', files: 12 },
      { color: shown[2], label: 'L0', files: 5 },
    ]);
  });

  test('colors a repo of unrecognized files from the ramp, not the muted rest', () => {
    const { legend } = leafMapping(
      [
        { label: 'Other', files: 25 },
        { label: 'Shell', files: 4 },
      ],
      autumn,
    );

    expect(legend.map((l) => l.color)).toEqual([shown[0], shown[1]]);
  });

  test('folds the long tail into one muted slot with one legend row', () => {
    const counts = langs(...Array.from({ length: ramp + 3 }, (_, i) => 100 - i));
    const { slotOf, legend } = leafMapping(counts, autumn);

    expect(slotOf.slice(ramp)).toEqual([ramp, ramp, ramp]);
    expect(legend).toHaveLength(ramp + 1);
    expect(legend.at(-1)).toEqual({
      color: shown[ramp],
      label: '3 more',
      files: counts.slice(ramp).reduce((sum, c) => sum + c.files, 0),
    });
  });

  test('names a tail of one by its own label', () => {
    const { legend } = leafMapping(langs(...Array.from({ length: ramp + 1 }, () => 1)), autumn);

    expect(legend.at(-1)?.label).toBe(`L${ramp}`);
  });

  test('maps the same counts the same way whatever order they arrive in', () => {
    const counts = langs(3, 3, 9, 1);
    const shuffled = [counts[2]!, counts[0]!, counts[3]!, counts[1]!];

    expect(leafMapping(shuffled, autumn).legend).toEqual(leafMapping(counts, autumn).legend);
  });
});

/**
 * CIEDE2000 floors between leaf colors as they show on the tree. The biggest categories take the
 * first six slots, so those need the widest gaps.
 */
const APART = { top: 15, named: 10, rest: 12, bark: 10 };

describe.each(Object.values(PALETTES))('$name leaves', (palette) => {
  const lit = slotColors(palette);
  const named = lit.slice(0, ramp);

  test('keep every pair of named slots apart, the first six furthest', () => {
    for (let i = 0; i < ramp; i++) {
      for (let j = i + 1; j < ramp; j++) {
        const floor = j < 6 ? APART.top : APART.named;
        expect(deltaE(named[i]!, named[j]!), `slots ${i + 1} and ${j + 1}`).toBeGreaterThanOrEqual(
          floor,
        );
      }
    }
  });

  test('keep the shared rest color and the bark apart from every slot', () => {
    const bark = litColor(palette.bark, palette);
    named.forEach((color, i) => {
      expect(deltaE(color, lit[ramp]!), `slot ${i + 1} and rest`).toBeGreaterThanOrEqual(
        APART.rest,
      );
      expect(deltaE(color, bark), `slot ${i + 1} and bark`).toBeGreaterThanOrEqual(APART.bark);
    });
  });
});
