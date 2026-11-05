import { afterEach, describe, expect, test, vi } from 'vitest';
import { describeRateLimit, fetchRateLimit } from './rate-limit';

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('fetchRateLimit', () => {
  test('reads the core budget, sending the token when there is one', async () => {
    const fetch = reply({
      resources: { core: { limit: 5000, remaining: 4812, reset: 1762300000, used: 188 } },
    });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchRateLimit('gho_x')).toEqual({
      limit: 5000,
      remaining: 4812,
      resetAt: 1762300000_000,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/rate_limit');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gho_x');
  });

  test('asks without a token when there is none', async () => {
    const fetch = reply({ resources: { core: { limit: 60, remaining: 0, reset: 1 } } });
    vi.stubGlobal('fetch', fetch);
    expect((await fetchRateLimit())?.limit).toBe(60);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('is null when GitHub refuses, answers oddly or is unreachable', async () => {
    vi.stubGlobal('fetch', reply({ message: 'Bad credentials' }, 401));
    expect(await fetchRateLimit('bad')).toBeNull();
    vi.stubGlobal('fetch', reply({ resources: {} }));
    expect(await fetchRateLimit()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('offline'))),
    );
    expect(await fetchRateLimit()).toBeNull();
  });
});

describe('describeRateLimit', () => {
  const now = Date.UTC(2026, 10, 5, 6, 0);
  test('says how many are left of how many, with thousands separators, and when it resets', () => {
    const resetAt = now + 42 * 60_000;
    const at = new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(describeRateLimit({ limit: 5000, remaining: 4812, resetAt }, now)).toBe(
      `4,812 of 5,000 left, resets at ${at}`,
    );
  });
  test('says it resets within a minute rather than naming a past or present time', () => {
    expect(describeRateLimit({ limit: 60, remaining: 0, resetAt: now + 20_000 }, now)).toBe(
      '0 of 60 left, resets within a minute',
    );
  });
});
