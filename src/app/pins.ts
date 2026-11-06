/** How many pinned folders the tray keeps per repo; past it the oldest goes. */
export const MAX_PINS = 8;

/**
 * The tray's pinned folders, by path, oldest first: a new pin joins the end, one already there
 * stays where it is, so the chips don't shuffle while you jump between them.
 */
export function addPin(pins: readonly string[], path: string): string[] {
  if (!path || pins.includes(path)) return [...pins];
  return [...pins, path].slice(-MAX_PINS);
}

export function removePin(pins: readonly string[], path: string): string[] {
  return pins.filter((p) => p !== path);
}

/** The pins of `base` and then each of `more` it lacks, kept to MAX_PINS, newest kept. */
export function mergePins(base: readonly string[], more: readonly string[]): string[] {
  return more.reduce<string[]>((pins, path) => addPin(pins, path), [...base]);
}
