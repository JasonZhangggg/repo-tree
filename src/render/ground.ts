import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import type { Quality, TreeModel } from '../grow/grow';
import { growGround, KIND, type GroundMesh, type GroundModel } from '../grow/ground';
import { VIEW_DIRECTION } from './framing';
import type { Palette } from './palette';
import { FADE, GROUND_SWAY, HOVER_LIFT, treeUniforms } from './shaders';

/** The trunk flares to this much of its base radius where it meets the ground. */
const FLARE = 1.55;

/**
 * The mound under the tree: `land` (grass, soil and rocks) and `cover` (grass blades, flowers
 * and fallen leaves), two draws each at most. Its fade reads every rock as node 0, the root
 * folder they lie for, so a highlighted subfolder fades them with the grass and soil.
 */
export function createGround() {
  const landMaterial = fading(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    'ground',
  );
  const coverMaterial = fading(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: DoubleSide }),
    'cover',
    true,
  );
  const land = new Mesh(new BufferGeometry(), landMaterial);
  const cover = new Mesh(new BufferGeometry(), [coverMaterial]);
  land.castShadow = true;
  land.receiveShadow = true;
  cover.receiveShadow = true;
  for (const mesh of [land, cover]) mesh.frustumCulled = false;

  let model: GroundModel | null = null;
  let palette: Palette | null = null;

  const paint = () => {
    if (!model || !palette) return;
    land.geometry.setAttribute('color', new BufferAttribute(colors(model.land, palette), 3));
    cover.geometry.setAttribute('color', new BufferAttribute(colors(model.cover, palette), 3));
    const { blades, flowers, litter } = model.cover;
    const g = palette.ground;
    const shown = Math.round((blades / 9) * g.blades) * 9;
    const rest = g.flowers.length > 0 ? flowers + (g.litter ? litter : 0) : 0;
    cover.geometry.clearGroups();
    if (shown === blades) {
      cover.geometry.addGroup(0, blades + rest, 0);
    } else {
      cover.geometry.addGroup(0, shown, 0);
      if (rest > 0) cover.geometry.addGroup(blades, rest, 0);
    }
  };

  return {
    land,
    cover,
    /** Grows the ground for a tree; the bounds it adds are returned to size the light. */
    setTree(tree: TreeModel, quality: Quality): GroundModel['bounds'] {
      model = growGround(
        {
          trunk: tree.nodes.radius[0]! * FLARE,
          front: Math.atan2(VIEW_DIRECTION[2], VIEW_DIRECTION[0]),
          rocks: tree.rocks.map((r) => r.bytes),
        },
        { seed: seedOf(tree), quality },
      );
      land.geometry.dispose();
      cover.geometry.dispose();
      land.geometry = pickable(geometryOf(model.land), model.land.rock, tree.nodes.folder.length);
      cover.geometry = geometryOf(model.cover).setAttribute(
        'aSway',
        new BufferAttribute(swayOf(model.cover), 1),
      );
      paint();
      return model.bounds;
    },
    setPalette(next: Palette) {
      palette = next;
      paint();
    },
    dispose() {
      land.geometry.dispose();
      cover.geometry.dispose();
      for (const m of [landMaterial, coverMaterial]) m.dispose();
    },
  };
}

function geometryOf(mesh: GroundMesh): BufferGeometry {
  return new BufferGeometry()
    .setAttribute('position', new BufferAttribute(mesh.position, 3))
    .setAttribute('normal', new BufferAttribute(mesh.normal, 3))
    .setAttribute(
      'aId',
      new BufferAttribute(
        mesh.rock.map((r) => (r < 0 ? -1 : 0)),
        1,
      ),
    );
}

/**
 * Gives the land the attributes the tree's id pass reads, already grown. A rock writes the
 * id after the tree's last node plus its index; everything else writes no id but still hides
 * what lies behind it.
 */
function pickable(geometry: BufferGeometry, rock: Float32Array, nodes: number): BufferGeometry {
  return geometry
    .setAttribute('aBase', geometry.getAttribute('position'))
    .setAttribute('aT', new BufferAttribute(new Float32Array(rock.length * 2), 2))
    .setAttribute(
      'aId',
      new BufferAttribute(
        rock.map((r) => (r < 0 ? -1 : nodes + r)),
        1,
      ),
    );
}

/** Per vertex, in linear color: its kind's palette color shifted by its tone. */
export function colors(mesh: GroundMesh, palette: Palette): Float32Array {
  const g = palette.ground;
  const parse = (hex: string) => new Color(hex);
  const base = {
    grass: parse(g.grass),
    meadow: parse(g.meadow),
    dirt: parse(g.dirt),
    soil: parse(g.soil),
    stone: parse(g.stone),
    rock: parse(g.rock),
    cap: parse(g.cap),
    blade: parse(g.blade),
  };
  const flowers = g.flowers.map(parse);
  const leaves = palette.leaves.slice(0, 5).map(parse);
  const out = new Float32Array(mesh.kind.length * 3);
  const c = new Color();
  for (let v = 0; v < mesh.kind.length; v++) {
    const tone = mesh.tone[v]!;
    const pick = mesh.pick[v]!;
    let spread = 0.08;
    switch (mesh.kind[v]) {
      case KIND.grass:
        c.copy(base.grass).lerp(base.meadow, 0.5 + 0.5 * tone);
        spread = 0.04;
        break;
      case KIND.dirt:
        c.copy(base.dirt);
        break;
      case KIND.soil:
        c.copy(base.soil);
        break;
      case KIND.stone:
        c.copy(base.stone);
        break;
      case KIND.rock:
        c.copy(base.rock);
        spread = 0.12;
        break;
      case KIND.cap:
        c.copy(base.cap);
        spread = 0.06;
        break;
      case KIND.blade:
        c.copy(base.blade);
        spread = 0.14;
        break;
      case KIND.flower:
        c.copy(flowers[Math.floor(pick * flowers.length)] ?? base.blade);
        spread = 0.12;
        break;
      case KIND.litter:
        c.copy(leaves[Math.floor(pick * leaves.length)]!);
        spread = 0.1;
        break;
    }
    c.multiplyScalar(1 + tone * spread);
    out[v * 3] = c.r;
    out[v * 3 + 1] = c.g;
    out[v * 3 + 2] = c.b;
  }
  return out;
}

/** The same repo always grows the same ground: a hash of its top-level folders and size. */
export function seedOf(tree: TreeModel): number {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  };
  for (const { folder, files } of tree.labels) mix(`${tree.folders.path[folder]}:${files};`);
  for (const rock of tree.rocks) mix(`${rock.bytes};`);
  return h >>> 0;
}

/**
 * How far each vertex of the cover stands above the root it sways from: a grass blade or a
 * flower's stem bends from its foot, so its tip sways most, and a flower's head (emitted just
 * after its stem) moves as one with the stem's tip. Fallen leaves lie still.
 */
export function swayOf(mesh: GroundMesh): Float32Array {
  const { position, kind } = mesh;
  const sway = new Float32Array(kind.length);
  let stem = 0;
  for (let v = 0; v + 2 < kind.length; v += 3) {
    if (kind[v] === KIND.flower) {
      sway.fill(stem, v, v + 3);
      continue;
    }
    if (kind[v] !== KIND.blade) continue;
    const ys = [position[3 * v + 1]!, position[3 * v + 4]!, position[3 * v + 7]!];
    const low = Math.min(...ys);
    stem = Math.max(...ys) - low;
    for (let c = 0; c < 3; c++) sway[v + c] = ys[c]! - low;
  }
  return sway;
}

/** A rock under the mouse (its pick id is `uHover`) lights up, as birds do. */
function fading<M extends MeshStandardMaterial>(material: M, key: string, sways = false): M {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSel = treeUniforms.uSel;
    shader.uniforms.uFade = treeUniforms.uFade;
    shader.uniforms.uHover = treeUniforms.uHover;
    if (sways) Object.assign(shader.uniforms, treeUniforms);
    shader.vertexShader =
      'attribute float aId;\nvarying float vId;\nvarying float vPick;\n' +
      (sways ? GROUND_SWAY.head : '') +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvId = aId < 0.0 ? -1.0 : 0.0;\nvPick = aId;' +
          (sways ? GROUND_SWAY.body : ''),
      );
    shader.fragmentShader =
      'uniform vec2 uSel;\nuniform vec3 uFade;\nuniform float uHover;\nvarying float vId;\nvarying float vPick;\n' +
      shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        FADE + HOVER_LIFT('uHover >= 0.0 && abs(vPick - uHover) < 0.5'),
      );
  };
  material.customProgramCacheKey = () => key;
  return material;
}
