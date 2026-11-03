export type Lang = string & { readonly __brand: 'Lang' };

type LangSpec = { lang: Lang; exts: string[]; filenames?: string[] };

const spec = (lang: string, exts: string[], filenames?: string[]): LangSpec => ({
  lang: lang as Lang,
  exts,
  filenames,
});

export const OTHER = 'Other' as Lang;

export const LANGS: ReadonlyArray<LangSpec> = [
  spec('C', ['c', 'h']),
  spec('C++', ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'h++', 'ipp', 'tpp']),
  spec('C#', ['cs', 'csx']),
  spec('Objective-C', ['m']),
  spec('Objective-C++', ['mm']),
  spec('Java', ['java']),
  spec('Kotlin', ['kt', 'kts']),
  spec('Scala', ['scala', 'sc']),
  spec('Groovy', ['groovy', 'gradle']),
  spec('Swift', ['swift']),
  spec('Go', ['go']),
  spec('Rust', ['rs']),
  spec('Zig', ['zig']),
  spec('Nim', ['nim']),
  spec('Dart', ['dart']),
  spec('Python', ['py', 'pyi', 'pyw']),
  spec('Ruby', ['rb', 'rake', 'gemspec'], ['Gemfile', 'Rakefile']),
  spec('PHP', ['php']),
  spec('Perl', ['pl', 'pm']),
  spec('Lua', ['lua']),
  spec('R', ['r']),
  spec('Julia', ['jl']),
  spec('Haskell', ['hs']),
  spec('OCaml', ['ml', 'mli']),
  spec('F#', ['fs', 'fsi', 'fsx']),
  spec('Elixir', ['ex', 'exs']),
  spec('Erlang', ['erl', 'hrl']),
  spec('Clojure', ['clj', 'cljs', 'cljc', 'edn']),
  spec('Elm', ['elm']),
  spec('Emacs Lisp', ['el']),
  spec('Solidity', ['sol']),
  spec('TypeScript', ['ts', 'mts', 'cts']),
  spec('TSX', ['tsx']),
  spec('JavaScript', ['js', 'mjs', 'cjs', 'jsx']),
  spec('CoffeeScript', ['coffee']),
  spec('Vue', ['vue']),
  spec('Svelte', ['svelte']),
  spec('Astro', ['astro']),
  spec('HTML', ['html', 'htm']),
  spec('CSS', ['css']),
  spec('SCSS', ['scss']),
  spec('Sass', ['sass']),
  spec('Less', ['less']),
  spec('Stylus', ['styl']),
  spec('SVG', ['svg']),
  spec('JSON', ['json', 'jsonc', 'json5']),
  spec('YAML', ['yml', 'yaml']),
  spec('TOML', ['toml']),
  spec('XML', ['xml', 'xsd', 'xsl']),
  spec('Markdown', ['md', 'markdown']),
  spec('MDX', ['mdx']),
  spec('reStructuredText', ['rst']),
  spec('TeX', ['tex', 'sty']),
  spec('Text', ['txt']),
  spec('Jupyter Notebook', ['ipynb']),
  spec('SQL', ['sql']),
  spec('GraphQL', ['graphql', 'gql']),
  spec('Protocol Buffer', ['proto']),
  spec('HCL', ['tf', 'hcl']),
  spec('Nix', ['nix']),
  spec(
    'Shell',
    ['sh', 'bash', 'zsh', 'ksh'],
    ['.bashrc', '.bash_profile', '.bash_logout', '.profile', '.zshrc', '.zprofile', '.zshenv'],
  ),
  spec('Fish', ['fish']),
  spec('PowerShell', ['ps1', 'psm1', 'psd1']),
  spec('Batchfile', ['bat', 'cmd']),
  spec('Vim Script', ['vim'], ['.vimrc', '.gvimrc']),
  spec('Makefile', ['mk', 'mak'], ['Makefile', 'makefile', 'GNUmakefile', 'Kbuild']),
  spec('CMake', ['cmake'], ['CMakeLists.txt']),
  spec('Dockerfile', ['dockerfile'], ['Dockerfile', 'Containerfile']),
  spec('Kconfig', [], ['Kconfig']),
  spec('Devicetree', ['dts', 'dtsi', 'dtso']),
  spec('Assembly', ['s', 'asm']),
  spec('AWK', ['awk']),
  spec('Diff', ['diff', 'patch']),
];

const byFilename = new Map<string, Lang>();
const byExt = new Map<string, Lang>();
for (const { lang, exts, filenames = [] } of LANGS) {
  for (const ext of exts) byExt.set(ext, lang);
  for (const name of filenames) byFilename.set(name, lang);
}

export function langOf(path: string): Lang {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const exact = byFilename.get(name);
  if (exact) return exact;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return OTHER;
  return byExt.get(name.slice(dot + 1).toLowerCase()) ?? OTHER;
}
