# Owner

Settings' `Color leaves by` has a fourth choice, `Owner`, that colors each top-level folder's leaves by who to ask about it, from the repo's history: the first owner CODEOWNERS names for that folder (such as `@vitejs/team`), else its busiest recent commit author (the most commits in `History.recent`, then the most weight). The files at the root take the root's owner. Owners shared across folders share a color, ranked by files on the palette's ramp, with the rest under `N more`. The legend lists owners with their share of files, the folder bars take their folder's owner color, and the pinned card of a top-level folder lists its top authors with their recent commits and its CODEOWNERS.

## Sub-features

- `owner-colors` recolors every top-level folder's leaves by its `History.owners` owner (timeline/owners.ts): CODEOWNERS' first, else the author with the most recent `commits` (exact per folder), then the most `weight`. A folder with neither is `No known owner`.
- `owner-legend` lists owners, ranked by files, and its note says where they came from: `Owners from CODEOWNERS;`, `CODEOWNERS where it names one, else the top commit author;` or `Each top-level folder's top commit author;` (with `(CODEOWNERS could not be read)` on that gap).
- `owner-highlight` picks an owner in the legend to highlight their leaves. A link's `hl=<name>` restores it once the history arrives.
- `owner-folders` colors each top-level folder bar by its owner.
- `owner-card` lists a pinned top-level folder's top authors (bar and number: commits since `History.recent.since`) and its `CODEOWNERS:` line when there is one.
- `owner-no-history` keeps language colors on a repo with no history and says why in the legend note, as `activity-no-history` does.

## How to get to it (user POV)

- Choose `Owner` from the `Color leaves by` dropdown at the top of the side panel, or `Settings`, then `Color leaves by`, then `Owner`.
- Open a link with `colorBy=owner` (and `hl=<owner>`).
- With owner colors on, pin a top-level folder from the folder list or the tree to see its authors.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive owner --port <port>` (and `--viewport phone`).
- Bundled samples carry `<id>.history.json.gz`, so they need no history server. None of them has a CODEOWNERS file, so every owner is a commit author.

- **Language first.** Open vite by language. Step `language`.
- **Switch.** Settings, `Owner`. Step `owner`. The legend title reads `Leaf colors by owner` with three entries: `andrew` for `playground/` and the root files, `翠` for `packages/`, `docs/`, `.github/` and `scripts/`, and `翠 / green` for `patches/`.
- **Highlight.** Click `翠 / green` in the legend. Step `highlight`. The URL carries `hl=%E7%BF%A0%20/%20green` and only the `patches/` limb keeps its color.
- **Card.** Pin `packages/` from the folder list. Step `card`. The card lists `Top authors · commits since Oct 2026` with `翠` first.
- **Linux.** Open linux by owner. Step `linux`. Alexei Starovoitov owns `kernel/`, `net/`, `tools/`, `include/` and `Documentation/`, Sean Christopherson `arch/`, and Linus Torvalds most quiet limbs (weight decides where nobody committed lately).
- **Link.** Open linux with `hl=Alexei%20Starovoitov`. Step `linux-link`. The entry is pressed.
- **No history.** Enter `acme/widgets` from the stand-in. Step `no-history`. The note reads `History is unavailable for this repo.`

## Gotchas

- `weight` is rough and nearly the same in every folder (vite's `翠` has about 420 almost everywhere), so it only breaks ties. Recent `commits` are exact per folder, so the owner is who has been working there lately; a folder nobody touched in `recent` falls back to weight.
- The same person under two names (`翠` and `翠 / green`) is two owners; the history does not merge identities.
- A link's `hl=` for an owner is kept while the history loads, whatever the name, because owners are not known before it arrives.
