import { describe, expect, test } from 'vitest';
import { constrainedDevice, estimateCompute, megabytes } from './estimate';

describe('estimateCompute', () => {
  test('lands near what the engine measured, and calls Linux big', () => {
    // Head entries (files and folders) and measured downloads with the git fetch: linux 54 MB
    // (a 350 MB tab), vite 1.8 MB.
    const linux = estimateCompute(104_000);
    expect(linux.downloadMB).toBeGreaterThan(45);
    expect(linux.downloadMB).toBeLessThan(65);
    expect(linux.memoryMB).toBeGreaterThan(300);
    expect(linux.big).toBe(true);
    const vite = estimateCompute(3_600);
    expect(vite.downloadMB).toBeGreaterThan(1.5);
    expect(vite.downloadMB).toBeLessThan(5);
    expect(vite.big).toBe(false);
    expect(estimateCompute(50).downloadMB).toBeLessThan(1);
  });
});

describe('constrainedDevice', () => {
  test('a touch screen or 4 GB or less', () => {
    expect(constrainedDevice({ deviceMemory: 8 }, () => false)).toBe(false);
    expect(constrainedDevice({}, () => false)).toBe(false);
    expect(constrainedDevice({ deviceMemory: 4 }, () => false)).toBe(true);
    expect(constrainedDevice({ deviceMemory: 16 }, () => true)).toBe(true);
  });
});

describe('megabytes', () => {
  test('rounds to what a person reads', () => {
    expect(megabytes(0.3)).toBe('under 1 MB');
    expect(megabytes(3.2)).toBe('about 3 MB');
    expect(megabytes(83.4)).toBe('about 85 MB');
  });
});
