import { describe, expect, test } from 'vitest';
import { parseRepoRef, type RepoRef } from '../repo/ref';
import { formatLink, parseLink, type ViewLink } from './link';

const ref = (input: string) => parseRepoRef(input) as RepoRef;

describe('share links', () => {
  test('reads the example from the plan', () => {
    expect(parseLink('#/torvalds/linux?palette=winter&sel=arch/mips')).toEqual({
      ref: ref('torvalds/linux'),
      palette: 'winter',
      sel: 'arch/mips',
    });
  });

  test('writes folder paths and branches readably', () => {
    const link: ViewLink = {
      ref: ref('https://github.com/acme/web/tree/feature/x'),
      palette: 'spring',
      colorBy: 'folder',
      sel: 'src/app ui',
    };
    expect(formatLink(link)).toBe(
      '#/acme/web?branch=feature/x&palette=spring&colorBy=folder&sel=src/app%20ui',
    );
  });

  test.each<ViewLink>([
    { ref: ref('vitejs/vite') },
    { ref: ref('vitejs/vite'), colorBy: 'folder' },
    { ref: ref('github.com/a-b/c.d/tree/release/1.0'), palette: 'summer', sel: 'pkg/x&y=z' },
  ])('round-trips %j', (link) => {
    expect(parseLink(formatLink(link))).toEqual(link);
  });

  test('ignores unknown values and rejects a hash without a repo', () => {
    expect(parseLink('#/a/b?palette=neon&colorBy=size')).toEqual({ ref: ref('a/b') });
    expect(parseLink('')).toBeNull();
    expect(parseLink('#/just-owner')).toBeNull();
    expect(parseLink('#/a/b/c')).toBeNull();
  });
});
