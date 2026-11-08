import type { PerspectiveCamera, Spherical, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  band,
  coast,
  pushSample,
  releaseVelocity,
  unband,
  type Flight,
  type Sample,
} from './momentum';

/** The parts of OrbitControls (three 0.187) this builds on; `three` is pinned to that version. */
type Internals = {
  state: number;
  _spherical: Spherical;
  _sphericalDelta: Spherical;
  _scale: number;
  _performCursorZoom: boolean;
  _mouse: Vector2;
  _dollyDirection: Vector3;
  _pointers: number[];
  _rotateUp(angle: number): void;
  _dollyIn(scale: number): void;
  _dollyOut(scale: number): void;
  _updateZoomParameters(x: number, y: number): void;
  _getZoomScale(delta: number): number;
  _handleMouseWheel(event: { clientX: number; clientY: number; deltaY: number }): void;
};
const base = OrbitControls.prototype as unknown as Internals;
/** OrbitControls' state while no pointer is down. */
const NONE = -1;

/** How far past the lowest and highest view a drag gives, in radians of tilt. */
const TILT_GIVE = 0.14;
/** How far past the nearest and furthest zoom a pinch gives, in log distance (about 30%). */
const ZOOM_GIVE = 0.28;
/** Seconds a throw takes to lose two thirds of its speed: turning carries like a globe. */
const TURN_TAU = 0.3;
const ZOOM_TAU = 0.26;
/** Throws are capped so a wild flick still reads as a turn, in units per second. */
const MAX_TURN = 6;
const MAX_TILT = 5;
const MAX_ZOOM = 5;
/** A wheel notch eases in over about this many seconds instead of jumping. */
const WHEEL_EASE = 0.075;
/** A wheel that has been quiet this long has let go: a zoom past an edge springs back. */
const WHEEL_IDLE_MS = 140;
const TURN_REST = 0.02;
const ZOOM_REST = 0.01;

/**
 * OrbitControls with the feel of a thing in the hand. A drag turns the tree 1:1 under the finger
 * (no damping lag), and on release it carries on at the finger's speed and slows like a spun
 * globe. A pinch or a drag past the nearest or furthest zoom, or past the lowest or highest view,
 * gives a little and springs back. A wheel notch eases in rather than jumping. A press while any
 * of this runs catches it where it is. With `momentum` off (reduced motion) it is plain
 * OrbitControls without damping.
 */
export class MomentumControls extends OrbitControls {
  momentum = true;
  private turn: Flight | null = null;
  private tilt: Flight | null = null;
  private zoom: Flight | null = null;
  private wheel = { pending: 0, until: 0 };
  private samples = { turn: [] as Sample[], tilt: [] as Sample[], zoom: [] as Sample[] };
  /** The azimuth unwrapped across ±π, so a turn through the back has a steady velocity. */
  private azimuth = { last: 0, total: 0 };
  private dragging = false;
  private fingers = 0;
  /** When the input the next update answers happened, and when the last finger lifted (ms). */
  private inputAt = 0;
  private upAt = 0;

  constructor(camera: PerspectiveCamera, element: HTMLElement) {
    super(camera, element);
    this.enableDamping = false;
    // Speed is timed by the input events themselves, not by when a slow frame got round to them.
    // These run before OrbitControls' own handlers, which listen on the document.
    element.addEventListener('pointerdown', (e) => (this.inputAt = e.timeStamp));
    element.addEventListener('pointermove', (e) => (this.inputAt = e.timeStamp));
    element.addEventListener('pointerup', (e) => (this.upAt = e.timeStamp));
    this.addEventListener('start', () => {
      if (!this.internals._pointers.length) return;
      this.stop();
      this.dragging = true;
      this.samples = { turn: [], tilt: [], zoom: [] };
    });
    this.addEventListener('end', () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.release(this.upAt || this.inputAt);
    });
  }

  private get internals(): Internals {
    return this as unknown as Internals;
  }

  /** Whether a throw or a spring back is still moving the camera. */
  get flying(): boolean {
    return !!(this.turn || this.tilt || this.zoom || this.wheel.pending);
  }

  /** Drops any throw, spring back or eased wheel, as a glide the app starts takes over. */
  stop(): void {
    this.turn = this.tilt = this.zoom = null;
    this.wheel.pending = 0;
  }

  private get gripped(): boolean {
    return this.internals.state !== NONE;
  }

  private logRange(): [number, number] {
    return [Math.log(Math.max(1e-6, this.minDistance)), Math.log(this.maxDistance)];
  }

  private radius(): number {
    return this.object.position.distanceTo(this.target);
  }

  _rotateUp(angle: number): void {
    const o = this.internals;
    if (!this.momentum || !this.gripped) return base._rotateUp.call(this, angle);
    const now = o._spherical.phi + o._sphericalDelta.phi;
    const [lo, hi] = [this.minPolarAngle, this.maxPolarAngle];
    const next = band(unband(now, lo, hi, TILT_GIVE) - angle, lo, hi, TILT_GIVE);
    o._sphericalDelta.phi += next - now;
  }

  /** Zooms the pending distance by `factor`, giving past the range rather than stopping. */
  private zoomBy(factor: number): void {
    const o = this.internals;
    const r = this.radius();
    const [lo, hi] = this.logRange();
    const now = Math.log(r * o._scale);
    o._scale =
      Math.exp(band(unband(now, lo, hi, ZOOM_GIVE) + Math.log(factor), lo, hi, ZOOM_GIVE)) / r;
  }

  _dollyIn(scale: number): void {
    if (!this.momentum || !this.gripped) return base._dollyIn.call(this, scale);
    this.zoomBy(scale);
  }

  _dollyOut(scale: number): void {
    if (!this.momentum || !this.gripped) return base._dollyOut.call(this, scale);
    this.zoomBy(1 / scale);
  }

  _handleMouseWheel(event: { clientX: number; clientY: number; deltaY: number }): void {
    if (!this.momentum) return base._handleMouseWheel.call(this, event);
    const o = this.internals;
    o._updateZoomParameters(event.clientX, event.clientY);
    if (!event.deltaY) return;
    const scale = o._getZoomScale(event.deltaY);
    this.zoom = null;
    // Notches past the nearest or furthest zoom pile up no further than the give can show, so
    // the spring back starts as soon as the wheel stops.
    const [lo, hi] = this.logRange();
    const raw = unband(Math.log(this.radius()), lo, hi, ZOOM_GIVE);
    const pending = this.wheel.pending + Math.log(event.deltaY < 0 ? scale : 1 / scale);
    this.wheel.pending = Math.max(lo - ZOOM_GIVE - raw, Math.min(hi + ZOOM_GIVE - raw, pending));
    this.wheel.until = performance.now() + WHEEL_IDLE_MS;
    this.dispatchEvent({ type: 'change' });
  }

  /** Aims the next zoom down the ray through the last pointer, as OrbitControls' own does. */
  private toCursor(): void {
    const o = this.internals;
    if (!this.zoomToCursor) return;
    o._performCursorZoom = true;
    o._dollyDirection
      .set(o._mouse.x, o._mouse.y, 1)
      .unproject(this.object)
      .sub(this.object.position)
      .normalize();
  }

  /** Turns the last moments of a drag into a throw, and catches anything left past an edge. */
  private release(now: number): void {
    if (!this.momentum) return;
    const cap = (v: number, max: number) => Math.max(-max, Math.min(max, v * 1000));
    const turn = cap(releaseVelocity(this.samples.turn, now), MAX_TURN);
    const tilt = cap(releaseVelocity(this.samples.tilt, now), MAX_TILT);
    if (Math.abs(turn) > TURN_REST * 4) this.turn = { x: 0, v: turn };
    const phi = this.getPolarAngle();
    if (Math.abs(tilt) > TURN_REST * 4 || phi < this.minPolarAngle || phi > this.maxPolarAngle) {
      this.tilt = { x: phi, v: tilt };
    }
    this.throwZoom(now);
  }

  private throwZoom(now: number): void {
    if (this.zoom) return;
    const v = Math.max(
      -MAX_ZOOM,
      Math.min(MAX_ZOOM, releaseVelocity(this.samples.zoom, now) * 1000),
    );
    const x = Math.log(this.radius());
    const [lo, hi] = this.logRange();
    if (Math.abs(v) > ZOOM_REST * 4 || x < lo || x > hi) this.zoom = { x, v };
    this.samples.zoom = [];
  }

  update(deltaTime: number | null = null): boolean {
    // OrbitControls' constructor updates once, before this class's fields exist.
    if (!this.wheel) return super.update(deltaTime);
    const o = this.internals;
    const dt = deltaTime ?? 1 / 60;
    const now = performance.now();
    let flew = false;

    if (this.wheel.pending) {
      const share = 1 - Math.exp(-dt / WHEEL_EASE);
      const part =
        Math.abs(this.wheel.pending) < 1e-4 ? this.wheel.pending : this.wheel.pending * share;
      this.wheel.pending -= part;
      const [lo, hi] = this.logRange();
      const r = Math.log(this.radius());
      o._scale = Math.exp(band(unband(r, lo, hi, ZOOM_GIVE) + part, lo, hi, ZOOM_GIVE) - r);
      this.toCursor();
      flew = true;
    } else if (this.wheel.until && now >= this.wheel.until) {
      this.wheel.until = 0;
      this.throwZoom(now);
    }

    // Two fingers becoming one ends the pinch, and its zoom carries on while the last one turns.
    const fingers = o._pointers.length;
    if (this.fingers >= 2 && fingers === 1) this.throwZoom(this.inputAt);
    this.fingers = fingers;

    if (this.turn && !fingers) {
      const before = this.turn.x;
      flew = coast(this.turn, dt, { tau: TURN_TAU, rest: TURN_REST }) || flew;
      o._sphericalDelta.theta += this.turn.x - before;
      if (!this.turn.v) this.turn = null;
    }
    if (this.tilt && !fingers) {
      const moving = coast(this.tilt, dt, {
        lo: this.minPolarAngle,
        hi: this.maxPolarAngle,
        tau: TURN_TAU,
        rest: TURN_REST,
      });
      o._sphericalDelta.phi += this.tilt.x - this.getPolarAngle();
      flew = true;
      if (!moving) this.tilt = null;
    }
    if (this.zoom && fingers < 2) {
      const [lo, hi] = this.logRange();
      const moving = coast(this.zoom, dt, { lo, hi, tau: ZOOM_TAU, rest: ZOOM_REST });
      o._scale = Math.exp(this.zoom.x) / this.radius();
      this.toCursor();
      flew = true;
      if (!moving) this.zoom = null;
    }

    // Let the camera past its limits by the give while anything is held or springing back.
    const free = this.momentum && (this.gripped || flew || now < this.wheel.until);
    const limits = [this.minPolarAngle, this.maxPolarAngle, this.minDistance, this.maxDistance];
    if (free) {
      this.minPolarAngle = Math.max(0, limits[0]! - TILT_GIVE);
      this.maxPolarAngle = Math.min(Math.PI, limits[1]! + TILT_GIVE);
      this.minDistance = limits[2]! * Math.exp(-ZOOM_GIVE);
      this.maxDistance = limits[3]! * Math.exp(ZOOM_GIVE);
    }
    const changed = super.update(deltaTime);
    if (free) {
      [this.minPolarAngle, this.maxPolarAngle, this.minDistance, this.maxDistance] = limits as [
        number,
        number,
        number,
        number,
      ];
    }

    const theta = this.getAzimuthalAngle();
    let step = theta - this.azimuth.last;
    if (step > Math.PI) step -= 2 * Math.PI;
    else if (step < -Math.PI) step += 2 * Math.PI;
    this.azimuth = { last: theta, total: this.azimuth.total + step };
    if (this.gripped) {
      const t = this.inputAt;
      pushSample(this.samples.turn, { at: this.azimuth.total, t });
      pushSample(this.samples.tilt, { at: this.getPolarAngle(), t });
      pushSample(this.samples.zoom, { at: Math.log(this.radius()), t });
    }
    // A wheel that may still be past an edge keeps frames coming until its spring back starts.
    return changed || flew || this.wheel.until > 0;
  }
}
