import { springStep, type Flight } from '../../render/momentum';

export type Run = {
  /** Stops it where it is and returns that value, so a finger can catch it mid-flight. */
  stop(): number;
};

/**
 * Runs a spring from `from` to `to` on animation frames, starting at `velocity` (units per
 * second) so a release carries on at the finger's speed. `frame` gets each value, `done` runs
 * once it rests at `to`.
 */
export function springTo(
  from: number,
  to: number,
  velocity: number,
  frame: (x: number) => void,
  done: () => void,
  options: { response?: number; damping?: number } = {},
): Run {
  const f: Flight = { x: from, v: velocity };
  let last = performance.now();
  let raf = requestAnimationFrame(function tick(now) {
    const dt = Math.min(0.05, Math.max(0, now - last) / 1000);
    last = now;
    const moving = springStep(f, to, dt, options);
    frame(f.x);
    if (moving) raf = requestAnimationFrame(tick);
    else {
      raf = 0;
      done();
    }
  });
  return {
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      return f.x;
    },
  };
}
