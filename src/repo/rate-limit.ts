/**
 * How much of GitHub's REST budget is left this hour. `GET /rate_limit` does not count against
 * it. The budget is the token's own when one is sent, else the visitor's IP address's, which
 * everyone on the same network shares.
 */
export type RateLimit = {
  limit: number;
  remaining: number;
  /** When the hour's budget starts again, in ms since the epoch. */
  resetAt: number;
};

const API = 'https://api.github.com';

/** The core (REST) budget for `token`, or the anonymous one; null when GitHub can't be asked. */
export async function fetchRateLimit(
  token?: string,
  signal?: AbortSignal,
): Promise<RateLimit | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API}/rate_limit`, { headers, signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const core = (body as { resources?: { core?: Record<string, unknown> } })?.resources?.core;
    const { limit, remaining, reset } = core ?? {};
    if (typeof limit !== 'number' || typeof remaining !== 'number' || typeof reset !== 'number')
      return null;
    return { limit, remaining, resetAt: reset * 1000 };
  } catch {
    return null;
  }
}

const count = new Intl.NumberFormat('en-US');

/** A request count with thousands separators: "4,812". */
export const formatCount = (n: number): string => count.format(n);

/** "resets at 6:42 PM", or "resets within a minute" when it is that close. */
export function resetsIn(rate: RateLimit, now = Date.now()): string {
  if (rate.resetAt <= now + 60_000) return 'resets within a minute';
  const at = new Date(rate.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `resets at ${at}`;
}

/** "4,812 of 5,000 left, resets at 6:42 PM", or how soon when it resets within the minute. */
export function describeRateLimit(rate: RateLimit, now = Date.now()): string {
  return `${count.format(rate.remaining)} of ${count.format(rate.limit)} left, ${resetsIn(rate, now)}`;
}
