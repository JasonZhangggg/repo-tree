# Repo Tree

Paste a public GitHub repository and watch it grow into a low-poly autumn tree. Folders are forks, the heavier child continues as the leader, branch radius follows the pipe model, and leaves are colored by language. The approved look is in `reference/`, and the v1 plan is `docs/plans/repo-tree-v1.md`.

## Develop

Needs Node 22.

```sh
npm ci
npm run dev     # Vite dev server
npm test        # unit tests (Vitest)
npm run e2e     # Playwright against a production build served by `vite preview`
```
