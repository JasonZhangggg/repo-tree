import { expect, type Page } from '@playwright/test';

type Stats = { distance: number; renders: number; triangles: number; target: number[] };
type Debug = { __repoTree: { view: { stats(): Stats } } };

const statsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Debug).__repoTree.view.stats());

/**
 * Animation frames the view must skip in a row to count as at rest. A panel that changes
 * size reaches the view two frames later (its ResizeObserver, then the reframe's frame).
 */
const QUIET_FRAMES = 3;

/**
 * Whether the view rendered nothing across QUIET_FRAMES animation frames. The view renders
 * in an animation frame whenever it has one pending, so this counts frames, not time: on a
 * software GL one busy frame can take over a second.
 */
const atRest = (page: Page) =>
  page.evaluate(async (quiet) => {
    const { view } = (window as unknown as Debug).__repoTree;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    await nextFrame();
    const before = view.stats().renders;
    for (let i = 0; i < quiet; i++) await nextFrame();
    return view.stats().renders === before;
  }, QUIET_FRAMES);

/**
 * Waits until the view renders on demand again, so the camera and the framing have come to
 * rest, and returns its stats then. The view eases by at most 0.1 s per frame, so at the few
 * frames a second of a software GL an ease of a second or two takes many seconds.
 */
export async function settle(page: Page): Promise<Stats> {
  await expect
    .poll(() => atRest(page), { message: 'the view stops rendering', timeout: 20_000 })
    .toBe(true);
  return statsOf(page);
}

/** The repo field folds into the repo card once a repo is on show; this opens it, if it is folded. The
 * switch is the stable handle: the name button is named "Change repository" too while it is empty. */
export async function openRepoField(page: Page) {
  if (await page.getByLabel('GitHub repository').isHidden()) {
    await page.locator('#repo-switch').click();
  }
}

/** Chooses a tree action, opening `More actions` first on a phone, where the action lives. */
export async function chooseAction(page: Page, name: string | RegExp) {
  const more = page.getByRole('button', { name: 'More actions' });
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name }).click();
}
