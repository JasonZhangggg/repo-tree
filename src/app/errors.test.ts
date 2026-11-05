import { describe, expect, test } from 'vitest';
import type { RepoRef } from '../repo/ref';
import { describeError } from './errors';

const ref = { owner: 'acme', repo: 'widgets' } as RepoRef;
const limited = { kind: 'rate-limited', resetAt: Date.UTC(2026, 0, 1, 12) } as const;

describe('describeError', () => {
  test('a rate limit offers sign-in where this build can sign in, else a token', () => {
    const sign = describeError(limited, ref, { hasToken: false, canSignIn: true });
    expect(sign.body).toContain('Signing in with GitHub raises it from 60 to 5,000 an hour');
    expect(sign.actions).toEqual(['signin', 'retry']);
    expect(describeError(limited, ref, { hasToken: false }).actions).toEqual(['token', 'retry']);
    expect(describeError(limited, ref, { hasToken: true, canSignIn: true }).actions).toEqual([
      'retry',
    ]);
  });

  test('a refused sign-in says it expired and offers to sign in again', () => {
    const expired = describeError({ kind: 'unauthorized' }, ref, {
      hasToken: true,
      signedIn: true,
      canSignIn: true,
    });
    expect(expired.title).toBe('Your GitHub sign-in expired');
    expect(expired.actions).toEqual(['signin', 'retry']);
    expect(describeError({ kind: 'unauthorized' }, ref, { hasToken: true }).title).toBe(
      'GitHub rejected your token',
    );
  });

  test('a network failure names the repo it was growing', () => {
    const copy = describeError({ kind: 'network' }, ref, { hasToken: false });
    expect(copy.body).toContain('acme/widgets');
    expect(copy.actions).toEqual(['retry']);
  });
});
