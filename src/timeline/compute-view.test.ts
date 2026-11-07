import { describe, expect, test } from 'vitest';
import { describeStep } from './compute-view';
import { estimateCompute } from './estimate';

const small = estimateCompute(3_600);
const linux = estimateCompute(104_000);
const ctx = { name: 'acme/widgets', estimate: small, warn: false, phone: false, signedIn: false };

describe('describeStep', () => {
  test('offers to sign in, saying it runs in this browser, how much, and that it is shared', () => {
    const v = describeStep({ kind: 'offer' }, ctx);
    expect(v.title).toBe('No timeline yet for acme/widgets');
    expect(v.lines[0]!.text).toBe(
      'Your browser can work it out from GitHub (about 2 MB), then share it so everyone who opens acme/widgets gets it.',
    );
    expect(v.lines.at(-1)).toEqual({
      kind: 'fine',
      text: 'Sign-in asks GitHub for no permissions, and your token stays in this tab.',
    });
    expect(v.lines.some((l) => l.kind === 'warn')).toBe(false);
    expect(v.buttons).toEqual([
      { label: 'Sign in with GitHub', act: 'start' },
      { label: 'Not now', act: 'close' },
    ]);
    expect(describeStep({ kind: 'offer' }, { ...ctx, signedIn: true }).buttons[0]!.label).toBe(
      'Compute history',
    );
  });

  test('warns before a big job or on a phone, with the estimate, and lets them choose', () => {
    const big = describeStep({ kind: 'offer' }, { ...ctx, estimate: linux, warn: true });
    const warn = big.lines.find((l) => l.kind === 'warn')!.text;
    expect(warn).toMatch(
      /^A big repo: about 50 MB to download and about \d+ MB of memory, for a minute or more\.$/,
    );
    expect(big.buttons.map((b) => b.label)).toEqual(['Sign in and compute', 'Not now']);
    const phone = describeStep({ kind: 'offer' }, { ...ctx, warn: true, phone: true });
    expect(phone.lines.find((l) => l.kind === 'warn')!.text).toMatch(
      /^On a phone this can be slow: about 2 MB to download and about \d+ MB of memory\.$/,
    );
    const signedIn = describeStep({ kind: 'offer' }, { ...ctx, warn: true, signedIn: true });
    expect(signedIn.buttons[0]!.label).toBe('Compute anyway');
    expect(signedIn.lines.some((l) => l.kind === 'fine')).toBe(false);
  });

  test('offers to bring an out-of-date history up to date, or keep it', () => {
    const since = Date.UTC(2026, 2, 3);
    const v = describeStep({ kind: 'offer', refresh: { since } }, { ...ctx, signedIn: true });
    expect(v.title).toBe('The timeline of acme/widgets is out of date');
    expect(v.lines[0]!.text).toContain('Last worked out Mar 3, 2026; the branch has moved since.');
    expect(v.lines[0]!.text).toContain('add the new commits');
    expect(v.lines[0]!.text).toContain('share it again for everyone');
    expect(v.buttons).toEqual([
      { label: 'Refresh history', act: 'start' },
      { label: 'Use this one', act: 'close' },
    ]);
    const big = describeStep(
      { kind: 'offer', refresh: { since } },
      { ...ctx, estimate: linux, warn: true, signedIn: false },
    );
    expect(big.buttons[0]!.label).toBe('Sign in and refresh');
  });

  test('shows progress with megabytes and a cancel', () => {
    const v = describeStep({ kind: 'computing', progress: 0.42 }, { ...ctx, estimate: linux });
    expect(v.progress).toBe(0.42);
    expect(v.lines[0]).toEqual({ kind: 'progress', text: '42% · 22 MB of about 50 MB' });
    expect(v.buttons).toEqual([{ label: 'Cancel', act: 'cancel' }]);
    const tiny = describeStep(
      { kind: 'computing', progress: 0.5 },
      { ...ctx, estimate: estimateCompute(100) },
    );
    expect(tiny.lines[0]!.text).toBe('50% · under 1 MB');
  });

  test('explains a failure and offers to resume', () => {
    const limited = describeStep(
      { kind: 'failed', error: { kind: 'rate-limited', resetAt: Date.UTC(2026, 0, 1, 14, 5) } },
      ctx,
    );
    expect(limited.lines[0]!.text).toContain('continues where it stopped');
    expect(limited.buttons[0]).toEqual({ label: 'Try again', act: 'start' });
    const refused = describeStep({ kind: 'failed', error: { kind: 'unauthorized' } }, ctx);
    expect(refused.buttons[0]!.label).toBe('Sign in with GitHub');
  });

  test('names the default branch for a branch link to another, with nothing to retry', () => {
    const other = describeStep(
      { kind: 'failed', error: { kind: 'not-default-branch', defaultBranch: 'main' } },
      ctx,
    );
    expect(other.lines[0]!.text).toContain('default branch, main');
    expect(other.buttons).toEqual([{ label: 'Close', act: 'close' }]);
  });
});
