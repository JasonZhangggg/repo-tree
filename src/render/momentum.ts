/**
 * The physics every drag on the page shares: how fast a finger was moving when it let go, how
 * far that throw carries, how an edge resists, and the springs that settle what was thrown.
 * Pure functions of numbers, so the camera and the phone sheets feel like one material.
 */

/** A pointer position along one axis at a time, in ms (`event.timeStamp` or `performance.now()`). */
export type Sample = { at: number; t: number };

/** Only the last stretch of a drag says how fast it was going when it let go. */
const VELOCITY_WINDOW_MS = 100;
/** A finger that held still this long before lifting threw nothing. */
const HELD_MS = 60;

/**
 * The velocity at release, in units per ms, from the samples of the last 100 ms. A finger that
 * paused before lifting has none, so a careful drag stays where it was put.
 */
export function releaseVelocity(samples: readonly Sample[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (!first || !last || last === first || now - last.t > HELD_MS) return 0;
  return (last.at - first.at) / Math.max(8, last.t - first.t);
}

/** Keeps the last 100 ms of samples (and at least two), dropping older ones. */
export function pushSample(samples: Sample[], sample: Sample): void {
  samples.push(sample);
  while (samples.length > 2 && sample.t - samples[0]!.t > VELOCITY_WINDOW_MS * 1.5) {
    samples.shift();
  }
}

/**
 * How much further a throw at `velocity` (units per ms) carries before it comes to rest, with
 * scroll-like exponential deceleration: 0.998 per ms feels like a page, 0.99 snappier.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return (velocity * decelerationRate) / (1 - decelerationRate);
}

const BAND = 0.55;

/**
 * How far something shows past an edge when the finger is `over` past it: it follows less the
 * further it goes and never shows more than `limit`, so an edge gives instead of stopping dead.
 */
export function rubberband(over: number, limit: number): number {
  return (over * limit * BAND) / (limit + BAND * Math.abs(over));
}

/** The inverse of `rubberband`: how far past the edge the finger is, from what shows. */
export function unrubberband(shown: number, limit: number): number {
  const s = Math.min(Math.abs(shown), limit * 0.999);
  return (Math.sign(shown) * (s * limit)) / (BAND * (limit - s));
}

/** A value clamped to `[lo, hi]` with rubber-banded give of up to `limit` either side. */
export function band(raw: number, lo: number, hi: number, limit: number): number {
  if (raw < lo) return lo + rubberband(raw - lo, limit);
  if (raw > hi) return hi + rubberband(raw - hi, limit);
  return raw;
}

/** The inverse of `band`. */
export function unband(shown: number, lo: number, hi: number, limit: number): number {
  if (shown < lo) return lo + unrubberband(shown - lo, limit);
  if (shown > hi) return hi + unrubberband(shown - hi, limit);
  return shown;
}

/** One axis in flight: its value and its velocity in units per second. */
export type Flight = { x: number; v: number };

/**
 * Advances a thrown value by `dt` seconds. Inside `[lo, hi]` it coasts and slows exponentially
 * (`tau` seconds to lose about two thirds of its speed); past an edge a critically damped spring
 * with `response` seconds catches it, so a throw into an edge sinks in a little and comes back.
 * Returns whether it is still moving.
 */
export function coast(
  f: Flight,
  dt: number,
  { lo = -Infinity, hi = Infinity, tau = 0.35, response = 0.4, rest = 1e-3 } = {},
): boolean {
  // Small substeps keep the hand-off at an edge exact at any frame rate.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const edge = f.x < lo ? lo : f.x > hi ? hi : null;
    if (edge === null) {
      const decay = Math.exp(-h / tau);
      f.x += f.v * tau * (1 - decay);
      f.v *= decay;
    } else {
      const w = (2 * Math.PI) / response;
      const e = f.x - edge;
      const k = f.v + w * e;
      const decay = Math.exp(-w * h);
      f.x = edge + (e + k * h) * decay;
      f.v = (f.v - w * k * h) * decay;
    }
  }
  const edge = f.x < lo ? lo : f.x > hi ? hi : null;
  if (edge === null) {
    if (Math.abs(f.v) < rest) {
      f.v = 0;
      return false;
    }
    return true;
  }
  if (Math.abs(f.x - edge) < rest * 0.1 && Math.abs(f.v) < rest) {
    f.x = edge;
    f.v = 0;
    return false;
  }
  return true;
}

/**
 * A spring with Apple's two knobs, `response` (seconds, how quick) and `damping` (1 settles
 * without overshoot, lower bounces), stepped in substeps so it holds at any frame rate.
 * Returns whether it is still moving.
 */
export function springStep(
  f: Flight,
  goal: number,
  dt: number,
  { response = 0.4, damping = 1, rest = 0.5 } = {},
): boolean {
  const stiffness = ((2 * Math.PI) / response) ** 2;
  const friction = (4 * Math.PI * damping) / response;
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const a = -stiffness * (f.x - goal) - friction * f.v;
    f.v += a * h;
    f.x += f.v * h;
  }
  if (Math.abs(f.x - goal) < rest && Math.abs(f.v) < rest * 10) {
    f.x = goal;
    f.v = 0;
    return false;
  }
  return true;
}
