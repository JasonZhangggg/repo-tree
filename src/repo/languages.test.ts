import { expect, test } from 'vitest';
import { LANGS, langOf } from './languages';

test.each([
  ['kernel/sched/core.c', 'C'],
  ['include/linux/sched.h', 'C'],
  ['rust/kernel/lib.rs', 'Rust'],
  ['tools/perf/scripts/python/sched.py', 'Python'],
  ['scripts/checkpatch.pl', 'Perl'],
  ['scripts/config', 'Other'],
  ['scripts/setlocalversion.sh', 'Shell'],
  ['Makefile', 'Makefile'],
  ['arch/x86/Makefile', 'Makefile'],
  ['drivers/net/Kbuild', 'Makefile'],
  ['init/Kconfig', 'Kconfig'],
  ['arch/arm64/boot/dts/apple/t8103.dtsi', 'Devicetree'],
  ['arch/arm64/boot/dts/apple/t8103-j274.dts', 'Devicetree'],
  ['arch/arm64/boot/dts/ti/k3-am62x-sk-csi2-ov5640.dtso', 'Devicetree'],
  ['arch/x86/entry/entry_64.S', 'Assembly'],
  ['Documentation/admin-guide/README.rst', 'reStructuredText'],
  ['.github/workflows/ci.yml', 'YAML'],
  ['pnpm-workspace.yaml', 'YAML'],
  ['README.md', 'Markdown'],
  ['package.json', 'JSON'],
  ['packages/vite/src/node/server/index.ts', 'TypeScript'],
  ['packages/vite/client.d.mts', 'TypeScript'],
  ['playground/react/App.tsx', 'TSX'],
  ['playground/react/main.jsx', 'JavaScript'],
  ['packages/create-vite/index.js', 'JavaScript'],
  ['eslint.config.mjs', 'JavaScript'],
  ['playground/vue/Main.vue', 'Vue'],
  ['playground/svelte/App.svelte', 'Svelte'],
  ['playground/css/main.css', 'CSS'],
  ['playground/css/sass.scss', 'SCSS'],
  ['playground/css/less.less', 'Less'],
  ['playground/html/index.html', 'HTML'],
  ['Dockerfile', 'Dockerfile'],
  ['docker/app.dockerfile', 'Dockerfile'],
  ['CMakeLists.txt', 'CMake'],
  ['LICENSE-MIT.txt', 'Text'],
  ['.bash_profile', 'Shell'],
  ['.vimrc', 'Vim Script'],
  ['.vim/colors/solarized.vim', 'Vim Script'],
  ['LICENSE', 'Other'],
  ['.gitignore', 'Other'],
  ['archive.tar.gz', 'Other'],
])('%s is %s', (path, lang) => {
  expect(langOf(path)).toBe(lang);
});

test('every extension and filename belongs to one language', () => {
  const owners = new Map<string, string[]>();
  for (const { lang, exts, filenames = [] } of LANGS) {
    for (const key of [...exts.map((e) => `.${e}`), ...filenames]) {
      owners.set(key, [...(owners.get(key) ?? []), lang]);
    }
  }
  const shared = [...owners].filter(([, langs]) => langs.length > 1);
  expect(shared).toEqual([]);
});
