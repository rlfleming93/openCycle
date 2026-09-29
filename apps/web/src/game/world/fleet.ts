import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { hashSeed } from '@opencycle/shared';

import { identityColor } from '../../lib/identity.js';
import type { GameFrame, RiderVis } from '../director.js';
import type { Engines, EngineSpec } from './engines.js';
import { attitudeTargets, barrelRoll, flyToward, legFlight, stepAngle, weave } from './flight.js';
import type { AngleState, Attitude, LegFlight } from './flight.js';
import { AMBIENT_GLSL, TANGENT_FRAME_GLSL } from './glsl.js';
import { clamp, clamp01, damp, lerp, radians, smoothstep } from './math.js';
import { Ribbon } from './ribbon.js';
import type { Lighting } from './sky.js';
import type { SparkSpec, Sparks } from './sparks.js';

/**
 * The player fleet: one hull per rider, loaded from the Step-3 GLBs and lit by
 * a purpose-written ShaderMaterial so the identity accent rides the basecolor
 * alpha mask. The node/material contract is authored in the pipeline modules
 * (assets/ships/{fleet_config,import_base,finish,bake_export,validate_glb}.py):
 * root `Ship`, `nozzleL`/`nozzleR`, `coreMount`, optional `bridgeGlass`;
 * basecolor RGBA (alpha = accent mask), normal, ORM (R=AO G=rough B=metal),
 * emissive (engine rims only — blended in as-is, so the glow stays local).
 *
 * Flight (world/flight.ts): every ship flies a seeded weave through flight
 * assist, faces its velocity and banks with its lateral acceleration; wingmen
 * overtake on burns. The throttle shows in the engines (idle orange-red, cruise
 * blue-white, on-target burn white-hot with shock diamonds), RCS thrusters puff
 * whenever the attitude springs work hard, each burn opens with a boost and
 * burns trail faint ion contrails.
 */
export const FLEET_HULLS = ['striker', 'challenger', 'zenith', 'insurgent'] as const;

/**
 * Formation slots in world units for a 9-unit hull: lead, starboard, port,
 * high-and-behind. Index = lane.
 */
export const FORMATION_SLOTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [9, 2.6, -8],
  [-7, 4.5, -12],
  [8, 5.5, -20],
];

/** Guard sputter + over-target plume colour. */
const AMBER = new THREE.Color(0xfbbf24);

const SHIPS_BASE = '/assets/ships/';
/** Every hull is normalized to this length (nose −Z to tail +Z). */
const SHIP_LENGTH = 9;
/** Nozzle mouth radius for a 9-unit hull: plume base and glow are sized off it. */
const NOZZLE_RADIUS = 0.34;
/** Plume length range as a fraction of ship length. */
const PLUME_MIN_FRACTION = 0.12;
const PLUME_MAX_FRACTION = 0.3;
/** Stopped riders peel away and fade over this long. */
const SHIP_STOP_FADE_MS = 3000;
/** Flight assist: translation spring (rad/s) and damping ratio (< 1 overshoots). */
const ASSIST_OMEGA = (2 * Math.PI) / 2.6;
const ASSIST_ZETA = 0.55;
const OVERTAKE_INTERVAL_MS = 40_000;
const OVERTAKE_MS = 4500;
/**
 * Overtakes pass clear: while the ships cross, the overtaker climbs and surges
 * and the others drop and ease (hull lengths), so the hulls pass at least 1.2
 * hull lengths apart; a lone wingman always passes over and ahead of the lead.
 */
const OVERTAKE_CLIMB = 0.3;
const OVERTAKE_DROP = 0.2;
/** Screen separation: hull boxes keep at least this gap (frame heights). */
const SEP_MARGIN = 0.02;
const BARREL_ROLL_MS = 1200;
const BARREL_RADIUS = 1.3;
/** Boost: engine flare and nozzle ring. */
const BOOST_MS = 600;
const RING_MS = 380;
/** Ion contrails: samples, spacing and how fast the wake streams aft. */
const TRAIL_POINTS = 22;
const TRAIL_STEP_S = 0.09;
const TRAIL_SPEED = 9;
/** RCS: attitude acceleration (rad/s²) that fires a thruster, and its refire gap. */
const RCS_ROLL_ACCEL = 4;
const RCS_YAW_ACCEL = 1.1;
const RCS_REFIRE_S = 0.1;

/** Throttle colours, linear HDR: idle, cruise, on-target burn. */
const IDLE_CORE = new THREE.Color(1.0, 0.42, 0.16).multiplyScalar(1.3);
const IDLE_EDGE = new THREE.Color(0.75, 0.13, 0.03);
const CRUISE_CORE = new THREE.Color(0.82, 0.9, 1.0).multiplyScalar(1.8);
const CRUISE_EDGE = new THREE.Color(0.2, 0.45, 1.0);
const BURN_CORE = new THREE.Color(1.0, 0.97, 0.92).multiplyScalar(3.6);
const BURN_EDGE = new THREE.Color(0.45, 0.65, 1.0).multiplyScalar(1.3);
const ION = new THREE.Color(0.3, 0.55, 1.0);
/** The nozzle core leans blue-white (idle stays orange-red). */
const NOZZLE_TINT = new THREE.Color(0.8, 0.9, 1.0);

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
 * AO/roughness/metal, emissive marks the engine faces. Light: the anchor key,
 * the sky's fill cube, a faint key-tinted rim, and a key back-light on the
 * silhouette when the hull sits between the camera and the anchor.
 * Transient lights: two plume-coloured engine bounces, an explosion flash, and
 * the frame shift charge shimmer.
 */
const HULL_FRAG = /* glsl */ `
uniform sampler2D uBaseMap;
uniform sampler2D uNormalMap;
uniform sampler2D uOrmMap;
uniform sampler2D uEmissiveMap;
uniform vec3 uAccent;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uAmbient[6];
uniform vec3 uRimColor;
uniform float uRimGain;
uniform float uEmissiveGain;
uniform float uOpacity;
uniform vec3 uEnginePos[2];
uniform vec3 uEngineColor[2];
uniform vec3 uFlashPos;
uniform vec3 uFlashColor;
uniform float uShimmer;
uniform float uTime;
${TANGENT_FRAME_GLSL}
${AMBIENT_GLSL}
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
  vec3 col = albedo * (key + ocAmbient(N, uAmbient)) * ao;

  // Blinn spec: tight on metal panels, broad and weak on paint.
  vec3 H = normalize(uSunDir + V);
  float specPower = exp2(1.0 + 9.0 * (1.0 - rough));
  float specGain = (0.03 + 0.42 * metal) * (0.4 + 0.6 * (1.0 - rough));
  col += uKeyColor * pow(max(dot(N, H), 0.0), specPower) * specGain;

  // Silhouette rim: separates the hull from the void. Backlit (the key behind
  // the hull) the edges catch the key itself.
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += uRimColor * fres * uRimGain * (0.45 + 0.55 * metal);
  col += uKeyColor * fres * max(dot(-V, uSunDir), 0.0) * (0.3 + 0.7 * smoothstep(-0.4, 0.4, dot(N, uSunDir))) * 0.35;

  // Engine bounce: two analytic lights at the nozzle mouths, plume-coloured.
  for (int i = 0; i < 2; i++) {
    vec3 L = uEnginePos[i] - vWorldPos;
    float d = length(L);
    float atten = 1.0 / (1.0 + 0.05 * d * d);
    col += uEngineColor[i] * albedo * atten * (0.3 + 0.7 * max(dot(N, L / max(d, 0.001)), 0.0));
  }

  // Explosion flash: a point light at the kill, faded by the caller.
  vec3 Lf = uFlashPos - vWorldPos;
  float df = length(Lf);
  col += uFlashColor * (albedo + 0.25) * max(dot(N, Lf / max(df, 0.001)), 0.0) / (1.0 + 0.00025 * df * df);

  // Frame shift charge: a cold blue shimmer crawling over the hull.
  if (uShimmer > 0.0) {
    float edge = pow(1.0 - max(dot(N, V), 0.0), 1.6);
    float crawl = 0.5 + 0.5 * sin(vWorldPos.z * 2.6 - uTime * 16.0 + 3.0 * sin(vWorldPos.x * 1.7 + uTime * 5.0));
    col += vec3(0.3, 0.58, 1.0) * uShimmer * (0.03 + edge * (0.2 + 1.1 * crawl * crawl * crawl));
  }

  // Engine faces: the emissive mask (its dark floor is no ambient) glows in
  // the engines' colour, capped and strongest at grazing angles, so it reads
  // as a glowing rim, never a flat white decal.
  vec3 em = texture2D(uEmissiveMap, vUv).rgb;
  float glow = smoothstep(0.12, 0.6, max(em.r, max(em.g, em.b)));
  vec3 engine = uEngineColor[0] + uEngineColor[1];
  float engineLum = dot(engine, vec3(0.2126, 0.7152, 0.0722));
  vec3 tint = engine * (min(engineLum, 0.1) / max(engineLum, 1e-4));
  col += tint * glow * uEmissiveGain * (0.3 + 2.2 * pow(1.0 - max(dot(N, V), 0.0), 2.0));
  gl_FragColor = vec4(col, uOpacity);
}`;

export interface HullAsset {
  root: THREE.Group;
  /** Plume anchors in the ship-root frame (post-normalization). */
  nozzles: THREE.Vector3[];
  /** Wing-root hardpoints: the nozzles mirrored forward. */
  hardpoints: THREE.Vector3[];
  /** RCS thrusters: nose, port tip, starboard tip, tail. */
  rcs: THREE.Vector3[];
  /** Bounding radius for framing (units). */
  radius: number;
  /** Hull bounds in the ship-root frame (screen boxes). */
  box: THREE.Box3;
  baseMap: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  emissiveMap: THREE.Texture;
  /** Source materials + textures to release once the clones own the look. */
  textures: THREE.Texture[];
  materials: THREE.Material[];
}

interface Trail {
  ribbon: Ribbon;
  /** Stored wake samples (xyz), newest first, advected aft each frame. */
  samples: Float32Array;
  count: number;
  sinceSampleS: number;
  path: Float32Array;
  widths: Float32Array;
  /** 0..1 visibility (fades in on burns, out after). */
  level: number;
}

interface ShipVis {
  riderId: string;
  index: number;
  root: THREE.Group;
  hullMat: THREE.ShaderMaterial;
  asset: HullAsset;
  accent: THREE.Color;
  seed: number;
  /** Smoothed plume effort (τ≈1 s) and throttle heat (0 idle, 1 cruise, 2 burn). */
  effort: number;
  heat: number;
  slot: readonly [number, number, number];
  /** The slot an overtake leaves: the ship eases across only once it is clear above or below. */
  slotFrom: readonly [number, number, number];
  flight: LegFlight;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  acc: THREE.Vector3;
  target: THREE.Vector3;
  yaw: AngleState;
  pitch: AngleState;
  roll: AngleState;
  rollStartMs: number;
  rollDir: number;
  overtakeMs: number;
  overtakeDir: number;
  boostMs: number;
  stoppedMs: number;
  fade: number;
  /** 1.2 s plume brightness boost from a clean leg. */
  pulseMs: number;
  state: RiderVis['state'];
  rcsCooldown: Float32Array;
  bounds: ShipBounds;
  /** Screen box half-size and centre offset from the ship's origin (frame heights), for the separation pass. */
  boxHalf: THREE.Vector2;
  boxOff: THREE.Vector2;
  /** Separation scratch: target depth and screen centre (frame heights). */
  sepDepth: number;
  sepX: number;
  sepY: number;
  trail: Trail;
}

/** A screen disc the wingmen keep off (the raider's reticle): centre in frame fractions, radius in frame heights. */
export interface ScreenDisc {
  x: number;
  y: number;
  r: number;
  on: boolean;
}

/** Framing bounds of one visible ship (the camera's keep-out guard, the raider's reticle). */
export interface ShipBounds {
  position: THREE.Vector3;
  radius: number;
  /** Screen box (last frame's camera) in frame fractions from the top-left; not `valid` behind the camera. */
  rect: { x0: number; y0: number; x1: number; y1: number; valid: boolean };
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const camFwd = new THREE.Vector3();
const camRight = new THREE.Vector3();
const camUp = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const PULL_AXIS = new THREE.Vector3(1, 0, 0);
const helix = new THREE.Vector3();

/** 1×1 fallbacks so the hull shader never samples a null texture. */
function solidTexture(r: number, g: number, b: number, a: number, srgb: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Load and normalize one hull GLB (9 units nose to tail): its baked map kit,
 * nozzles, wing-root hardpoints, RCS points and framing radius. Resolves null
 * (with a warning) when the file fails or has no meshes.
 */
export async function loadHull(url: string): Promise<HullAsset | null> {
  let root: THREE.Group;
  try {
    root = (await new GLTFLoader().loadAsync(url)).scene;
  } catch (err) {
    console.warn(`[fleet] hull ${url} failed to load`, err);
    return null;
  }
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  root.scale.setScalar(SHIP_LENGTH / Math.max(size.z, 1e-3));
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
  if (meshCount === 0) {
    console.warn(`[fleet] hull ${url} has no meshes`);
    return null;
  }
  // Packed channels stay linear; basecolor/emissive keep the glTF sRGB flag
  // so the GPU decodes them exactly once. Missing maps get 1×1 fallbacks.
  if (maps.normal != null) maps.normal.colorSpace = THREE.NoColorSpace;
  if (maps.orm != null) maps.orm.colorSpace = THREE.NoColorSpace;
  const baseMap = maps.base ?? solidTexture(190, 196, 206, 0, true);
  const normalMap = maps.normal ?? solidTexture(128, 128, 255, 255, false);
  const ormMap = maps.orm ?? solidTexture(255, 140, 90, 255, false);
  const emissiveMap = maps.emissive ?? solidTexture(0, 0, 0, 255, true);
  for (const t of [baseMap, normalMap, ormMap, emissiveMap]) {
    if (!textures.includes(t)) textures.push(t);
  }

  const box = new THREE.Box3().setFromObject(root);
  const nozzles: THREE.Vector3[] = [];
  for (const name of ['nozzleL', 'nozzleR']) {
    const node = root.getObjectByName(name);
    if (node !== undefined) nozzles.push(node.getWorldPosition(new THREE.Vector3()));
  }
  if (nozzles.length === 0) {
    // Single-engine or unnamed hulls: two plumes at the rear corners.
    const span = Math.max(box.max.x - box.min.x, 1);
    const y = (box.max.y + box.min.y) / 2;
    nozzles.push(new THREE.Vector3(-0.12 * span, y, box.max.z), new THREE.Vector3(0.12 * span, y, box.max.z));
  }
  if (nozzles.length === 1) nozzles.push(nozzles[0]!.clone());
  // Wing roots: each nozzle mirrored forward to mid-hull, a little outboard.
  const hardpoints = nozzles.map(
    (n) => new THREE.Vector3(Math.sign(n.x || 1) * Math.max(Math.abs(n.x) * 1.35, 0.8), n.y - 0.1, n.z - SHIP_LENGTH * 0.55),
  );
  const tipX = box.max.x * 0.92;
  const rcs = [
    new THREE.Vector3(0, 0.1, box.min.z + 0.4),
    new THREE.Vector3(-tipX, 0, 1.2),
    new THREE.Vector3(tipX, 0, 1.2),
    new THREE.Vector3(0, 0.5, box.max.z - 0.6),
  ];
  return {
    root,
    nozzles,
    hardpoints,
    rcs,
    radius: Math.max(box.max.x, box.max.z, box.max.y),
    box,
    baseMap,
    normalMap,
    ormMap,
    emissiveMap,
    textures,
    materials,
  };
}

/** The hull shader for one ship; `accent` fills the basecolor alpha mask. */
export function createHullMaterial(asset: HullAsset, accent: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBaseMap: { value: asset.baseMap },
      uNormalMap: { value: asset.normalMap },
      uOrmMap: { value: asset.ormMap },
      uEmissiveMap: { value: asset.emissiveMap },
      uAccent: { value: accent.clone() },
      uKeyColor: { value: new THREE.Color(0xffffff) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uAmbient: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
      uRimColor: { value: new THREE.Color(0x9fb6ff) },
      uRimGain: { value: 0.5 },
      uEmissiveGain: { value: 1.5 },
      uEnginePos: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uEngineColor: { value: [new THREE.Color(), new THREE.Color()] },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashColor: { value: new THREE.Color(0, 0, 0) },
      uShimmer: { value: 0 },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: HULL_VERT,
    fragmentShader: HULL_FRAG,
    // Opaque by default; the fleet switches a ship to transparent only while a
    // stopped rider fades out.
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
}

/** Copy the shared key/fill/rim lighting into a hull material. */
export function lightHull(mat: THREE.ShaderMaterial, lighting: Lighting): void {
  const u = mat.uniforms;
  (u.uKeyColor!.value as THREE.Color).copy(lighting.key);
  (u.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
  // The sky fill updates in place once the sky bake lands: bind by reference.
  u.uAmbient!.value = lighting.ambient;
  (u.uRimColor!.value as THREE.Color).copy(lighting.rim);
}

export function disposeHull(asset: HullAsset): void {
  for (const mat of asset.materials) mat.dispose();
  for (const tex of asset.textures) tex.dispose();
}

export class Fleet {
  readonly group = new THREE.Group();
  /** Visible ships' framing spheres, refreshed every update. */
  readonly bounds: ShipBounds[] = [];
  /** Camera position for ribbon facing (GameWorld copies it in before update). */
  readonly cameraPosition = new THREE.Vector3();
  private readonly ships = new Map<string, ShipVis>();
  private readonly hulls = new Map<string, HullAsset>();
  private readonly engines: Engines;
  private readonly sparks: Sparks;
  /** Shared formation weave: the whole fleet maneuvers together. */
  private flight: LegFlight = legFlight(null, 0.5);
  private fleetSeed = 1;
  private legKey = '';
  private nextOvertakeMs = -1;
  /** Wingman lane per rider; rotated on overtakes, never for the lead. */
  private readonly laneByRider = new Map<string, number>();
  private readonly shared = new THREE.Vector3();
  private readonly attitude: Attitude = { yaw: 0, pitch: 0, roll: 0 };
  private readonly flashPos = new THREE.Vector3();
  private flashMs = -1;
  private charge = 0;
  private tunnel = 0;
  private readonly spec: EngineSpec = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    radius: NOZZLE_RADIUS,
    length: 1,
    core: new THREE.Color(),
    edge: new THREE.Color(),
    opacity: 0,
    heat: 1,
    sputter: 0,
    glowSize: 1,
    glowAlpha: 1,
    glowColor: new THREE.Color(),
    ring: -1,
    seed: 0,
  };
  private readonly puff: SparkSpec = {
    size0: 0.3,
    size1: 1.5,
    lifeS: 0.38,
    color: new THREE.Color(0.9, 0.94, 1.0).multiplyScalar(1.1),
    alpha: 0.5,
    hard: 0,
    drag: 3.5,
    flicker: 0,
  };
  private readonly trailColor = new THREE.Color();
  /** Separation pass scratch: the visible ships in index order. */
  private readonly sepList: ShipVis[] = [];

  constructor(engines: Engines, sparks: Sparks) {
    this.engines = engines;
    this.sparks = sparks;
  }

  /**
   * Load the four hull GLBs. A hull that fails to load is reported and skipped
   * (the fleet still flies with the rest); resolves true when any landed.
   */
  async load(): Promise<boolean> {
    const assets = await Promise.all(FLEET_HULLS.map((id) => loadHull(`${SHIPS_BASE}${id}.glb`)));
    FLEET_HULLS.forEach((id, i) => {
      const asset = assets[i];
      if (asset != null) this.hulls.set(id, asset);
    });
    return this.hulls.size > 0;
  }

  /** True once any hull has loaded (the session-start jump waits for it). */
  get ready(): boolean {
    return this.hulls.size > 0;
  }

  /** Frame shift sequence: charge 0..1 (shimmer, hot engines), tunnel 0..1. */
  setJump(charge: number, tunnel: number): void {
    this.charge = charge;
    this.tunnel = tunnel;
  }

  /**
   * Drive the fleet from the director's frame. Ships chase a moving target
   * (slot + formation weave + own weave) through flight assist, face their
   * velocity and bank into their turns; wingmen rotate slots while burning.
   */
  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    lighting: Lighting,
    rung: number,
    camera: THREE.PerspectiveCamera,
    reticle: ScreenDisc,
  ): void {
    this.syncRiders(frame, nowMs);
    this.updateLeg(frame, nowMs);

    const tS = nowMs * 0.001;
    const f = this.flight;
    const s = this.fleetSeed;
    // Formation weave: every ship shares it, so the fleet banks together.
    this.shared.set(
      weave(s, tS, f.periodS) * f.lateral * 0.72,
      weave(s + 1.7, tS, f.periodS * 1.3) * f.lateral * 0.26,
      weave(s + 3.1, tS, f.periodS * 1.7) * f.lateral * 0.22,
    );

    const flashK = this.flashMs < 0 ? 0 : 1 - clamp01((nowMs - this.flashMs) / 900);
    if (this.flashMs >= 0 && flashK <= 0) this.flashMs = -1;

    this.bounds.length = 0;
    const burning = frame.legKind === 'burn';
    // Aim every ship, part them on screen, then fly them.
    for (const ship of this.ships.values()) {
      const vis = frame.riders.find((r) => r.riderId === ship.riderId);
      if (vis !== undefined) this.aimShip(ship, vis, nowMs);
    }
    this.separate(camera, reticle);
    for (const ship of this.ships.values()) {
      const vis = frame.riders.find((r) => r.riderId === ship.riderId);
      if (vis === undefined) continue;
      this.updateShip(ship, vis, nowMs, dtS, lighting, frame.syncLit, rung, burning, flashK, camera);
    }
  }

  /** New leg: reseed the formation weave and every ship's own line. */
  private updateLeg(frame: GameFrame, nowMs: number): void {
    const key = `${frame.legIndex ?? -1}:${frame.legKind ?? 'none'}`;
    if (key !== this.legKey) {
      this.legKey = key;
      const hash = hashSeed(`${frame.seed}:weave:${key}`);
      this.fleetSeed = 1 + (hash % 997) / 97;
      this.flight = legFlight(frame.legKind, (hash % 1000) / 1000);
      for (const ship of this.ships.values()) {
        ship.flight = legFlight(frame.legKind, (hashSeed(`${ship.riderId}:${key}`) % 1000) / 1000);
      }
    }
    this.updateOvertakes(frame, nowMs);
  }

  /** Every riding ship boosts: engine flare, nozzle ring (camera + field add theirs). */
  boost(nowMs: number): void {
    for (const ship of this.ships.values()) {
      if (ship.state === 'riding') ship.boostMs = nowMs;
    }
  }

  /** Wingmen overtake and swap slots about every 40 s while burning. */
  private updateOvertakes(frame: GameFrame, nowMs: number): void {
    if (frame.legKind !== 'burn') {
      this.nextOvertakeMs = -1;
      return;
    }
    if (this.nextOvertakeMs < 0) {
      this.nextOvertakeMs = nowMs + OVERTAKE_INTERVAL_MS * 0.5;
      return;
    }
    if (nowMs < this.nextOvertakeMs) return;
    this.nextOvertakeMs = nowMs + OVERTAKE_INTERVAL_MS;
    // Rotate the wingman lanes (a lone wingman crosses over); the lead keeps
    // lane 0 so its screen box holds. The ship moving up the formation climbs
    // over the others and boosts through; the rest drop under. A lone wingman
    // always passes over the lead.
    const wingmen = [...this.ships.values()].filter((s) => s.index > 0 && s.state === 'riding');
    if (wingmen.length === 0) return;
    const lanes = wingmen.map((s) => this.laneByRider.get(s.riderId) ?? s.index);
    for (let i = 0; i < wingmen.length; i++) {
      const ship = wingmen[i]!;
      const next = wingmen.length === 1 ? (lanes[0] === 1 ? 2 : 1) : lanes[(i + 1) % wingmen.length]!;
      const from = this.slotFor(lanes[i]!);
      const to = this.slotFor(next);
      this.laneByRider.set(ship.riderId, next);
      ship.slotFrom = from;
      ship.slot = to;
      ship.overtakeMs = nowMs;
      ship.overtakeDir = wingmen.length === 1 || to[2] < from[2] ? 1 : -1;
      if (ship.overtakeDir > 0) ship.boostMs = nowMs;
    }
  }

  /** Mean position of the visible ships (the chase camera's anchor). */
  fleetCenter(out: THREE.Vector3): THREE.Vector3 | null {
    out.set(0, 0, 0);
    let n = 0;
    for (const ship of this.ships.values()) {
      if (!ship.root.visible || ship.stoppedMs >= 0) continue;
      out.add(ship.pos);
      n += 1;
    }
    return n === 0 ? null : out.multiplyScalar(1 / n);
  }

  /** Mean yaw and roll of the riding ships (the chase camera lags these). */
  fleetAttitude(out: Attitude): Attitude {
    out.yaw = 0;
    out.pitch = 0;
    out.roll = 0;
    let n = 0;
    for (const ship of this.ships.values()) {
      if (!ship.root.visible || ship.stoppedMs >= 0) continue;
      out.yaw += ship.yaw.angle;
      out.pitch += ship.pitch.angle;
      out.roll += ship.roll.angle;
      n += 1;
    }
    if (n > 0) {
      out.yaw /= n;
      out.pitch /= n;
      out.roll /= n;
    }
    return out;
  }

  /** Barrel roll for a clean survey (any leg kind). */
  rollPulse(riderId: string, nowMs: number): void {
    const ship = this.ships.get(riderId);
    if (ship === undefined || ship.state !== 'riding') return;
    ship.rollStartMs = nowMs;
    ship.rollDir = ship.index % 2 === 0 ? 1 : -1;
  }

  /** Light the fleet from an explosion at `position` (fades over ~0.9 s). */
  flash(position: THREE.Vector3, nowMs: number): void {
    this.flashPos.copy(position);
    this.flashMs = nowMs;
  }

  private syncRiders(frame: GameFrame, nowMs: number): void {
    const riders = frame.riders;
    for (let i = 0; i < riders.length; i++) {
      const vis = riders[i]!;
      if (this.ships.has(vis.riderId)) continue;
      const made = this.makeShip(vis.riderId, i, frame);
      if (made === null) continue;
      this.ships.set(vis.riderId, made);
      this.laneByRider.set(vis.riderId, i);
    }
    if (this.nextOvertakeMs < 0 && frame.legKind === 'burn') this.nextOvertakeMs = nowMs + OVERTAKE_INTERVAL_MS * 0.5;
    if (this.ships.size > riders.length) {
      for (const [id, ship] of this.ships) {
        if (riders.some((r) => r.riderId === id)) continue;
        this.destroyShip(ship);
        this.ships.delete(id);
        this.laneByRider.delete(id);
      }
    }
  }

  /** Formation slot for a lane; lanes past four fly the next rank back. */
  private slotFor(lane: number): readonly [number, number, number] {
    const base = FORMATION_SLOTS[lane % FORMATION_SLOTS.length]!;
    const rank = Math.floor(lane / FORMATION_SLOTS.length);
    if (rank === 0) return base;
    return [base[0], base[1] + rank * 2.5, base[2] - rank * 8];
  }

  private makeShip(riderId: string, index: number, frame: GameFrame): ShipVis | null {
    const hullId = FLEET_HULLS[index % FLEET_HULLS.length]!;
    const asset = this.hulls.get(hullId);
    if (asset === undefined) return null;

    const accent = new THREE.Color(identityColor(index));
    const hullMat = createHullMaterial(asset, accent);
    const hull = asset.root.clone(true);
    hull.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.material = hullMat;
    });

    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    root.add(hull);
    this.group.add(root);

    const ribbon = new Ribbon(TRAIL_POINTS, 1);
    ribbon.material.uniforms.uFeather!.value = 0.5;
    this.group.add(ribbon.object);

    const slot = this.slotFor(index);
    const legKey = `${frame.legIndex ?? -1}:${frame.legKind ?? 'none'}`;
    return {
      riderId,
      index,
      root,
      hullMat,
      asset,
      accent,
      seed: 1 + index * 1.618,
      effort: 1,
      heat: 1,
      slot,
      slotFrom: slot,
      flight: legFlight(frame.legKind, (hashSeed(`${riderId}:${legKey}`) % 1000) / 1000),
      pos: new THREE.Vector3(...slot),
      vel: new THREE.Vector3(),
      acc: new THREE.Vector3(),
      target: new THREE.Vector3(...slot),
      yaw: { angle: 0, rate: 0 },
      pitch: { angle: 0, rate: 0 },
      roll: { angle: 0, rate: 0 },
      rollStartMs: -1,
      rollDir: 1,
      overtakeMs: -1,
      overtakeDir: 1,
      boostMs: -1,
      stoppedMs: -1,
      fade: 1,
      pulseMs: -1,
      state: 'riding',
      rcsCooldown: new Float32Array(4),
      bounds: { position: root.position, radius: asset.radius, rect: { x0: 0, y0: 0, x1: 0, y1: 0, valid: false } },
      boxHalf: new THREE.Vector2(),
      boxOff: new THREE.Vector2(),
      sepDepth: 0,
      sepX: 0,
      sepY: 0,
      trail: {
        ribbon,
        samples: new Float32Array(TRAIL_POINTS * 3),
        count: 0,
        sinceSampleS: 0,
        path: new Float32Array(TRAIL_POINTS * 3),
        widths: new Float32Array(TRAIL_POINTS),
        level: 0,
      },
    };
  }

  /**
   * The ship's target: slot + formation weave + its own line + overtake arc.
   * An overtake first lifts the ship clear (see OVERTAKE_CLIMB), eases it
   * across to its new slot while clear, then settles it.
   */
  private aimShip(ship: ShipVis, vis: RiderVis, nowMs: number): void {
    if (ship.state !== vis.state) {
      if (vis.state === 'stopped' && ship.stoppedMs < 0) ship.stoppedMs = nowMs;
      if (vis.state === 'riding') ship.stoppedMs = -1;
      ship.state = vis.state;
    }
    const paused = vis.state === 'paused';
    const tS = nowMs * 0.001;
    const own = ship.flight;
    const k = paused ? 0 : 1;
    let across = 1;
    let lift = 0;
    let surge = 0;
    if (ship.overtakeMs >= 0) {
      const t = (nowMs - ship.overtakeMs) / OVERTAKE_MS;
      if (t >= 1) ship.overtakeMs = -1;
      else {
        across = smoothstep(0.25, 0.75, t);
        lift = smoothstep(0, 0.3, t) * (1 - smoothstep(0.7, 1, t));
        surge = Math.sin(Math.PI * t);
      }
    }
    const from = ship.slotFrom;
    const to = ship.slot;
    ship.target.set(
      lerp(from[0], to[0], across) + (this.shared.x + weave(ship.seed, tS, own.periodS * 0.55) * own.lateral * 0.32) * k,
      lerp(from[1], to[1], across) + (this.shared.y + weave(ship.seed + 0.9, tS, own.periodS * 0.7) * own.lateral * 0.14) * k,
      lerp(from[2], to[2], across) + (this.shared.z + weave(ship.seed + 2.3, tS, own.periodS * 0.8) * own.lateral * 0.25) * k,
    );
    ship.target.y += (ship.overtakeDir > 0 ? OVERTAKE_CLIMB : -OVERTAKE_DROP) * SHIP_LENGTH * lift;
    ship.target.z += (ship.overtakeDir > 0 ? -7 : 3.5) * surge;
    // Paused ships throttle back and drift aft of the formation, level.
    if (paused) ship.target.z += 7;
    const boostT = ship.boostMs < 0 ? 1 : (nowMs - ship.boostMs) / 1000;
    if (boostT < 1.6) ship.target.z -= 3.2 * Math.sin(Math.PI * clamp01(boostT / 1.6));
  }

  /**
   * Screen separation in whatever shot the camera flies: a ship whose target
   * (with its current screen box) would overlap an earlier ship's box is
   * pushed straight away from it along the line between their centres, just
   * far enough to clear by SEP_MARGIN, and every wingman is pushed off the
   * reticle disc, all in the camera's screen plane at the ship's own depth.
   * The lead (index 0) never moves; wingmen yield in index order.
   */
  private separate(camera: THREE.PerspectiveCamera, reticle: ScreenDisc): void {
    const list = this.sepList;
    list.length = 0;
    for (const ship of this.ships.values()) {
      if (ship.root.visible && ship.stoppedMs < 0 && ship.bounds.rect.valid) list.push(ship);
    }
    if (list.length < 2) return;
    list.sort((a, b) => a.index - b.index);
    const aspect = camera.aspect;
    const unit = 2 * Math.tan((camera.fov * Math.PI) / 360);
    camera.getWorldDirection(camFwd);
    camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    for (const s of list) {
      s.sepDepth = tmpA.copy(s.target).sub(camera.position).dot(camFwd);
      tmpA.copy(s.target).project(camera);
      s.sepX = (tmpA.x * 0.5 + 0.5) * aspect + s.boxOff.x;
      s.sepY = 0.5 - tmpA.y * 0.5 + s.boxOff.y;
    }
    const rx = reticle.x * aspect;
    const ry = reticle.y;
    const clear = reticle.r + SEP_MARGIN;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.sepDepth < 1) continue;
        for (let i = 0; i < j; i++) {
          const a = list[i]!;
          if (a.sepDepth < 1) continue;
          const cx = b.sepX - a.sepX;
          const cy = b.sepY - a.sepY;
          const w = a.boxHalf.x + b.boxHalf.x + SEP_MARGIN;
          const h = a.boxHalf.y + b.boxHalf.y + SEP_MARGIN;
          if (Math.abs(cx) >= w || Math.abs(cy) >= h) continue;
          // Scale the centre offset until one axis clears; stacked dead on, go up.
          const stacked = Math.abs(cx) + Math.abs(cy) < 1e-4;
          const s = Math.min(w / Math.max(Math.abs(cx), 1e-4), h / Math.max(Math.abs(cy), 1e-4));
          this.nudge(b, stacked ? 0 : cx * (s - 1), stacked ? -h : cy * (s - 1), unit);
        }
        if (!reticle.on) continue;
        // Off the reticle: the box's nearest point to the disc centre clears it.
        let ux = clamp(rx, b.sepX - b.boxHalf.x, b.sepX + b.boxHalf.x) - rx;
        let uy = clamp(ry, b.sepY - b.boxHalf.y, b.sepY + b.boxHalf.y) - ry;
        const d = Math.hypot(ux, uy);
        if (d >= clear) continue;
        let push = clear - d;
        if (d > 1e-4) {
          ux /= d;
          uy /= d;
        } else {
          // The disc centre sits inside the box: leave on the box centre's side.
          ux = b.sepX - rx;
          uy = b.sepY - ry;
          const c = Math.hypot(ux, uy);
          if (c < 1e-4) {
            ux = 0;
            uy = 1;
          } else {
            ux /= c;
            uy /= c;
          }
          push = clear + Math.abs(ux) * b.boxHalf.x + Math.abs(uy) * b.boxHalf.y - c;
        }
        this.nudge(b, ux * push, uy * push, unit);
      }
    }
  }

  /** Shift a ship's separation centre and its target by (px, py) frame heights on screen. */
  private nudge(ship: ShipVis, px: number, py: number, unit: number): void {
    ship.sepX += px;
    ship.sepY += py;
    const scale = ship.sepDepth * unit;
    ship.target.addScaledVector(camRight, px * scale).addScaledVector(camUp, -py * scale);
  }

  /**
   * The ship's screen box through the camera (last frame's pose of it: one
   * frame stale, invisible): its six hull extremities projected, in frame
   * fractions from the top-left, plus the half-size and centre offset the
   * separation pass works in (frame heights).
   */
  private screenBox(ship: ShipVis, camera: THREE.PerspectiveCamera): void {
    const rect = ship.bounds.rect;
    rect.valid = false;
    const box = ship.asset.box;
    const c = box.getCenter(tmpB);
    const m = ship.root.matrixWorld;
    camera.getWorldDirection(camFwd);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 6; i++) {
      const axis = i >> 1;
      tmpA.copy(c).setComponent(axis, (i & 1 ? box.max : box.min).getComponent(axis)).applyMatrix4(m);
      if (tmpC.copy(tmpA).sub(camera.position).dot(camFwd) < 1) return;
      tmpA.project(camera);
      x0 = Math.min(x0, tmpA.x);
      x1 = Math.max(x1, tmpA.x);
      y0 = Math.min(y0, tmpA.y);
      y1 = Math.max(y1, tmpA.y);
    }
    rect.x0 = x0 * 0.5 + 0.5;
    rect.x1 = x1 * 0.5 + 0.5;
    rect.y0 = 0.5 - y1 * 0.5;
    rect.y1 = 0.5 - y0 * 0.5;
    rect.valid = true;
    const aspect = camera.aspect;
    tmpA.copy(ship.root.position).project(camera);
    ship.boxHalf.set(((rect.x1 - rect.x0) / 2) * aspect, (rect.y1 - rect.y0) / 2);
    ship.boxOff.set(((rect.x0 + rect.x1) / 2 - (tmpA.x * 0.5 + 0.5)) * aspect, (rect.y0 + rect.y1) / 2 - (0.5 - tmpA.y * 0.5));
  }

  private updateShip(
    ship: ShipVis,
    vis: RiderVis,
    nowMs: number,
    dtS: number,
    lighting: Lighting,
    sync: boolean,
    rung: number,
    burning: boolean,
    flashK: number,
    camera: THREE.PerspectiveCamera,
  ): void {
    const peel = ship.stoppedMs < 0 ? 0 : clamp01((nowMs - ship.stoppedMs) / SHIP_STOP_FADE_MS);
    ship.fade = 1 - peel;
    const paused = vis.state === 'paused';
    const tS = nowMs * 0.001;
    const own = ship.flight;

    flyToward(ship.pos, ship.vel, ship.acc, ship.target, ASSIST_OMEGA, ASSIST_ZETA, own.accel, dtS);
    attitudeTargets(ship.vel, ship.acc, own.bank, this.attitude);
    const aYaw = stepAngle(ship.yaw, this.attitude.yaw, 5, 0.8, 5, dtS);
    stepAngle(ship.pitch, this.attitude.pitch, 5, 0.8, 5, dtS);
    const aRoll = stepAngle(ship.roll, this.attitude.roll, 6.5, 0.55, 12, dtS);

    // Barrel roll: a full roll around a helix, on top of flight assist. Its
    // angular acceleration (quintic ease) fires the wingtips at entry and exit.
    let spin = 0;
    let spinAccel = 0;
    helix.set(0, 0, 0);
    if (ship.rollStartMs >= 0) {
      const t = (nowMs - ship.rollStartMs) / BARREL_ROLL_MS;
      if (t >= 1) ship.rollStartMs = -1;
      else {
        spin = barrelRoll(t, BARREL_RADIUS, ship.rollDir, helix);
        const secS = BARREL_ROLL_MS / 1000;
        spinAccel = (ship.rollDir * 2 * Math.PI * (120 * t * t * t - 180 * t * t + 60 * t)) / (secS * secS);
      }
    }

    const root = ship.root;
    root.position.set(ship.pos.x + helix.x - peel * 1.8, ship.pos.y + helix.y - peel * 5.5, ship.pos.z + peel * 7);
    // Pull through the turn: the nose rises in the banked frame.
    const pullUp = (Math.abs(ship.roll.angle) / Math.max(own.bank, 0.1)) * radians(5);
    euler.set(ship.pitch.angle + peel * 0.25, ship.yaw.angle, ship.roll.angle + spin + peel * 0.5);
    root.quaternion.setFromEuler(euler).multiply(tmpQ.setFromAxisAngle(PULL_AXIS, pullUp));
    root.visible = ship.fade > 0.01;
    root.updateMatrixWorld();
    this.screenBox(ship, camera);
    if (root.visible && ship.stoppedMs < 0) this.bounds.push(ship.bounds);

    // RCS: thrusters fire when the attitude springs work hard or a roll starts.
    if (root.visible && !paused) this.fireRcs(ship, aRoll + spinAccel, aYaw, dtS);

    // Throttle: idle when paused or stopped pedalling, blue-white cruise, and
    // white-hot on an in-band burn. The frame shift runs everything hot.
    const heatTarget = paused || vis.cruise <= 0 ? 0 : burning && vis.inBand ? 2 : 1;
    ship.heat = damp(ship.heat, Math.max(heatTarget, this.tunnel * 2, this.charge * 1.6), 0.6, dtS);
    ship.effort = damp(ship.effort, plumeEffortScale(vis.ratio), 1, dtS);
    const effortT = clamp01((ship.effort - 0.7) / 0.7);
    const pulse = ship.pulseMs < 0 ? 0 : clamp01(1 - (nowMs - ship.pulseMs) / 1200);
    const boostMs = ship.boostMs < 0 ? Infinity : nowMs - ship.boostMs;
    const flare = boostMs < BOOST_MS ? Math.sin(Math.PI * Math.min(1, boostMs / 80) * 0.5) * (1 - boostMs / BOOST_MS) : 0;
    const ring = boostMs < RING_MS ? boostMs / RING_MS : -1;
    const heat = ship.heat;
    const guard = vis.guardActive;
    const spec = this.spec;
    if (guard) {
      spec.core.copy(AMBER).multiplyScalar(1.6);
      spec.edge.copy(AMBER);
    } else if (heat <= 1) {
      spec.core.lerpColors(IDLE_CORE, CRUISE_CORE, heat);
      spec.edge.lerpColors(IDLE_EDGE, CRUISE_EDGE, heat);
    } else {
      spec.core.lerpColors(CRUISE_CORE, BURN_CORE, heat - 1);
      spec.edge.lerpColors(CRUISE_EDGE, BURN_EDGE, heat - 1);
    }
    const brightness = lerp(0.75, 1.2, effortT) * (1 + pulse * 0.4 + flare * 1.2 + this.charge * 0.8);
    spec.core.multiplyScalar(brightness);
    spec.glowColor.copy(spec.core).multiply(NOZZLE_TINT);
    const lengthK = (paused ? 0.55 : 1) * (1 + 0.35 * clamp01(heat - 1)) * (1 + pulse * 0.35 + flare * 0.9 + this.tunnel * 0.8);
    spec.length = SHIP_LENGTH * lerp(PLUME_MIN_FRACTION, PLUME_MAX_FRACTION, effortT) * lengthK;
    spec.radius = NOZZLE_RADIUS * (1 + flare * 0.35);
    spec.opacity = ship.fade * (paused ? 0.25 : 0.4 + 0.25 * clamp01(heat - 1));
    spec.heat = heat;
    spec.sputter = guard ? 1 : 0;
    spec.glowAlpha = ship.fade * (paused ? 0.3 : lerp(0.35, 1, clamp01(heat)) * (1 + flare));
    // The nozzle core stays inside the nozzle's own diameter (a boost flares it).
    spec.glowSize = NOZZLE_RADIUS * 2 * (0.6 + 0.15 * heat) * (1 + flare * 1.6);
    spec.ring = ring;
    spec.quaternion.copy(root.quaternion);

    const u = ship.hullMat.uniforms;
    const enginePos = u.uEnginePos!.value as THREE.Vector3[];
    const engineColor = u.uEngineColor!.value as THREE.Color[];
    for (let i = 0; i < 2; i++) {
      spec.position.copy(ship.asset.nozzles[i]!).applyMatrix4(root.matrixWorld);
      spec.seed = ship.index * 2 + i;
      if (root.visible) this.engines.add(spec);
      enginePos[i]!.copy(spec.position);
      engineColor[i]!.copy(spec.core).multiplyScalar(0.12 * spec.opacity);
    }

    u.uOpacity!.value = ship.fade;
    // Opaque unless the ship is mid-fade, so the hull never reads translucent.
    const wantTransparent = ship.fade < 0.999;
    if (ship.hullMat.transparent !== wantTransparent) ship.hullMat.transparent = wantTransparent;
    lightHull(ship.hullMat, lighting);
    u.uEmissiveGain!.value = sync ? 1.9 : 1.5;
    if (rung >= 4) u.uRimGain!.value = 0.12;
    (u.uFlashPos!.value as THREE.Vector3).copy(this.flashPos);
    (u.uFlashColor!.value as THREE.Color).setRGB(9, 6.5, 4).multiplyScalar(flashK * flashK);
    u.uShimmer!.value = this.charge * (1 - this.tunnel);
    u.uTime!.value = tS;

    this.updateTrail(ship, burning && vis.state === 'riding', dtS, enginePos);
  }

  /**
   * RCS puffs from the nose, wingtips and tail: roll acceleration fires a
   * wingtip pair (one up, one down), yaw acceleration fires the nose sideways.
   */
  private fireRcs(ship: ShipVis, aRoll: number, aYaw: number, dtS: number): void {
    const cd = ship.rcsCooldown;
    for (let i = 0; i < 4; i++) cd[i] = Math.max(0, cd[i]! - dtS);
    const m = ship.root.matrixWorld;
    const rcs = ship.asset.rcs;
    const up = tmpC.setFromMatrixColumn(m, 1).normalize();
    if (Math.abs(aRoll) > RCS_ROLL_ACCEL && cd[1] === 0 && Math.random() < Math.abs(aRoll) / (RCS_ROLL_ACCEL * 3)) {
      cd[1] = RCS_REFIRE_S;
      const sign = Math.sign(aRoll);
      // Rolling to port (+): the starboard tip fires down, the port tip up.
      this.sparks.emit(tmpA.copy(rcs[2]!).applyMatrix4(m), tmpB.copy(up).multiplyScalar(-5 * sign), this.puff);
      this.sparks.emit(tmpA.copy(rcs[1]!).applyMatrix4(m), tmpB.copy(up).multiplyScalar(5 * sign), this.puff);
    }
    if (Math.abs(aYaw) > RCS_YAW_ACCEL && cd[0] === 0 && Math.random() < Math.abs(aYaw) / (RCS_YAW_ACCEL * 3)) {
      cd[0] = RCS_REFIRE_S;
      // Nose swinging to port (+yaw): the thruster on the starboard cheek fires.
      const right = tmpC.setFromMatrixColumn(m, 0).normalize();
      this.sparks.emit(tmpA.copy(rcs[0]!).applyMatrix4(m), tmpB.copy(right).multiplyScalar(5 * Math.sign(aYaw)), this.puff);
      this.sparks.emit(tmpA.copy(rcs[3]!).applyMatrix4(m), tmpB.copy(right).multiplyScalar(-4 * Math.sign(aYaw)), this.puff);
    }
  }

  /** Ion contrail: the engine wake streams aft and fades over about 2 s. */
  private updateTrail(ship: ShipVis, on: boolean, dtS: number, nozzles: THREE.Vector3[]): void {
    const trail = ship.trail;
    trail.level = damp(trail.level, on && ship.root.visible ? 1 : 0, 0.8, dtS);
    const ribbon = trail.ribbon;
    if (trail.level < 0.01) {
      ribbon.object.visible = false;
      trail.count = 0;
      return;
    }
    const head = tmpA.copy(nozzles[0]!).add(nozzles[1]!).multiplyScalar(0.5);
    const s = trail.samples;
    for (let i = 0; i < trail.count; i++) s[i * 3 + 2] = s[i * 3 + 2]! + TRAIL_SPEED * dtS;
    trail.sinceSampleS += dtS;
    if (trail.sinceSampleS >= TRAIL_STEP_S || trail.count === 0) {
      trail.sinceSampleS = 0;
      s.copyWithin(3, 0, (TRAIL_POINTS - 1) * 3);
      s[0] = head.x;
      s[1] = head.y;
      s[2] = head.z;
      trail.count = Math.min(TRAIL_POINTS - 1, trail.count + 1);
    }
    if (trail.count < 2) {
      ribbon.object.visible = false;
      return;
    }
    // Path: the live nozzle midpoint, then the stored wake (padded at the tail).
    const p = trail.path;
    p[0] = head.x;
    p[1] = head.y;
    p[2] = head.z;
    for (let i = 1; i < TRAIL_POINTS; i++) {
      const src = Math.min(i - 1, trail.count - 1) * 3;
      p[i * 3] = s[src]!;
      p[i * 3 + 1] = s[src + 1]!;
      p[i * 3 + 2] = s[src + 2]!;
      trail.widths[i] = 0.05 + 0.22 * (i / (TRAIL_POINTS - 1));
    }
    trail.widths[0] = 0.05;
    this.trailColor.copy(ION).lerp(ship.accent, 0.25);
    ribbon.setPath(p, trail.widths, this.cameraPosition, this.trailColor, null, 0.2 * trail.level, 0);
    ribbon.object.visible = true;
  }

  private destroyShip(ship: ShipVis): void {
    ship.root.removeFromParent();
    ship.hullMat.dispose();
    ship.trail.ribbon.object.removeFromParent();
    ship.trail.ribbon.dispose();
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

  /**
   * Wing-root hardpoints of a riding ship in world space, plus its nose
   * direction; false when the ship is absent, hidden or not riding.
   */
  hardpoints(riderId: string, outL: THREE.Vector3, outR: THREE.Vector3, outForward: THREE.Vector3): boolean {
    const ship = this.ships.get(riderId);
    if (ship === undefined || !ship.root.visible || ship.state !== 'riding') return false;
    const m = ship.root.matrixWorld;
    outL.copy(ship.asset.hardpoints[0]!).applyMatrix4(m);
    outR.copy(ship.asset.hardpoints[1]!).applyMatrix4(m);
    outForward.setFromMatrixColumn(m, 2).normalize().negate();
    return true;
  }

  /** World position of a rider's engine mouths (fx anchors), or null when absent. */
  enginePosition(riderId: string, out: THREE.Vector3): THREE.Vector3 | null {
    const ship = this.ships.get(riderId);
    if (ship === undefined || !ship.root.visible) return null;
    const m = ship.root.matrixWorld;
    tmpA.copy(ship.asset.nozzles[0]!).applyMatrix4(m);
    tmpB.copy(ship.asset.nozzles[1]!).applyMatrix4(m);
    return out.copy(tmpA).add(tmpB).multiplyScalar(0.5);
  }

  dispose(): void {
    for (const ship of this.ships.values()) this.destroyShip(ship);
    this.ships.clear();
    for (const asset of this.hulls.values()) disposeHull(asset);
    this.hulls.clear();
    this.group.clear();
  }
}
