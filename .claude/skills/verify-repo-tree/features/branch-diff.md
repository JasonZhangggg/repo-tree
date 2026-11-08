# Branch changes

Pick any branch, tag or commit and the tree shows what it changes against the branch on show (usually main): the head's new files grow in as leaves of their own and shine bright, leaves of changed files light up, and leaves of deleted files wither, tumble down and lie on the island. The rest of the crown fades as it does for search matches. The repo card's foot becomes a key: head vs base, the new, changed and deleted counts, commits ahead and behind, and × to put the tree back.

## Sub-features

- `diff-pick` opens a picker from `Show a branch’s changes` (the repo card's foot on a desktop, More actions on a phone) listing the repo's branches and tags (`fetchRefs`, two requests), filtered as you type; Enter or `Show changes` looks up whatever is typed, a sha too.
- `diff-compare` reads `GET /compare/<base>...<head>` once (`fetchCompare`); a rename is its old path deleted and its new one added; GitHub's 300-file cap is noted.
- `diff-grow` regrows the tree with the head's new files (`LoadRequest.extra`), then `TreeView.setDiff` marks leaves: a sprig's leaves split by its files, so the share deleted falls (at least one leaf) and the share added shines, the rest lit when any file changed.
- `diff-fall` deleted leaves fall once the tree has grown in and stay on the island in a dry brown; under reduced motion they lie there at once.
- `diff-key` the key at the repo card's foot: counts (a kind with no files is left out), ahead and behind, files in hidden folders, and ×. A long head name ends in an ellipsis inside the card, with the full name as its tooltip, and never widens the card.
- `diff-link` puts `diff=<head>` in the link, which restores it.
- `diff-error` a name GitHub does not know (or one sharing no history) says so in the key and leaves the tree as it was; a rate limit says when it lifts.
- `diff-grove` comparing trees side by side lets the branch go: it describes one repo.

## How to get to it (user POV)

- Desktop: the repo card's last row, `Show a branch’s changes`. Phone: `More actions`, then `Show a branch’s changes`.
- A link with `diff=<branch>`.
- `×` in the key, or loading another repo, puts the tree back.

## Driving it with drive.mjs

Preconditions:

- Baseline from the index. Run `drive branch --port <port>` (and `--viewport phone`).
- `serveBranches(page, repo, VITE_BRANCHES)` in `e2e/github.ts` answers the branch and tag lists and the comparison of `feat/rolldown-bundler` (13 new, 9 changed, 58 deleted: five CSS playgrounds), from the vite sample's own paths; any other head is a 404.

- **Idle.** Step `idle` loads the vite sample; on a desktop `#diff-open` shows.
- **Picker.** Step `picker` opens it; the dialog lists the branches and both tags.
- **Typed.** Step `typed` types `roll`, leaving one row.
- **Compared.** Step `compared` picks `feat/rolldown-bundler`: the key reads 13 new, 9 changed, 58 deleted and `23 commits ahead, 4 behind`, the tree regrows (2,911 files) and the link carries `diff=`.
- **Link.** Step `link` reloads the link and the key comes back.
- **Stop.** Step `stop` presses × and the link drops `diff=`.
- **Missing.** Step `missing` types `no-such-branch`: the key says GitHub has none.
- `diff-fall`'s motion has no step (journeys reduce motion); open the build with motion allowed and pick a branch to watch it. `diff-grove` has no step.

## Gotchas

- The whole view is small: zoom (wheel) toward the crown to see single leaves, and move the pointer off the tree, since hovering a branch fades the rest.
- A sprig stands for several files, so a deleted file among many drops one leaf, not a whole sprig; small deletions show few fallen leaves.
- `api.github.com` is unreachable from this sandbox, so the compare, branches and tags endpoints have only been exercised through the stand-in.
