/**
 * How big computing a history here would be, from the head tree the visitor already has.
 *
 * The engine reads every distinct tree object of the sampled snapshots once over GraphQL, about
 * 32 gzipped bytes an entry, and a long history holds about 25 entries for each one in the head
 * (Linux: 2.66M for a 104k-entry head, 85 MB; vite 2 MB; dotfiles 0.2 MB; measured with
 * server/scripts/measure.mjs). Memory is what a Chromium tab grew by while it ran: about 60 MB
 * plus 4.5 times the download (Linux about 440 MB), mostly the browser's own fetch buffers.
 * Both are upper bounds for young or quiet repos.
 */

export type Estimate = {
  downloadMB: number;
  memoryMB: number;
  /** Linux-sized: worth a warning on any device. */
  big: boolean;
};

const BYTES_PER_ENTRY = 32;
const ENTRIES_PER_HEAD_ENTRY = 25;
/** Commit listings and the recent commits' files. */
const BASE_MB = 0.3;
export const BIG_MB = 25;

export function estimateCompute(headEntries: number): Estimate {
  const downloadMB = BASE_MB + (headEntries * ENTRIES_PER_HEAD_ENTRY * BYTES_PER_ENTRY) / 1e6;
  return { downloadMB, memoryMB: 60 + 4.5 * downloadMB, big: downloadMB >= BIG_MB };
}

/** A phone or a small machine: little memory (deviceMemory, Chromium only) or a touch screen. */
export function constrainedDevice(
  nav: { deviceMemory?: number } = navigator as { deviceMemory?: number },
  coarse: () => boolean = () => matchMedia('(pointer: coarse)').matches,
): boolean {
  return (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || coarse();
}

/** "about 85 MB", "about 3 MB", "under 1 MB". */
export function megabytes(mb: number): string {
  if (mb < 1) return 'under 1 MB';
  return `about ${mb < 10 ? Math.round(mb) : Math.round(mb / 5) * 5} MB`;
}
