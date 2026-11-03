import { describe, expect, test } from 'vitest';
import { freeRect, type Rect } from './free-rect';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});
/** A tree a fifth wider than tall, as large as the region allows. */
const fit = (w: number, h: number) => Math.min(h, w / 1.2);
const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('freeRect', () => {
  test('is the whole view when nothing covers it', () => {
    expect(freeRect(800, 600, [], 12, fit)).toEqual(rect(0, 0, 800, 600));
  });

  test('keeps clear of a desktop layout of bar, title card, side panel and controls', () => {
    const panels = [
      rect(20, 16, 1420, 62),
      rect(20, 84, 475, 230),
      rect(1116, 84, 1420, 477),
      rect(24, 840, 536, 880),
    ];
    const free = freeRect(1440, 900, panels, 12, fit);
    for (const panel of panels) expect(overlaps(free, panel)).toBe(false);
    expect(free.bottom - free.top).toBeGreaterThan(500);
    expect(free.right).toBeLessThanOrEqual(1116 - 12);
  });

  test('on a phone is the band between the header and the sheet', () => {
    const header = rect(12, 12, 378, 106);
    const sheet = rect(0, 720, 390, 844);
    expect(freeRect(390, 844, [header, sheet], 10, fit)).toEqual(rect(0, 116, 390, 710));
  });

  test('when a panel covers everything, falls back to the whole view', () => {
    expect(freeRect(400, 300, [rect(0, 0, 400, 300)], 0, fit)).toEqual(rect(0, 0, 400, 300));
  });
});
