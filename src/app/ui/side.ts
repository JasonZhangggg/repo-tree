import { langOf } from '../../repo/languages';
import { leafMapping, PALETTES, slotColors, type PaletteId } from '../../render/palette';
import { TOP_LANGS } from '../../load/repo-index';
import { githubUrl, nameOf, type App } from '../app';
import { byId, fill, h, icon, ICONS } from '../dom';
import { bytes, count, percent, plural } from '../format';
import type { AppState, Repo } from '../state';

const FOLDER_ROWS = 10;
const SUB_ROWS = 5;

/** Children of a folder, most files first. */
export function childrenOf(repo: Repo, folder: number): number[] {
  const { parent, files } = repo.index.folders;
  const kids: number[] = [];
  for (let f = folder + 1; f < parent.length; f++) if (parent[f] === folder) kids.push(f);
  return kids.sort((a, b) => files[b]! - files[a]!);
}

function langColors(repo: Repo, palette: PaletteId): Map<string, string> {
  const p = PALETTES[palette];
  const { slotOf } = leafMapping(
    repo.tree.langs.map((l) => ({ label: l.lang, files: l.files })),
    p,
  );
  const shown = slotColors(p);
  return new Map(repo.tree.langs.map((l, i) => [l.lang, shown[slotOf[i]!]!]));
}

export function mountSide(app: App): void {
  const { store, view } = app;
  const side = byId('side');
  const toggle = byId('sheet-toggle');
  const sheetTitle = byId('sheet-title');
  const sheetStat = byId('sheet-stat');
  const sheetClear = byId('sheet-clear');
  const folders = byId('folders');
  const legend = byId('legend');
  const legendTitle = byId('legend-title');
  const detail = byId('detail');

  const setOpen = (open: boolean) => {
    side.toggleAttribute('data-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(!side.hasAttribute('data-open')));
  sheetClear.addEventListener('click', () => app.select(null));

  const pick = (folder: number) => app.select({ folder }, true);

  folders.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...folders.querySelectorAll('button')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    items[
      Math.max(0, Math.min(items.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))
    ]!.focus();
  });

  const renderFolders = (state: AppState) => {
    const repo = state.repo!;
    const colors = langColors(repo, state.settings.palette);
    const byFolder = new Map(view.legend().map((e) => [e.label, e.color]));
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const { files, langs } = repo.index.folders;
    const tops = childrenOf(repo, 0);
    const most = files[tops[0] ?? 0] || 1;
    const colorOf = (f: number) =>
      state.settings.colorBy === 'folder'
        ? (byFolder.get(repo.tree.folders.path[f]!) ?? rest)
        : (colors.get(repo.index.langs[langs[f * TOP_LANGS * 2]!]!) ?? rest);
    folders.replaceChildren(
      ...tops.slice(0, FOLDER_ROWS).map((f) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              'data-folder': f,
              'aria-current': String(state.selection?.folder === f),
              onclick: () => pick(f),
              onpointerenter: () => app.hover(f),
              onpointerleave: () => app.hover(null),
              onfocus: () => app.hover(f),
              onblur: () => app.hover(null),
            },
            h('span', { class: 'fn' }, `${nameOf(repo.tree.folders.path[f]!)}/`),
            h(
              'span',
              { class: 'bar-track', 'aria-hidden': 'true' },
              h('i', {
                style: `width:${Math.max(3, (files[f]! / most) * 100)}%;--c:${colorOf(f)}`,
              }),
            ),
            h('span', { class: 'num' }, count(files[f]!)),
          ),
        ),
      ),
    );
    if (tops.length > FOLDER_ROWS) {
      folders.append(
        h(
          'li',
          {},
          h('p', { class: 'more' }, `and ${plural(tops.length - FOLDER_ROWS, 'more folder')}`),
        ),
      );
    }
    if (tops.length === 0)
      folders.append(h('li', {}, h('p', { class: 'more' }, 'Every file sits at the top level.')));
  };

  const renderLegend = (state: AppState) => {
    const repo = state.repo!;
    const byFolder = state.settings.colorBy === 'folder';
    legendTitle.textContent = byFolder ? 'Leaf colors by folder' : 'Leaf colors by language';
    legend.replaceChildren(
      ...view.legend().map(({ color, label, files }, _, all) => {
        const folder = byFolder ? repo.folderIds.get(label) : undefined;
        const parts = [
          h('i', { class: 'swatch', style: `--c:${color}` }),
          h('span', { title: label }, byFolder && folder !== undefined ? `${label}/` : label),
          h(
            'span',
            { class: 'num', title: count(files) },
            percent(
              files,
              all.reduce((sum, e) => sum + e.files, 0),
            ),
          ),
        ];
        return h(
          'li',
          {},
          ...(folder === undefined
            ? parts
            : [h('button', { type: 'button', onclick: () => pick(folder) }, ...parts)]),
        );
      }),
    );
  };

  const renderDetail = (state: AppState) => {
    const { repo, selection } = state;
    sheetClear.hidden = !selection;
    if (!repo || !selection) {
      detail.hidden = true;
      sheetTitle.textContent = 'Folders and leaf colors';
      sheetStat.textContent = repo
        ? `${plural(childrenOf(repo, 0).length, 'top-level folder')} · ${plural(repo.index.langs.filter((l) => l !== 'Other').length, 'language')}`
        : '';
      return;
    }
    const { folder, file } = selection;
    const { path } = repo.tree.folders;
    const { parent, files, bytes: size, langs } = repo.index.folders;
    const repoName = repo.info.ref.repo;
    const ancestors: number[] = [];
    for (let a = parent[folder]!; a >= 0; a = parent[a]!) ancestors.unshift(a);
    const label = (f: number) => (f === 0 ? repoName : nameOf(path[f]!));
    const sep = () => h('em', {}, '/');
    const subs = childrenOf(repo, folder);
    const colors = langColors(repo, state.settings.palette);
    const rest = slotColors(PALETTES[state.settings.palette]).at(-1)!;
    const branch = repo.info.branch;

    const crumbs = h(
      'nav',
      { class: 'crumbs', 'aria-label': 'Folder path' },
      ...ancestors.flatMap((a) => [
        h(
          'button',
          { type: 'button', onclick: () => pick(a), title: `Select ${path[a] || repoName}` },
          label(a),
        ),
        sep(),
      ]),
      h('strong', { 'aria-current': 'location' }, label(folder)),
    );

    const topLangs = Array.from({ length: TOP_LANGS }, (_, k) => ({
      lang: langs[(folder * TOP_LANGS + k) * 2]!,
      n: langs[(folder * TOP_LANGS + k) * 2 + 1]!,
    })).filter((l) => l.lang >= 0);

    let fileCard: HTMLElement | null = null;
    if (file !== undefined) {
      const filePath = repo.index.files.paths[file]!;
      fileCard = h(
        'div',
        { class: 'file-card' },
        h('code', {}, nameOf(filePath)),
        h('span', {}, `${langOf(filePath)} · ${bytes(repo.index.files.size[file]!)}`),
        h(
          'a',
          {
            class: 'btn',
            href: githubUrl(repo.info.ref, branch, filePath, 'blob'),
            target: '_blank',
            rel: 'noopener',
          },
          'Open file on GitHub',
          icon(...ICONS.external),
        ),
      );
    }

    fill(
      detail,
      h(
        'button',
        {
          type: 'button',
          class: 'close',
          'aria-label': 'Clear selection',
          onclick: () => app.select(null),
        },
        icon(...ICONS.close),
      ),
      crumbs,
      fileCard,
      h(
        'div',
        { class: 'detail-head' },
        h('b', {}, plural(files[folder]!, 'file')),
        h(
          'span',
          {},
          [
            subs.length ? plural(subs.length, 'subfolder') : 'No subfolders',
            bytes(size[folder]!),
          ].join(' · '),
        ),
      ),
      topLangs.length
        ? h(
            'ul',
            { class: 'langs', 'aria-label': 'Top languages' },
            ...topLangs.map(({ lang, n }) => {
              const name = repo.index.langs[lang]!;
              const c = colors.get(name) ?? rest;
              return h(
                'li',
                {},
                h('i', { class: 'swatch', style: `--c:${c}` }),
                h('span', {}, name),
                h(
                  'span',
                  { class: 'bar-track', 'aria-hidden': 'true' },
                  h('i', { style: `width:${(n / files[folder]!) * 100}%;--c:${c}` }),
                ),
                h('span', { class: 'num' }, percent(n, files[folder]!)),
              );
            }),
          )
        : null,
      subs.length ? h('h3', { class: 'h' }, 'Largest subfolders') : null,
      subs.length
        ? h(
            'ul',
            { class: 'subs' },
            ...subs.slice(0, SUB_ROWS).map((s) =>
              h(
                'li',
                {},
                h(
                  'button',
                  { type: 'button', onclick: () => pick(s) },
                  h('span', { class: 'fn' }, `${nameOf(path[s]!)}/`),
                  h(
                    'span',
                    { class: 'bar-track', 'aria-hidden': 'true' },
                    h('i', {
                      style: `width:${Math.max(3, (files[s]! / files[subs[0]!]!) * 100)}%;--c:var(--ink)`,
                    }),
                  ),
                  h('span', { class: 'num' }, count(files[s]!)),
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'actions' },
        h(
          'a',
          {
            class: 'btn dark',
            href: githubUrl(repo.info.ref, branch, path[folder]),
            target: '_blank',
            rel: 'noopener',
          },
          'Open on GitHub',
          icon(...ICONS.external),
        ),
        folder === 0
          ? null
          : h(
              'button',
              { type: 'button', class: 'btn', onclick: () => view.frameFolder(folder) },
              'Zoom in',
            ),
      ),
    );
    detail.setAttribute('aria-label', `Pinned folder ${path[folder] || repoName}`);
    detail.hidden = false;
    sheetTitle.textContent = `${label(folder)}/`;
    sheetStat.textContent = [
      plural(files[folder]!, 'file'),
      ancestors.length > 1 ? `in ${path[parent[folder]!]}/` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  const render = (state: AppState, prev?: AppState) => {
    if (!state.repo) return;
    const repoChanged = state.repo !== prev?.repo;
    const colorsChanged =
      repoChanged ||
      state.settings.palette !== prev?.settings.palette ||
      state.settings.colorBy !== prev?.settings.colorBy;
    if (colorsChanged || state.selection !== prev?.selection) renderFolders(state);
    if (colorsChanged) renderLegend(state);
    if (colorsChanged || state.selection !== prev?.selection) renderDetail(state);
    if (repoChanged && !state.selection) side.scrollTop = 0;
  };
  store.subscribe(render);
  render(store.get());
}
