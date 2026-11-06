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

  test('reads and writes the repo compared beside it, and drops a malformed one', () => {
    const link = { ref: ref('vitejs/vite'), vs: ref('mathiasbynens/dotfiles') };
    expect(formatLink(link)).toBe('#/vitejs/vite?vs=mathiasbynens/dotfiles');
    expect(parseLink(formatLink(link))).toEqual(link);
    expect(parseLink('#/vitejs/vite?vs=nope')).toEqual({ ref: ref('vitejs/vite') });
    const first = { ...link, vsFirst: true };
    expect(formatLink(first)).toBe('#/vitejs/vite?vs=mathiasbynens/dotfiles&vsfirst=1');
    expect(parseLink(formatLink(first))).toEqual(first);
    expect(parseLink('#/vitejs/vite?vsfirst=1')).toEqual({ ref: ref('vitejs/vite') });
  });

  test('reads a weather preview and drops an unknown one', () => {
    expect(parseLink('#/vitejs/vite?wx=storm')).toEqual({ ref: ref('vitejs/vite'), wx: 'storm' });
    expect(parseLink('#/vitejs/vite?wx=hail')).toEqual({ ref: ref('vitejs/vite') });
    expect(formatLink({ ref: ref('vitejs/vite'), palette: 'winter', wx: 'rain' })).toBe(
      '#/vitejs/vite?palette=winter&wx=rain',
    );
  });

  test('reads a timeline date by day, month or year, and writes it by day', () => {
    const at = (t: string) => parseLink(`#/vitejs/vite?t=${t}`)?.t;
    expect(at('2015-03')).toBe(Date.UTC(2015, 2, 1));
    expect(at('2015-03-17')).toBe(Date.UTC(2015, 2, 17));
    expect(at('2015')).toBe(Date.UTC(2015, 0, 1));
    expect(at('2015-13')).toBeUndefined();
    expect(at('yesterday')).toBeUndefined();
    expect(formatLink({ ref: ref('vitejs/vite'), t: Date.UTC(2021, 10, 2, 15, 30) })).toBe(
      '#/vitejs/vite?t=2021-11-02',
    );
  });

  test('carries the pin tray as one pin per folder, commas and all', () => {
    const link: ViewLink = { ref: ref('vitejs/vite'), pins: ['packages/vite', 'docs/a,b'] };
    const hash = formatLink(link);
    expect(hash).toBe('#/vitejs/vite?pin=packages/vite&pin=docs/a%2Cb');
    expect(parseLink(hash)).toEqual(link);
    expect(parseLink('#/vitejs/vite?pin=')).toEqual({ ref: ref('vitejs/vite') });
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
    { ref: ref('vitejs/vite'), colorBy: 'folder', hl: '12 more' },
    { ref: ref('vitejs/vite'), sel: 'packages', t: Date.UTC(2022, 4, 9) },
  ])('round-trips %j', (link) => {
    expect(parseLink(formatLink(link))).toEqual(link);
  });

  test('reads and writes a highlighted legend entry by its label', () => {
    const link: ViewLink = { ref: ref('torvalds/linux'), colorBy: 'language', hl: 'C++' };
    expect(formatLink(link)).toBe('#/torvalds/linux?colorBy=language&hl=C%2B%2B');
    expect(parseLink('#/torvalds/linux?colorBy=language&hl=C')).toEqual({
      ref: ref('torvalds/linux'),
      colorBy: 'language',
      hl: 'C',
    });
  });

  test('ignores unknown values and rejects a hash without a repo', () => {
    expect(parseLink('#/a/b?palette=neon&colorBy=size')).toEqual({ ref: ref('a/b') });
    expect(parseLink('')).toBeNull();
    expect(parseLink('#/just-owner')).toBeNull();
    expect(parseLink('#/a/b/c')).toBeNull();
  });
});
