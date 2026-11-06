import { describe, expect, it } from 'vitest';
import { birdUniforms, treeUniforms } from './shaders';
import { claimUniforms, releaseUniforms } from './uniform-owner';

describe('claimUniforms', () => {
  it('gives each view its own uniform values', () => {
    const a = {};
    const b = {};
    claimUniforms(a);
    treeUniforms.uSel.value = [3, 9];
    birdUniforms.uBirdMotion.value = 0;
    claimUniforms(b);
    expect(treeUniforms.uSel.value).toEqual([-1, -1]);
    expect(birdUniforms.uBirdMotion.value).toBe(1);
    treeUniforms.uGrow.value = 0.5;
    claimUniforms(a);
    expect(treeUniforms.uSel.value).toEqual([3, 9]);
    expect(birdUniforms.uBirdMotion.value).toBe(0);
    expect(treeUniforms.uGrow.value).toBe(1);
    claimUniforms(b);
    expect(treeUniforms.uGrow.value).toBe(0.5);
    releaseUniforms(a);
    releaseUniforms(b);
  });

  it('keeps the same uniform objects, so materials holding them see the change', () => {
    const sel = treeUniforms.uSel;
    claimUniforms({});
    expect(treeUniforms.uSel).toBe(sel);
  });
});
