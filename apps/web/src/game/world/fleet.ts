import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { identityColor } from '../../lib/identity.js';
import type { GameFrame, RiderVis } from '../director.js';
import { TANGENT_FRAME_GLSL } from './glsl.js';
import { clamp01, damp, lerp } from './math.js';
import type { Lighting } from './sky.js';

/**
 * The player fleet: one hull per rider, loaded from the Step-3 GLBs and lit by
 * a purpose-written ShaderMaterial so the identity accent rides the basecolor
 * alpha mask. The node/material contract is authored in the pipeline modules
 * (assets/ships/{fleet_config,import_base,finish,bake_export,validate_glb}.py):
 * root `Ship`, `nozzleL`/`nozzleR`, `coreMount`, optional `bridgeGlass`;
 * basecolor RGBA (alpha = accent mask), normal, ORM (R=AO G=rough B=metal),
 * emissive (engine rims only — blended in as-is, so the glow stays local).
 */
export const FLEET_HULLS = ['striker', 'challenger', 'zenith', 'insurgent'] as const;

/**
 * Formation slots in world units for a 9-unit hull: lead, starboard, port,
 * high-and-behind. Index = rider order in the session.
 */
export const FORMATION_SLOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [8, 2.5, -10],
  [-8, 2, -11],
  [0, 5, -20],
];

/** Guard sputter + over-target plume colour. */
const AMBER = new THREE.Color(0xfbbf24);

const SHIPS_BASE = '/assets/ships/';
/** Every hull is normalized to this length (nose −Z to tail +Z). */
const SHIP_TARGET_LENGTH = 9;
/** Nozzle mouth radius for a 9-unit hull: plume base and glow are sized off it. */
const NOZZLE_RADIUS = 0.34;
/** Plume length range as a fraction of ship length (plan: 0.15-0.6). */
const PLUME_MIN_FRACTION = 0.15;
const PLUME_MAX_FRACTION = 0.6;
/** Plume alpha at the nozzle mouth (plan: <= 0.6). */
const PLUME_BASE_ALPHA = 0.6;
/** Round nozzle glow diameter: 1.05x the nozzle mouth. */
const GLOW_WORLD_SIZE = NOZZLE_RADIUS * 2 * 1.05;
/** Peak additive alpha for the nozzle sprite: below the bloom threshold, so a
 *  wide engine cannot clip to a white blob (measured against bloom 0.86). */
const GLOW_MAX_ALPHA = 0.42;
/** Plume effort smoothing (the director's ratio is already smoothed at τ≈2 s). */
const PLUME_RATIO_TAU_S = 1;
/** Stopped riders peel away and fade over this long. */
const SHIP_STOP_FADE_S = 3;
const SHIP_STOP_FADE_MS = SHIP_STOP_FADE_S * 1000;

/** Effort → plume scale (moved verbatim from the deleted scene.ts). */
export function plumeEffortScale(ratio: number): number {
  if (ratio >= 1.1) return 1.4;
  if (ratio <= 0.55) return 0.7;
  if (ratio >= 1.0) return 1 + (0.4 * (ratio - 1)) / 0.1;
  return 0.7 + (0.3 * (ratio - 0.55)) / 0.45;
}

const HULL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  mat3 m = mat3(modelMatrix);
  vNormalW = normalize(m * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Hull shading: baked maps drive the surface, the scene lights integrate it.
 * Basecolor alpha is the accent mask (Step 3 livery contract), ORM packs
 * AO/roughness/metal, emissive carries the engine rims and bridge glass.
 */
const HULL_FRAG = /* glsl */ `
uniform sampler2D uBaseMap;
uniform sampler2D uNormalMap;
uniform sampler2D uOrmMap;
uniform sampler2D uEmissiveMap;
uniform vec3 uAccent;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uFillSky;
uniform vec3 uFillGround;
uniform vec3 uRimColor;
uniform float uRimGain;
uniform float uEmissiveGain;
uniform float uOpacity;
uniform vec3 uEnginePos[2];
uniform vec3 uEngineColor[2];
uniform float uEngineOn[2];
${TANGENT_FRAME_GLSL}
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec4 base = texture2D(uBaseMap, vUv);
  vec3 albedo = mix(base.rgb, uAccent, clamp(base.a, 0.0, 1.0));
  vec3 N = normalize(vNormalW);
  N = ocApplyNormalMap(uNormalMap, vUv, N, vWorldPos);
  vec3 orm = texture2D(uOrmMap, vUv).rgb;
  float ao = mix(1.0, orm.r, 0.85);
  float rough = clamp(orm.g, 0.08, 1.0);
  float metal = clamp(orm.b, 0.0, 1.0);

  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 key = uKeyColor * max(dot(N, uSunDir), 0.0);
  vec3 hemi = mix(uFillGround, uFillSky, N.y * 0.5 + 0.5);
  vec3 col = albedo * (key + hemi) * ao;

  // Blinn spec: tight on metal panels, broad and weak on paint.
  vec3 H = normalize(uSunDir + V);
  float specPower = exp2(1.0 + 9.0 * (1.0 - rough));
  float specGain = (0.03 + 0.42 * metal) * (0.4 + 0.6 * (1.0 - rough));
  col += uKeyColor * pow(max(dot(N, H), 0.0), specPower) * specGain;

  // Silhouette rim in the system accent: separates the hull from the void.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uRimColor * fres * uRimGain * (0.45 + 0.55 * metal);

  // Engine bounce: two analytic lights at the nozzle mouths, plume-coloured.
  for (int i = 0; i < 2; i++) {
    vec3 L = uEnginePos[i] - vWorldPos;
    float d = length(L);
    vec3 Ld = L / max(d, 0.001);
    float atten = uEngineOn[i] / (1.0 + 0.05 * d * d);
    col += uEngineColor[i] * albedo * atten * (0.3 + 0.7 * max(dot(N, Ld), 0.0));
  }

  col += texture2D(uEmissiveMap, vUv).rgb * uEmissiveGain;
  gl_FragColor = vec4(col, uOpacity);
}`;

const PLUME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uTime;
uniform float uEffort;
uniform float uSputter;
varying vec2 vUv;

void main() {
  float along = clamp(vUv.y, 0.0, 1.0);
  vec3 col = mix(uCore, uColor, 0.25 + 0.75 * pow(along, 0.6));
  // Bright at the nozzle mouth, gone by the tip.
  float fade = pow(1.0 - along, 2.2);
  float flicker = 0.86 + 0.14 * sin(uTime * 31.0 + along * 14.0 + vUv.x * 6.2831853);
  float a = uOpacity * fade * flicker;
  a *= 1.0 - uSputter * (0.55 + 0.45 * sin(uTime * 47.0 + along * 9.0));
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * a, a);
}`;

const PLUME_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Round nozzle glow: a screen-space sprite held at a constant world diameter. */
const GLOW_VERT = /* glsl */ `
uniform float uWorldSize;
uniform float uScreenScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp((uWorldSize * uScreenScale) / max(-mv.z, 1.0), 2.0, 220.0);
}`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uSputter;
uniform float uTime;
uniform float uMaxAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = smoothstep(0.5, 0.0, r);
  float a = (0.25 * core + 0.85 * core * core) * uOpacity;
  a *= 1.0 - uSputter * (0.5 + 0.5 * sin(uTime * 47.0));
  // Hard ceiling: the additive sprite must not clip to white under bloom.
  a = min(a, uMaxAlpha);
  vec3 col = mix(uColor, uCore, core * core);
  gl_FragColor = vec4(col * a, a);
}`;

interface HullAsset {
  root: THREE.Group;
  /** Plume anchors in the ship-root frame (post-normalization). */
  nozzles: THREE.Vector3[];
  baseMap: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  emissiveMap: THREE.Texture;
  /** Source materials + textures to release once the clones own the look. */
  textures: THREE.Texture[];
  materials: THREE.Material[];
}

interface ShipVis {
  riderId: string;
  root: THREE.Group;
  plumes: THREE.Mesh[];
  plumeMats: THREE.ShaderMaterial[];
  glows: THREE.Points[];
  glowMats: THREE.ShaderMaterial[];
  hullMat: THREE.ShaderMaterial;
  hullIndex: number;
  accent: THREE.Color;
  /** Smoothed plume effort (τ≈1 s). */
  effort: number;
  slot: readonly [number, number, number];
  phase: number;
  stoppedMs: number;
  fade: number;
  /** 1.2 s plume brightness boost from a clean leg. */
  pulseMs: number;
  state: RiderVis['state'];
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** 1×1 fallbacks so the hull shader never samples a null texture. */
function solidTexture(r: number, g: number, b: number, a: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Fleet {
  readonly group = new THREE.Group();
  private readonly ships = new Map<string, ShipVis>();
  private readonly hulls = new Map<string, HullAsset>();
  private readonly owned: THREE.DataTexture[] = [];
  private readonly plumeGeo: THREE.BufferGeometry;
  private readonly glowGeo: THREE.BufferGeometry;
  private readonly fallbackBase: THREE.DataTexture;
  private readonly fallbackNormal: THREE.DataTexture;
  private readonly fallbackOrm: THREE.DataTexture;
  private readonly fallbackEmissive: THREE.DataTexture;
  /** (internalHeight / 2) / tan(fovY / 2): world units -> device pixels. */
  private screenScale = 540;

  constructor() {
    // Base at the nozzle mouth, tip +1 along Z, open ended (additive cones).
    this.plumeGeo = new THREE.ConeGeometry(1, 1, 16, 4, true);
    this.plumeGeo.rotateX(Math.PI / 2);
    this.plumeGeo.translate(0, 0, 0.5);
    // One-vertex sprite geometry for the nozzle glow; the Points object is
    // positioned at the nozzle, so a single shared geometry serves every ship.
    this.glowGeo = new THREE.BufferGeometry();
    this.glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));

    this.fallbackBase = solidTexture(190, 196, 206, 0, true);
    this.fallbackNormal = solidTexture(128, 128, 255, 255, false);
    this.fallbackOrm = solidTexture(255, 140, 90, 255, false);
    this.fallbackEmissive = solidTexture(0, 0, 0, 255, true);
    this.owned.push(this.fallbackBase, this.fallbackNormal, this.fallbackOrm, this.fallbackEmissive);
  }

  /**
   * Load the four hull GLBs. A hull that fails to load is reported and skipped
   * (the fleet still flies with the rest); resolves true when any landed.
   */
  async load(): Promise<boolean> {
    const loader = new GLTFLoader();
    const results = await Promise.all(
      FLEET_HULLS.map(async (id) => {
        try {
          const gltf = await loader.loadAsync(`${SHIPS_BASE}${id}.glb`);
          return { id, root: gltf.scene as THREE.Group };
        } catch (err) {
          console.warn(`[fleet] hull ${id} failed to load`, err);
          return { id, root: null };
        }
      }),
    );
    for (const { id, root } of results) {
      if (root === null) continue;
      const asset = this.prepareHull(root);
      if (asset !== null) this.hulls.set(id, asset);
    }
    return this.hulls.size > 0;
  }

  private prepareHull(root: THREE.Group): HullAsset | null {
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    root.scale.setScalar(SHIP_TARGET_LENGTH / Math.max(size.z, 1e-3));
    root.updateMatrixWorld(true);

    const maps: {
      base: THREE.Texture | null;
      normal: THREE.Texture | null;
      orm: THREE.Texture | null;
      emissive: THREE.Texture | null;
    } = { base: null, normal: null, orm: null, emissive: null };
    const materials: THREE.Material[] = [];
    const textures: THREE.Texture[] = [];
    let meshCount = 0;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      meshCount += 1;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
        | THREE.MeshStandardMaterial
        | undefined;
      if (mat === undefined) return;
      if (!materials.includes(mat)) materials.push(mat);
      // The pipeline bakes one material kit per hull: the first basecolor map
      // found is the kit every mesh of this hull is shaded with.
      if (maps.base !== null || mat.map == null) return;
      maps.base = mat.map;
      maps.normal = mat.normalMap;
      maps.orm = mat.roughnessMap ?? mat.metalnessMap ?? mat.aoMap ?? null;
      maps.emissive = mat.emissiveMap;
    });
    if (meshCount === 0 || maps.base === null) {
      // No baked kit: the hull still flies on the neutral fallbacks.
      if (meshCount === 0) {
        console.warn('[fleet] hull has no meshes');
        return null;
      }
    }
    // Packed channels stay linear; basecolor/emissive keep the glTF sRGB flag
    // so the GPU decodes them exactly once.
    if (maps.normal != null) maps.normal.colorSpace = THREE.NoColorSpace;
    if (maps.orm != null) maps.orm.colorSpace = THREE.NoColorSpace;
    for (const t of [maps.base, maps.normal, maps.orm, maps.emissive]) {
      if (t != null && !textures.includes(t)) textures.push(t);
    }

    const nozzles: THREE.Vector3[] = [];
    for (const name of ['nozzleL', 'nozzleR']) {
      const node = root.getObjectByName(name);
      if (node !== undefined) nozzles.push(node.getWorldPosition(new THREE.Vector3()));
    }
    if (nozzles.length === 0) {
      // Single-engine or unnamed hulls: two plumes at the rear corners.
      const box = new THREE.Box3().setFromObject(root);
      const span = Math.max(box.max.x - box.min.x, 1);
      const y = (box.max.y + box.min.y) / 2;
      nozzles.push(new THREE.Vector3(-0.12 * span, y, box.max.z), new THREE.Vector3(0.12 * span, y, box.max.z));
    }

    return {
      root,
      nozzles,
      baseMap: maps.base ?? this.fallbackBase,
      normalMap: maps.normal ?? this.fallbackNormal,
      ormMap: maps.orm ?? this.fallbackOrm,
      emissiveMap: maps.emissive ?? this.fallbackEmissive,
      textures,
      materials,
    };
  }

  /** Device pixels covered by one world unit at one world unit of depth. */
  setScreenScale(scale: number): void {
    this.screenScale = scale;
  }

  /**
   * Drive the fleet from the director's frame. Riders are matched by id; the
   * formation slot and hull come from the rider's index.
   */
  update(frame: GameFrame, nowMs: number, dtS: number, lighting: Lighting, rung: number): void {
    this.syncRiders(frame.riders);

    const sync = frame.syncLit;
    for (const ship of this.ships.values()) {
      const vis = frame.riders.find((r) => r.riderId === ship.riderId);
      if (vis === undefined) continue;
      this.updateShip(ship, vis, nowMs, dtS, lighting, sync, rung);
    }
  }

  private syncRiders(riders: readonly RiderVis[]): void {
    for (let i = 0; i < riders.length; i++) {
      const vis = riders[i]!;
      const ship = this.ships.get(vis.riderId);
      if (ship === undefined) {
        const made = this.makeShip(vis.riderId, i);
        if (made !== null) this.ships.set(vis.riderId, made);
        continue;
      }
      ship.slot = this.slotFor(i);
    }
    if (this.ships.size > riders.length) {
      for (const [id, ship] of this.ships) {
        if (riders.some((r) => r.riderId === id)) continue;
        this.destroyShip(ship);
        this.ships.delete(id);
      }
    }
  }

  /** Formation slot for a rider index; riders past four fly the next lane back. */
  private slotFor(index: number): readonly [number, number, number] {
    const base = FORMATION_SLOTS[index % FORMATION_SLOTS.length]!;
    const lane = Math.floor(index / FORMATION_SLOTS.length);
    if (lane === 0) return base;
    return [base[0], base[1] + lane * 2.5, base[2] - lane * 8];
  }

  private makeShip(riderId: string, index: number): ShipVis | null {
    const hullIndex = index % FLEET_HULLS.length;
    const hullId = FLEET_HULLS[hullIndex]!;
    const asset = this.hulls.get(hullId);
    if (asset === undefined) return null;

    const accent = new THREE.Color(identityColor(index));
    const hullMat = new THREE.ShaderMaterial({
      uniforms: {
        uBaseMap: { value: asset.baseMap },
        uNormalMap: { value: asset.normalMap },
        uOrmMap: { value: asset.ormMap },
        uEmissiveMap: { value: asset.emissiveMap },
        uAccent: { value: accent.clone() },
        uKeyColor: { value: new THREE.Color(0xffffff) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uFillSky: { value: new THREE.Color(0x2b3a5c) },
        uFillGround: { value: new THREE.Color(0x05070c) },
        uRimColor: { value: new THREE.Color(0x9fb6ff) },
        uRimGain: { value: 0.5 },
        uEmissiveGain: { value: 1.5 },
        uEnginePos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        uEngineColor: { value: [new THREE.Color(), new THREE.Color()] },
        uEngineOn: { value: [0, 0] },
        uOpacity: { value: 1 },
      },
      vertexShader: HULL_VERT,
      fragmentShader: HULL_FRAG,
      // Opaque by default (light steel under key light, readable shadow side);
      // switched to transparent only while a stopped rider fades out.
      transparent: false,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    const hull = asset.root.clone(true);
    hull.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.material = hullMat;
    });

    const root = new THREE.Group();
    root.add(hull);
    const plumeMats: THREE.ShaderMaterial[] = [];
    const plumes: THREE.Mesh[] = [];
    const glowMats: THREE.ShaderMaterial[] = [];
    const glows: THREE.Points[] = [];
    for (let i = 0; i < 2; i++) {
      const anchor = asset.nozzles[Math.min(i, asset.nozzles.length - 1)]!;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: accent.clone() },
          uCore: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 0 },
          uTime: { value: 0 },
          uEffort: { value: 1 },
          uSputter: { value: 0 },
        },
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const plume = new THREE.Mesh(this.plumeGeo, mat);
      plume.position.copy(anchor);
      plume.renderOrder = 5;
      plumeMats.push(mat);
      plumes.push(plume);
      root.add(plume);

      const glowMat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: accent.clone() },
          uCore: { value: new THREE.Color(0xffffff) },
          uOpacity: { value: 0 },
          uSputter: { value: 0 },
          uTime: { value: 0 },
          uWorldSize: { value: GLOW_WORLD_SIZE },
          uScreenScale: { value: 540 },
          uMaxAlpha: { value: GLOW_MAX_ALPHA },
        },
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Points(this.glowGeo, glowMat);
      glow.position.copy(anchor);
      glow.renderOrder = 6;
      glow.frustumCulled = false;
      glowMats.push(glowMat);
      glows.push(glow);
      root.add(glow);
    }
    this.group.add(root);
    return {
      riderId,
      root,
      plumes,
      plumeMats,
      glows,
      glowMats,
      hullMat,
      hullIndex,
      accent,
      effort: 1,
      slot: this.slotFor(index),
      phase: index * 1.7,
      stoppedMs: -1,
      fade: 1,
      pulseMs: -1,
      state: 'riding',
    };
  }

  private updateShip(
    ship: ShipVis,
    vis: RiderVis,
    nowMs: number,
    dtS: number,
    lighting: Lighting,
    sync: boolean,
    rung: number,
  ): void {
    if (ship.state !== vis.state) {
      if (vis.state === 'stopped' && ship.stoppedMs < 0) ship.stoppedMs = nowMs;
      if (vis.state === 'riding') ship.stoppedMs = -1;
      ship.state = vis.state;
    }

    const peel = ship.stoppedMs < 0 ? 0 : clamp01((nowMs - ship.stoppedMs) / SHIP_STOP_FADE_MS);
    ship.fade = 1 - peel;
    const paused = vis.state === 'paused';

    // Idle sway and bank: never a static model on a rail.
    const t = nowMs * 0.001;
    const sway = Math.sin(t * 0.35 + ship.phase) * 0.55;
    const bob = Math.cos(t * 0.5 + ship.phase * 1.7) * 0.22;
    const bank = Math.max(-0.14, Math.min(0.12, (vis.ratio - 1) * 0.22)) + Math.sin(t * 0.28 + ship.phase) * 0.03;
    const drift = paused ? Math.sin(t * 0.12 + ship.phase) * 1.6 : 0;
    ship.root.position.set(
      ship.slot[0] + drift + peel * -1.8,
      ship.slot[1] + bob - peel * 5.5,
      ship.slot[2] + sway * 0.5 + peel * 7,
    );
    ship.root.rotation.set(
      Math.sin(t * 0.31 + ship.phase) * 0.045 + peel * 0.25,
      Math.sin(t * 0.22 + ship.phase * 0.6) * 0.05,
      bank + peel * 0.5,
    );
    ship.root.visible = ship.fade > 0.01;

    // Plume effort: engine brightness always below the director's ratio.
    ship.effort = damp(ship.effort, plumeEffortScale(vis.ratio), PLUME_RATIO_TAU_S, dtS);
    const effort = ship.effort;
    const effortT = clamp01((effort - 0.7) / 0.7);
    const pulse = ship.pulseMs < 0 ? 0 : clamp01(1 - (nowMs - ship.pulseMs) / 1200);
    const plumeLen =
      SHIP_TARGET_LENGTH * lerp(PLUME_MIN_FRACTION, PLUME_MAX_FRACTION, effortT) * (1 + pulse * 0.35) * (paused ? 0.55 : 1);
    const baseAlpha = PLUME_BASE_ALPHA * (paused ? 0.2 : 1) * ship.fade;

    ship.hullMat.uniforms.uOpacity!.value = ship.fade;
    // Opaque unless the ship is mid-fade, so the hull never reads translucent.
    const wantTransparent = ship.fade < 0.999;
    if (ship.hullMat.transparent !== wantTransparent) ship.hullMat.transparent = wantTransparent;
    (ship.hullMat.uniforms.uKeyColor!.value as THREE.Color).copy(lighting.key);
    (ship.hullMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
    (ship.hullMat.uniforms.uFillSky!.value as THREE.Color).copy(lighting.fillSky);
    (ship.hullMat.uniforms.uFillGround!.value as THREE.Color).copy(lighting.fillGround);
    (ship.hullMat.uniforms.uRimColor!.value as THREE.Color).copy(lighting.rim);
    // Co-op sync lights the hull's own practicals a little hotter.
    ship.hullMat.uniforms.uEmissiveGain!.value = sync ? 1.9 : 1.5;
    if (rung >= 4) ship.hullMat.uniforms.uRimGain!.value = 0.12;

    const engineOn = ship.hullMat.uniforms.uEngineOn!.value as number[];
    const enginePos = ship.hullMat.uniforms.uEnginePos!.value as THREE.Vector3[];
    const engineColor = ship.hullMat.uniforms.uEngineColor!.value as THREE.Color[];
    for (let i = 0; i < 2; i++) {
      const plume = ship.plumes[i]!;
      const mat = ship.plumeMats[i]!;
      const glowMat = ship.glowMats[i]!;
      const sputter = vis.guardActive ? 1 : 0;
      const color = vis.guardActive ? AMBER : ship.accent;
      plume.scale.set(NOZZLE_RADIUS, NOZZLE_RADIUS, Math.max(0.2, plumeLen));
      mat.uniforms.uOpacity!.value = baseAlpha;
      mat.uniforms.uTime!.value = nowMs * 0.001;
      mat.uniforms.uEffort!.value = effort;
      mat.uniforms.uSputter!.value = sputter;
      (mat.uniforms.uColor!.value as THREE.Color).copy(color);
      glowMat.uniforms.uOpacity!.value = clamp01(0.3 + 0.4 * ship.fade) * (paused ? 0.2 : 1);
      glowMat.uniforms.uSputter!.value = sputter;
      glowMat.uniforms.uTime!.value = nowMs * 0.001;
      glowMat.uniforms.uScreenScale!.value = this.screenScale;
      (glowMat.uniforms.uColor!.value as THREE.Color).copy(color);
      plume.getWorldPosition(enginePos[i]!);
      (engineColor[i] as THREE.Color).copy(color).multiplyScalar(baseAlpha * 0.9);
      engineOn[i] = ship.fade * (paused ? 0.2 : 1) * (0.3 + 0.7 * effortT) + pulse * 0.4;
    }
  }

  private destroyShip(ship: ShipVis): void {
    ship.root.removeFromParent();
    ship.hullMat.dispose();
    for (const mat of ship.plumeMats) mat.dispose();
    for (const mat of ship.glowMats) mat.dispose();
    this.group.remove(ship.root);
  }

  /** 1.2 s plume brightness pulse after a clean leg (plan §4 fx). */
  pulse(riderId: string, nowMs: number): void {
    const ship = this.ships.get(riderId);
    if (ship !== undefined) ship.pulseMs = nowMs;
  }

  /** World position of a rider's ship (fx anchors), or null when absent. */
  shipPosition(riderId: string, out: THREE.Vector3): THREE.Vector3 | null {
    const ship = this.ships.get(riderId);
    if (ship === undefined || !ship.root.visible) return null;
    return ship.root.getWorldPosition(out);
  }

  /** World position of a rider's engine mouths (fx anchors), or null when absent. */
  enginePosition(riderId: string, out: THREE.Vector3): THREE.Vector3 | null {
    const ship = this.ships.get(riderId);
    if (ship === undefined || !ship.root.visible) return null;
    ship.plumes[0]!.getWorldPosition(tmpA);
    ship.plumes[1]!.getWorldPosition(tmpB);
    return out.copy(tmpA).add(tmpB).multiplyScalar(0.5);
  }

  dispose(): void {
    for (const ship of this.ships.values()) this.destroyShip(ship);
    this.ships.clear();
    for (const asset of this.hulls.values()) {
      for (const mat of asset.materials) mat.dispose();
      for (const tex of asset.textures) tex.dispose();
    }
    this.hulls.clear();
    this.plumeGeo.dispose();
    this.glowGeo.dispose();
    for (const tex of this.owned) tex.dispose();
    this.group.clear();
  }
}
