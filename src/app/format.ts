const COUNT = new Intl.NumberFormat('en-US');
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const count = (n: number) => COUNT.format(n);
export const compact = (n: number) => COMPACT.format(n).toLowerCase();
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${count(n)} ${n === 1 ? one : many}`;
export const percent = (part: number, whole: number) => {
  const p = (part / whole) * 100;
  return p < 1 ? '<1%' : `${Math.round(p)}%`;
};

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
const SPANS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** How long ago `at` was, from `now`, in the largest whole unit: "2 hours ago", "yesterday". */
export function ago(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  for (const [unit, ms] of SPANS) {
    if (elapsed >= ms) return RELATIVE.format(-Math.floor(elapsed / ms), unit);
  }
  return 'just now';
}
