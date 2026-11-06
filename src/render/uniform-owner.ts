import { birdUniforms, treeUniforms } from './shaders';

/**
 * The tree and bird shader uniforms are one shared set of objects: every material holds them by
 * reference, and the ground and weather modules share some of them too. A page that shows more
 * than one TreeView (the compare view shows two beside the main one) would have each view's grow,
 * highlight and timeline values land in the others' frames. So a view claims the uniforms before
 * it changes or draws anything: the values of the view that held them are put aside, and its own
 * come back. A view that never claimed them before starts from their values at load.
 */
const GROUPS: readonly Record<string, { value: unknown }>[] = [treeUniforms, birdUniforms];
type Values = unknown[][];

const copy = (value: unknown) => (Array.isArray(value) ? [...value] : value);
const snapshot = (): Values => GROUPS.map((g) => Object.values(g).map((u) => copy(u.value)));
const DEFAULTS = snapshot();

let owner: object | null = null;
const saved = new WeakMap<object, Values>();

export function claimUniforms(view: object): void {
  if (owner === view) return;
  if (owner) saved.set(owner, snapshot());
  const values = saved.get(view) ?? DEFAULTS;
  GROUPS.forEach((group, i) =>
    Object.values(group).forEach((uniform, j) => (uniform.value = copy(values[i]![j]))),
  );
  owner = view;
}

/** Forgets a disposed view's values. */
export function releaseUniforms(view: object): void {
  if (owner === view) owner = null;
  saved.delete(view);
}
