import { describe, expect, test } from 'vitest';
import { parseRepoRef } from './ref';

describe('parseRepoRef accepts', () => {
  test.each([
    ['vitejs/vite', { owner: 'vitejs', repo: 'vite' }],
    ['  vitejs/vite \n', { owner: 'vitejs', repo: 'vite' }],
    ['expressjs / express', { owner: 'expressjs', repo: 'express' }],
    ['vitejs /vite', { owner: 'vitejs', repo: 'vite' }],
    ['https://github.com/vitejs/vite', { owner: 'vitejs', repo: 'vite' }],
    ['https://github.com/vitejs/vite/', { owner: 'vitejs', repo: 'vite' }],
    ['https://github.com/vitejs/vite.git', { owner: 'vitejs', repo: 'vite' }],
    ['http://www.github.com/vitejs/vite', { owner: 'vitejs', repo: 'vite' }],
    ['github.com/vitejs/vite', { owner: 'vitejs', repo: 'vite' }],
    ['https://github.com/vitejs/vite?tab=readme#top', { owner: 'vitejs', repo: 'vite' }],
    ['https://github.com/vitejs/vite/pulls', { owner: 'vitejs', repo: 'vite' }],
    [
      'https://github.com/vitejs/vite/tree/v6.0.0',
      { owner: 'vitejs', repo: 'vite', ref: 'v6.0.0' },
    ],
    [
      'https://github.com/vitejs/vite/tree/feat/css-modules/',
      { owner: 'vitejs', repo: 'vite', ref: 'feat/css-modules' },
    ],
    ['https://github.com/o/r/tree/fix%23123', { owner: 'o', repo: 'r', ref: 'fix#123' }],
    ['torvalds/linux.git', { owner: 'torvalds', repo: 'linux' }],
    ['a-b-c/.github', { owner: 'a-b-c', repo: '.github' }],
    ['Some-User9/my_repo.v2', { owner: 'Some-User9', repo: 'my_repo.v2' }],
    [`${'a'.repeat(39)}/${'r'.repeat(100)}`, { owner: 'a'.repeat(39), repo: 'r'.repeat(100) }],
  ])('%j', (input, expected) => {
    expect(parseRepoRef(input)).toEqual(expected);
  });
});

describe('parseRepoRef rejects', () => {
  test.each([
    '',
    '   ',
    'vite',
    'vitejs/',
    '/vite',
    'vitejs/vite/extra',
    '-vitejs/vite',
    'vite_js/vite',
    `${'a'.repeat(40)}/vite`,
    `vitejs/${'r'.repeat(101)}`,
    'vitejs/..',
    'vitejs/.',
    'vitejs/vi te',
    'https://gitlab.com/vitejs/vite',
    'https://github.com/vitejs',
    'https://github.com/vitejs/vite/tree/',
    'https://github.com/vitejs/vite/tree/%E0%A4%A',
  ])('%j', (input) => {
    expect(parseRepoRef(input)).toEqual({ kind: 'invalid-ref' });
  });
});
