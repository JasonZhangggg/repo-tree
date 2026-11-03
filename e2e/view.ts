import { expect, type Page } from '@playwright/test';

type Stats = { distance: number; renders: number };
type Debug = { __repoTree: { view: { stats(): Stats } } };

const statsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as Debug).__repoTree.view.stats());

/**
 * Waits until the view renders on demand again, so the camera and the framing have come to
 * rest, and returns its stats then.
 */
export async function settle(page: Page): Promise<Stats> {
  let renders = -1;
  await expect
    .poll(
      async () => {
        const now = (await statsOf(page)).renders;
        const idle = now === renders;
        renders = now;
        return idle;
      },
      { intervals: [500] },
    )
    .toBe(true);
  return statsOf(page);
}
