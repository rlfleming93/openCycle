import * as THREE from 'three';

import { identityColor } from '../../lib/identity.js';
import type { GameFrame } from '../director.js';
import type { Engines, EngineSpec } from './engines.js';
import type { Fleet, HullAsset, ScreenDisc, ShipBounds } from './fleet.js';
import { createHullMaterial, disposeHull, lightHull, loadHull } from './fleet.js';
import { flyToward, smootherstep } from './flight.js';
import { AMBIENT_GLSL, NOISE_GLSL } from './glsl.js';
import { clamp, clamp01, easeOutCubic, lerp, seededRandom } from './math.js';
import type { Lighting } from './sky.js';
import type { SparkSpec, Sparks } from './sparks.js';

/**
 * Pursuit raider ("Burn legs are pursuits"). On the lead's burn legs a raider
 * warps in about 3 s into the burn and flies like a pilot 60-120 u ahead of
 * the fleet: it jinks between marks inside the readable part of the chase
 * shot, barrel-rolls, boosts, and drops magnesium chaff once the lock passes
 * 70 %. In-band ships fire alternating paired pulse bolts in their identity
 * colour from the wing-root hardpoints plus occasional yellow multicannon
 * tracers; hits light the raider's shield. The lead's lock fills a reticle ring
 * that turns solid at 100 %. A clean burn ends it big (white core, a fireball
 * cooling from orange to red, a shock ring, glowing tumbling debris); an
 * unclean burn lets it charge its frame shift drive and streak away.
 *
 * Draws while it flies: hull, reticle, bolts, shield (on hits); while it dies:
 * fireball, shock ring, debris. Engines and sparks ride the shared draws.
 */
const RAIDER_URL = '/assets/ships/raider.glb';
/** Hostile accent: a deep crimson, clear of every rider identity hue. */
const RAIDER_ACCENT = new THREE.Color(0xc0261c);
const SPAWN_DELAY_MS = 3000;
const WARP_IN_S = 0.4;
/**
 * Readable box in the chase shot (screen fractions): left of centre, below the
 * route strip and above the rider cards, and depth ahead (u). The mark also
 * keeps DEST_CLEAR frame widths from the destination (flight-assist lag eats
 * about 0.03 of it, so the raider itself stays 12 % clear), and its reticle
 * (ring, ticks and RING_CLEAR_PX of margin at 1080p) stays off every hull's
 * screen box and below TOP_BAND.
 */
const BOX_X = [0.3, 0.48] as const;
const BOX_Y = [0.26, 0.44] as const;
const DEST_CLEAR = 0.15;
/** Hard floor: the raider itself never comes closer to the destination (frame widths). */
const DEST_HOLD = 0.125;
const RING_CLEAR_PX = 22;
const TOP_BAND = 0.16;
const DEPTH = [50, 85] as const;
/** Crowded out of the readable box, the raider drops back this deep (a smaller reticle). */
const DEEP = 115;
const ASSIST_OMEGA = (2 * Math.PI) / 1.5;
const ASSIST_ZETA = 0.5;
const ASSIST_ACCEL = 140;
const ROLL_S = 0.9;
const BOOST_S = 0.8;

const BOLT_POOL = 192;
/** 5 alternating pairs per second per ship; slow enough that 6-12 bolts per
 *  ship are in the air at once. */
const PULSE_GAP_MS = 100;
const PULSE_SPEED = 150;
const TRACER_SPEED = 240;
const BURST_EVERY_MS = 2000;
const BURST_SHOTS = 5;
const BURST_GAP_MS = 60;
const BOLT_LIFE_S = 1.4;
/**
 * Bolts keep a constant screen size: core radius in 1080p px (pulse, tracer)
 * and a length of about 3 % of the frame width, born this far past the
 * hardpoint so they never start inside the hull or the near plane.
 */
const BOLT_RADIUS_PX = [3.5, 2.6] as const;
const BOLT_LENGTH = 0.03;
const MUZZLE_U = 3;

const DEBRIS_COUNT = 30;
const DOWN_S = 3.6;
/** Fireball: puff count, peak cluster radius (frame heights) and lifetime. */
const PUFFS = 12;
const FIRE_PEAK = 0.16;
const FIRE_S = 2.5;
const ESCAPE_CHARGE_S = 0.7;
const ESCAPE_S = 1.6;
/** The fleet flies through the wreck: debris and smoke stream aft. */
const WRECK_STREAM = 26;

type Phase = 'idle' | 'pending' | 'alive' | 'down' | 'escaping';

interface Bolt {
  active: boolean;
  /** 0 pulse, 1 tracer, 2 warp streak. */
  kind: number;
  head: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  /** Warp streaks only: pulses and tracers are sized on screen each frame. */
  length: number;
  radius: number;
  travelled: number;
  range: number;
  hit: boolean;
  age: number;
  life: number;
  color: THREE.Color;
}

interface Gunner {
  nextPulseMs: number;
  side: number;
  nextBurstMs: number;
  burstLeft: number;
}

interface Chunk {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  rot: THREE.Euler;
  scale: THREE.Vector3;
}

/** One fireball puff, in units of the cluster's peak radius. */
interface Puff {
  dir: THREE.Vector3;
  offset: number;
  travel: number;
  size: number;
}

const BOLT_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
varying float vAlong;
varying vec3 vNormalW;
varying vec3 vAxis;
varying vec3 vWorldPos;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  // The open cylinder runs z -0.5 (tail) to 0.5 (head).
  vAlong = position.z + 0.5;
  mat3 m = mat3(modelMatrix) * mat3(instanceMatrix);
  vNormalW = m * normal;
  vAxis = normalize(m * vec3(0.0, 0.0, 1.0));
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

/**
 * A thin energy streak: a near-white core inside a coloured sheath, both
 * falling to zero at the silhouette (no halo floor), brightest at the head
 * and fading down the tail. Facing is measured across the axis, so a bolt
 * flying into the shot keeps its core.
 */
const BOLT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vAlong;
varying vec3 vNormalW;
varying vec3 vAxis;
varying vec3 vWorldPos;
void main() {
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 across = v - vAxis * dot(v, vAxis);
  float facing = abs(dot(normalize(vNormalW), across)) / max(length(across), 1e-4);
  float sheath = facing * facing;
  float core = pow(facing, 12.0);
  float taper = smoothstep(0.0, 0.75, vAlong) * smoothstep(1.0, 0.93, vAlong);
  vec3 col = vColor * sheath * 0.8 + mix(vColor, vec3(1.0), 0.8) * core * 2.5;
  gl_FragColor = vec4(col * vAlpha * taper, 1.0);
}`;

const BILLBOARD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Lock reticle, sized in 1080p pixels: a thin dim ring (1.5 px) with twelve
 * short ticks outside it; the lock fills a brighter 2 px arc clockwise from
 * the top, and at full lock the whole ring goes solid and breathes gently.
 */
const RETICLE_FRAG = /* glsl */ `
uniform float uLock;
uniform float uSolid;
uniform float uTime;
uniform float uAlpha;
uniform float uRing;
uniform float uSize;
varying vec2 vUv;
void main() {
  float rp = length(vUv) * uSize;
  float aa = clamp(fwidth(rp), 0.35, 1.5);
  float d = abs(rp - uRing);
  float t = fract(atan(vUv.x, vUv.y) / 6.2831853 + 1.0);
  float ring = 1.0 - smoothstep(0.75 - aa * 0.5, 0.75 + aa * 0.5, d);
  float arc = (1.0 - smoothstep(1.0 - aa * 0.5, 1.0 + aa * 0.5, d)) * max(step(t, uLock), uSolid);
  float gap = abs(fract(t * 12.0 + 0.5) - 0.5) * 6.2831853 / 12.0 * rp;
  float tick = (1.0 - smoothstep(0.7 - aa * 0.5, 0.7 + aa * 0.5, gap))
    * smoothstep(uRing + 2.5, uRing + 3.5, rp) * (1.0 - smoothstep(uRing + 7.5, uRing + 8.5, rp));
  float breathe = 1.0 + uSolid * 0.25 * sin(uTime * 5.0);
  vec3 amber = vec3(1.0, 0.7, 0.32);
  vec3 col = amber * (ring * 0.16 + tick * 0.5) + mix(amber, vec3(1.0, 0.9, 0.75), uSolid) * arc * 2.4 * breathe;
  gl_FragColor = vec4(col * uAlpha, 1.0);
}`;

/** Shield: a faint fresnel skin; a hit lights a tight spot and the hex weave around it. */
const SHIELD_FRAG = /* glsl */ `
uniform vec3 uHitDir;
uniform float uLevel;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vLocal;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - abs(dot(N, V)), 2.5);
  vec2 hp = vec2(atan(vLocal.z, vLocal.x) * 5.0, vLocal.y * 9.0);
  vec2 cell = abs(fract(hp + vec2(0.0, 0.5 * mod(floor(hp.x), 2.0))) - 0.5);
  float hex = smoothstep(0.4, 0.5, max(cell.x * 1.15, cell.y));
  float ang = acos(clamp(dot(normalize(vLocal), uHitDir), -1.0, 1.0));
  float spot = exp(-ang * ang * 26.0);
  float web = exp(-ang * ang * 14.0) * hex;
  float a = uLevel * (fres * 0.15 * (0.4 + 0.6 * hex) + web * 0.5 + spot * 1.6);
  gl_FragColor = vec4(vec3(0.45, 0.72, 1.0) * a, 1.0);
}`;

const SHIELD_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying vec3 vLocal;
void main() {
  vLocal = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/**
 * Fireball: a cluster of camera-facing puffs (one instanced draw). Each is an
 * FBM-eroded soft ball whose temperature falls with time, with its distance
 * from the cluster centre and toward its own rim: white-yellow, orange, deep
 * red, gone by 2.5 s. `uT` is seconds since the kill, `uSeed` varies each wreck.
 */
const FIREBALL_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
varying vec2 vUv;
varying float vSeed;
varying float vInner;
void main() {
  vUv = position.xy;
  vSeed = fract(sin(float(gl_InstanceID) * 12.9898 + 4.1) * 43758.5453);
  vec3 center = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  vInner = 1.0 - clamp(distance(center, uCenter) / max(uRadius, 0.001), 0.0, 1.0);
  vec4 mv = viewMatrix * vec4(center, 1.0);
  mv.xy += position.xy * length(instanceMatrix[0].xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FIREBALL_FRAG = /* glsl */ `
uniform float uT;
uniform float uSeed;
varying vec2 vUv;
varying float vSeed;
varying float vInner;
${NOISE_GLSL}
vec3 heatRamp(float h) {
  vec3 c = mix(vec3(0.3, 0.025, 0.01), vec3(1.0, 0.25, 0.04), smoothstep(0.0, 0.35, h));
  c = mix(c, vec3(1.0, 0.62, 0.18), smoothstep(0.35, 0.7, h));
  c = mix(c, vec3(1.0, 0.93, 0.75), smoothstep(0.7, 1.05, h));
  return c;
}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 q = vec3(vUv * 2.6 + vSeed * 9.0, uT * 0.8 + uSeed + vSeed * 5.0);
  float n = ocFbm(q + 0.9 * ocFbm(q * 1.9 + 2.3, 3.0), 4.0);
  float body = smoothstep(1.0, 0.2, r + 0.55 * (n - 0.5));
  float heat = (1.2 - uT * 0.5) * (1.0 - r) * (0.6 + 0.5 * vInner) + (n - 0.5) * 0.45;
  float life = 1.0 - smoothstep(1.5, 2.5, uT);
  // Billows: bright knots and darker folds, never a flat disc.
  float billow = 0.2 + 2.4 * n * n * n;
  vec3 col = heatRamp(heat) * (0.15 + 0.9 * clamp(heat, 0.0, 1.2)) * billow * body * life;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Shock ring: a thin blue-white front with a faint wake inside it. */
const SHOCK_FRAG = /* glsl */ `
uniform float uLevel;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float front = exp(-pow((r - 0.92) * 26.0, 2.0));
  float wake = smoothstep(0.6, 0.92, r) * step(r, 0.92) * 0.06;
  gl_FragColor = vec4(mix(vec3(0.55, 0.75, 1.0), vec3(1.0), front * 0.5) * (front + wake) * uLevel * 1.8, 1.0);
}`;

/** Debris: small dark shards, key- and sky-lit, whose silhouette edges glow and cool. */
const DEBRIS_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vSeed;
void main() {
  vec4 local = instanceMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec4 wp = modelMatrix * local;
  vWorldPos = wp.xyz;
  vSeed = fract(sin(float(gl_InstanceID) * 12.9898) * 43758.5453);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const DEBRIS_FRAG = /* glsl */ `
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uAmbient[6];
uniform float uHeat;
${AMBIENT_GLSL}
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vSeed;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 col = vec3(0.04) * (uKeyColor * max(dot(N, uSunDir), 0.0) + ocAmbient(N, uAmbient));
  float heat = uHeat * (0.55 + 0.45 * vSeed);
  col += vec3(1.0, 0.35, 0.08) * pow(1.0 - abs(dot(N, V)), 3.0) * heat * heat * 4.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export class Raiders {
  readonly group = new THREE.Group();
  private readonly engines: Engines;
  private readonly sparks: Sparks;
  private asset: HullAsset | null = null;
  private hull: THREE.Object3D | null = null;
  private hullMat: THREE.ShaderMaterial | null = null;
  /** Hull bounds in its own frame (the reticle frames their screen box). */
  private readonly hullBox = new THREE.Box3();
  private phase: Phase = 'idle';
  private legIndex = -1;
  private rnd: () => number = Math.random;
  private seedF = 0;
  private spawnAtMs = -1;
  private phaseMs = -1;
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly acc = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private mark = { x: 0.5, y: 0.35, d: 90 };
  /** The destination's screen point this frame (fractions); `on` while it is in front and in frame. */
  private readonly dest = { x: 0, y: 0, on: false };
  /** The fleet's visible hulls with their screen boxes (the reticle keeps off them). */
  private ships: readonly ShipBounds[] = [];
  /** The reticle on screen (ring and ticks): the fleet's wingmen keep off it. */
  readonly reticleScreen: ScreenDisc = { x: 0, y: 0, r: 0, on: false };
  private nextJinkMs = 0;
  private side = 1;
  private rollMs = -1;
  private rollDir = 1;
  private nextRollMs = 0;
  private boostMs = -1;
  private nextBoostMs = 0;
  private nextChaffMs = 0;
  private hitMs = -1;
  private readonly gunners = new Map<string, Gunner>();
  private readonly bolts: Bolt[] = [];
  private readonly boltMesh: THREE.InstancedMesh;
  private readonly boltColor = new Float32Array(BOLT_POOL * 3);
  private readonly boltAlpha = new Float32Array(BOLT_POOL);
  private readonly reticle: THREE.Mesh;
  private readonly reticleMat: THREE.ShaderMaterial;
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.ShaderMaterial;
  private readonly fireball: THREE.InstancedMesh;
  private readonly fireMat: THREE.ShaderMaterial;
  private readonly puffs: Puff[] = [];
  private readonly shock: THREE.Mesh;
  private readonly shockMat: THREE.ShaderMaterial;
  private readonly debris: THREE.InstancedMesh;
  private readonly debrisMat: THREE.ShaderMaterial;
  private readonly chunks: Chunk[] = [];
  private readonly wreck = new THREE.Vector3();
  private readonly quad = new THREE.PlaneGeometry(2, 2);
  private readonly escapeFrom = new THREE.Vector3();
  private jumped = false;
  /** When the pursuit ended with no outcome yet (ms), -1 otherwise. */
  private orphanMs = -1;
  private readonly tmpColor = new THREE.Color();
  private readonly spec: EngineSpec = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    radius: 0.42,
    length: 3,
    core: new THREE.Color(),
    edge: new THREE.Color(),
    opacity: 0.7,
    heat: 1.4,
    sputter: 0,
    glowSize: 1.4,
    glowAlpha: 1,
    glowColor: new THREE.Color(),
    ring: -1,
    seed: 9,
  };
  private readonly spark: SparkSpec = {
    size0: 1,
    size1: 1,
    lifeS: 0.1,
    color: new THREE.Color(),
    alpha: 1,
    hard: 1,
    drag: 0,
    flicker: 0,
  };
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly hardL = new THREE.Vector3();
  private readonly hardR = new THREE.Vector3();
  private readonly nose = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(engines: Engines, sparks: Sparks) {
    this.engines = engines;
    this.sparks = sparks;

    const boltGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    boltGeo.rotateX(Math.PI / 2);
    boltGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.boltColor, 3).setUsage(THREE.DynamicDrawUsage));
    boltGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(this.boltAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.boltMesh = new THREE.InstancedMesh(
      boltGeo,
      new THREE.ShaderMaterial({
        vertexShader: BOLT_VERT,
        fragmentShader: BOLT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      BOLT_POOL,
    );
    this.boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boltMesh.frustumCulled = false;
    this.boltMesh.count = 0;
    this.boltMesh.renderOrder = 7;
    for (let i = 0; i < BOLT_POOL; i++) {
      this.bolts.push({
        active: false,
        kind: 0,
        head: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        speed: 0,
        length: 1,
        radius: 0.1,
        travelled: 0,
        range: 1,
        hit: false,
        age: 0,
        life: 1,
        color: new THREE.Color(),
      });
    }

    const billboard = (frag: string, uniforms: Record<string, THREE.IUniform>, order: number): [THREE.Mesh, THREE.ShaderMaterial] => {
      const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: BILLBOARD_VERT,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = order;
      return [mesh, mat];
    };
    [this.reticle, this.reticleMat] = billboard(
      RETICLE_FRAG,
      {
        uLock: { value: 0 },
        uSolid: { value: 0 },
        uTime: { value: 0 },
        uAlpha: { value: 0 },
        uRing: { value: 40 },
        uSize: { value: 52 },
      },
      10,
    );
    [this.shock, this.shockMat] = billboard(SHOCK_FRAG, { uLevel: { value: 0 } }, 8);

    this.fireMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uSeed: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 } },
      vertexShader: FIREBALL_VERT,
      fragmentShader: FIREBALL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fireball = new THREE.InstancedMesh(this.quad, this.fireMat, PUFFS);
    this.fireball.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fireball.frustumCulled = false;
    this.fireball.visible = false;
    this.fireball.renderOrder = 8;
    for (let i = 0; i < PUFFS; i++) this.puffs.push({ dir: new THREE.Vector3(), offset: 0, travel: 0, size: 0 });

    this.shieldMat = new THREE.ShaderMaterial({
      uniforms: { uHitDir: { value: new THREE.Vector3(0, 0, 1) }, uLevel: { value: 0 } },
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), this.shieldMat);
    this.shield.frustumCulled = false;
    this.shield.visible = false;
    this.shield.renderOrder = 7;

    // Polyhedra are already non-indexed, so recomputed normals come out flat.
    const debrisGeo = new THREE.DodecahedronGeometry(1, 0);
    debrisGeo.computeVertexNormals();
    this.debrisMat = new THREE.ShaderMaterial({
      uniforms: {
        uKeyColor: { value: new THREE.Color(1, 1, 1) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uAmbient: { value: Array.from({ length: 6 }, () => new THREE.Color()) },
        uHeat: { value: 0 },
      },
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
    });
    this.debris = new THREE.InstancedMesh(debrisGeo, this.debrisMat, DEBRIS_COUNT);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.visible = false;
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      this.chunks.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        rot: new THREE.Euler(),
        scale: new THREE.Vector3(1, 1, 1),
      });
    }

    this.group.add(this.boltMesh, this.reticle, this.fireball, this.shock, this.shield, this.debris);
  }

  /** Load the raider hull; resolves false when it is missing. */
  async load(): Promise<boolean> {
    const asset = await loadHull(RAIDER_URL);
    if (asset === null) return false;
    this.asset = asset;
    this.hullMat = createHullMaterial(asset, RAIDER_ACCENT);
    this.hullMat.uniforms.uEmissiveGain!.value = 1.4;
    const hull = asset.root.clone(true);
    hull.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh === true) mesh.material = this.hullMat!;
    });
    const root = new THREE.Group();
    root.add(hull);
    this.hullBox.setFromObject(root);
    root.visible = false;
    this.hull = root;
    this.group.add(root);
    return true;
  }

  /** Where the raider is (or died): the fleet's explosion light reads it. */
  get position(): THREE.Vector3 {
    return this.phase === 'down' ? this.wreck : this.pos;
  }

  /**
   * Resolve the lead's burn. Returns true when the raider was on screen and
   * went down (the caller lights the fleet and kicks the camera).
   */
  resolve(outcome: 'down' | 'escaped', nowMs: number): boolean {
    if (this.phase !== 'alive') {
      // Never showed up (a very short burn): nothing to resolve.
      if (this.phase === 'pending') this.retire();
      return false;
    }
    this.phaseMs = nowMs;
    for (const bolt of this.bolts) if (bolt.kind !== 2) bolt.active = false;
    if (outcome === 'escaped') {
      this.phase = 'escaping';
      this.jumped = false;
      return false;
    }
    this.phase = 'down';
    this.explode();
    return true;
  }

  /** `destination` is the destination centre while it is on show, else null; the raider keeps clear of it. */
  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    fleet: Fleet,
    lighting: Lighting,
    camera: THREE.PerspectiveCamera,
    destination: THREE.Vector3 | null,
  ): void {
    const pursuit = frame.pursuit;
    if (pursuit !== null && (this.phase === 'idle' || pursuit.legIndex !== this.legIndex) && this.phase !== 'down' && this.phase !== 'escaping') {
      this.begin(frame, pursuit.legIndex, nowMs);
    }
    if (pursuit !== null) this.orphanMs = -1;
    else if (this.phase === 'pending') this.retire();
    else if (this.phase === 'alive') {
      // The outcome event can trail the leg change by a message or two; after
      // a beat without one, the raider leaves by warp rather than vanishing.
      if (this.orphanMs < 0) this.orphanMs = nowMs;
      else if (nowMs - this.orphanMs > 1500) this.resolve('escaped', nowMs);
    }
    const lock = pursuit?.lock ?? 0;

    // The pursuit frame is the camera's: "ahead" is into the shot.
    camera.getWorldDirection(this.forward);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    if (fleet.fleetCenter(this.center) === null) this.center.set(0, 0, 0);
    this.ships = fleet.bounds;
    const onScreen = destination === null ? null : this.tmp.copy(destination).project(camera);
    this.dest.on = onScreen !== null && onScreen.z < 1 && Math.abs(onScreen.x) < 1.2 && Math.abs(onScreen.y) < 1.2;
    if (onScreen !== null) {
      this.dest.x = onScreen.x * 0.5 + 0.5;
      this.dest.y = 0.5 - onScreen.y * 0.5;
    }

    if (this.phase === 'pending' && nowMs >= this.spawnAtMs) this.spawn(nowMs, camera);
    if (this.phase === 'alive') this.fly(nowMs, dtS, lock, camera);
    if (this.phase === 'escaping') this.escape(nowMs, dtS, camera);
    if (this.phase === 'alive') this.shoot(frame, nowMs, lock, fleet);

    this.placeHull(nowMs, lighting);
    this.updateBolts(nowMs, dtS, camera);
    this.updateReticle(nowMs, lock, camera);
    this.updateShield(nowMs);
    this.updateWreck(nowMs, dtS, camera, lighting);
  }

  private begin(frame: GameFrame, legIndex: number, nowMs: number): void {
    this.phase = 'pending';
    this.legIndex = legIndex;
    this.spawnAtMs = nowMs + SPAWN_DELAY_MS;
    this.rnd = seededRandom(`${frame.seed}:raider:${legIndex}`);
    this.seedF = this.rnd() * 100;
    this.gunners.clear();
  }

  private retire(): void {
    this.phase = 'idle';
    this.legIndex = -1;
    if (this.hull !== null) this.hull.visible = false;
    this.reticle.visible = false;
    this.shield.visible = false;
  }

  /** A jink target inside the readable box, alternating sides. */
  private pickMark(): void {
    this.side = -this.side;
    const half = 0.5 + this.side * (0.2 + 0.8 * this.rnd()) * 0.5;
    this.mark = {
      x: lerp(BOX_X[0], BOX_X[1], half),
      y: lerp(BOX_Y[0], BOX_Y[1], this.rnd()),
      d: lerp(DEPTH[0], DEPTH[1], this.rnd()),
    };
  }

  /**
   * Keep the mark clear (see BOX_X): when its reticle would touch a hull, the
   * route strip or the destination's space, move to the nearest clear point of
   * a grid over the upper frame, left of centre preferred. Crowded out there,
   * the raider drops back deeper (a smaller reticle) and searches again; with
   * nothing clear, it holds.
   */
  private clearMark(camera: THREE.PerspectiveCamera): void {
    const aspect = camera.aspect;
    const m = this.mark;
    if (this.markClear(m.x, m.y, aspect, 1)) return;
    // The reticle scales with 1/depth: `base` is the fleet centre's depth.
    const base = this.tmpB.copy(this.center).sub(camera.position).dot(this.forward);
    for (const depth of [m.d, DEEP]) {
      const scale = Math.max(base + m.d, 1) / Math.max(base + depth, 1);
      let best = Infinity;
      let bestX = m.x;
      let bestY = m.y;
      for (let iy = 0; iy <= 6; iy++) {
        for (let ix = 0; ix <= 9; ix++) {
          const x = lerp(0.18, 0.72, ix / 9);
          const y = lerp(0.2, 0.5, iy / 6);
          const d = Math.hypot((x - m.x) * aspect, y - m.y) + Math.max(0, x - 0.5) * 0.3;
          if (d >= best || !this.markClear(x, y, aspect, scale)) continue;
          best = d;
          bestX = x;
          bestY = y;
        }
      }
      if (best < Infinity) {
        m.x = bestX;
        m.y = bestY;
        m.d = depth;
        return;
      }
    }
  }

  /**
   * Whether a reticle at screen point (x, y), its ring scaled by `scale`,
   * keeps off the hulls, the route strip and the destination.
   */
  private markClear(x: number, y: number, aspect: number, scale: number): boolean {
    const dest = this.dest;
    if (dest.on && Math.hypot(x - dest.x, (y - dest.y) / aspect) < DEST_CLEAR) return false;
    const r = ((this.reticleMat.uniforms.uRing!.value as number) * scale + RING_CLEAR_PX) / 1080;
    if (y - r < TOP_BAND) return false;
    for (const b of this.ships) {
      const rect = b.rect;
      if (!rect.valid) continue;
      const dx = (x - clamp(x, rect.x0, rect.x1)) * aspect;
      const dy = y - clamp(y, rect.y0, rect.y1);
      if (dx * dx + dy * dy < r * r) return false;
    }
    return true;
  }

  /**
   * The reticle never touches a hull: after the pilot's move, slide the raider
   * straight off any hull's screen box its ring (with ticks and a few px) would
   * overlap, and drop the velocity that carried it in.
   */
  private keepOff(camera: THREE.PerspectiveCamera): void {
    const depth = this.tmpB.copy(this.pos).sub(camera.position).dot(this.forward);
    if (depth < 1) return;
    const aspect = camera.aspect;
    const r = ((this.reticleMat.uniforms.uRing!.value as number) + 16) / 1080;
    // World units per frame height at the raider's depth.
    const unit = 2 * Math.tan((camera.fov * Math.PI) / 360) * depth;
    for (const b of this.ships) {
      const rect = b.rect;
      if (!rect.valid) continue;
      const p = this.tmp.copy(this.pos).project(camera);
      const x = (p.x * 0.5 + 0.5) * aspect;
      const y = 0.5 - p.y * 0.5;
      const x0 = rect.x0 * aspect;
      const x1 = rect.x1 * aspect;
      let ux = x - clamp(x, x0, x1);
      let uy = y - clamp(y, rect.y0, rect.y1);
      const d = Math.hypot(ux, uy);
      if (d >= r) continue;
      let push = r - d;
      if (d > 1e-4) {
        ux /= d;
        uy /= d;
      } else {
        // Its centre is inside the box: leave by the nearest edge.
        const edge = Math.min(x - x0, x1 - x, y - rect.y0, rect.y1 - y);
        ux = edge === x - x0 ? -1 : edge === x1 - x ? 1 : 0;
        uy = ux !== 0 ? 0 : edge === y - rect.y0 ? -1 : 1;
        push = r + edge;
      }
      this.shove(ux, uy, push, unit);
    }
    // ...never onto the destination...
    const dest = this.dest;
    if (dest.on) {
      const p = this.tmp.copy(this.pos).project(camera);
      const ux = (p.x * 0.5 + 0.5 - dest.x) * aspect;
      const uy = 0.5 - p.y * 0.5 - dest.y;
      const d = Math.hypot(ux, uy);
      const hold = DEST_HOLD * aspect;
      if (d < hold && d > 1e-4) this.shove(ux / d, uy / d, hold - d, unit);
    }
    // ...and never out of the readable region: in frame, below the route strip,
    // above the rider cards (these win over a hull the ring still grazes).
    const p = this.tmp.copy(this.pos).project(camera);
    const x = p.x * 0.5 + 0.5;
    const y = 0.5 - p.y * 0.5;
    const dx = (clamp(x, 0.14, 0.78) - x) * aspect;
    const dy = clamp(y, Math.min(TOP_BAND + r, 0.5), 0.52) - y;
    const out = Math.hypot(dx, dy);
    if (out > 1e-5) this.shove(dx / out, dy / out, out, unit);
  }

  /** Slide the raider by `push` frame heights along screen direction (ux, uy); drop the velocity into it. */
  private shove(ux: number, uy: number, push: number, unit: number): void {
    // Screen y runs down; world up is the camera's up.
    const n = this.aim.copy(this.right).multiplyScalar(ux).addScaledVector(this.up, -uy);
    this.pos.addScaledVector(n, push * unit);
    const into = this.vel.dot(n);
    if (into < 0) this.vel.addScaledVector(n, -into);
  }

  /** World point for a screen mark `d` units past the fleet centre. */
  private markPoint(x: number, y: number, d: number, camera: THREE.PerspectiveCamera, out: THREE.Vector3): THREE.Vector3 {
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    const tanX = tanY * camera.aspect;
    const dist = this.tmpB.copy(this.center).sub(camera.position).dot(this.forward) + d;
    return out
      .copy(this.forward)
      .addScaledVector(this.right, (2 * x - 1) * tanX)
      .addScaledVector(this.up, (1 - 2 * y) * tanY)
      .multiplyScalar(dist)
      .add(camera.position);
  }

  private spawn(nowMs: number, camera: THREE.PerspectiveCamera): void {
    this.phase = 'alive';
    this.phaseMs = nowMs;
    this.pickMark();
    this.clearMark(camera);
    this.markPoint(this.mark.x, this.mark.y, this.mark.d, camera, this.pos);
    this.vel.set(0, 0, 0);
    this.nextJinkMs = nowMs + 900 + this.rnd() * 900;
    this.nextRollMs = nowMs + 2500 + this.rnd() * 2500;
    this.nextBoostMs = nowMs + 3500 + this.rnd() * 3000;
    this.nextChaffMs = nowMs;
    // Warp-in: a streak racing in from deep ahead plus a flash.
    this.streak(this.tmp.copy(this.pos).addScaledVector(this.forward, 520), this.pos, 0.35, 1.1);
    this.spark.size0 = 16;
    this.spark.size1 = 4;
    this.spark.lifeS = 0.45;
    this.spark.color.setRGB(0.7, 0.85, 1.0).multiplyScalar(5);
    this.spark.alpha = 1;
    this.spark.hard = 1;
    this.spark.drag = 0;
    this.spark.flicker = 0;
    this.sparks.emit(this.pos, this.tmp.set(0, 0, 0), this.spark);
  }

  /** The pilot: jinks, rolls, boosts and, under a hard lock, chaff. */
  private fly(nowMs: number, dtS: number, lock: number, camera: THREE.PerspectiveCamera): void {
    if (nowMs >= this.nextJinkMs) {
      this.pickMark();
      this.nextJinkMs = nowMs + (1100 + this.rnd() * 1300) * (1 - 0.3 * lock);
    }
    if (nowMs >= this.nextRollMs) {
      this.rollMs = nowMs;
      this.rollDir = this.rnd() < 0.5 ? -1 : 1;
      this.nextRollMs = nowMs + 4000 + this.rnd() * 3000;
    }
    if (nowMs >= this.nextBoostMs) {
      this.boostMs = nowMs;
      this.nextBoostMs = nowMs + 5000 + this.rnd() * 4000;
    }
    const boostS = this.boostMs < 0 ? Infinity : (nowMs - this.boostMs) / 1000;
    const surge = boostS < 1.6 ? Math.sin(Math.PI * (boostS / 1.6)) * 28 : 0;
    this.clearMark(camera);
    this.markPoint(this.mark.x, this.mark.y, this.mark.d + surge, camera, this.target);
    flyToward(this.pos, this.vel, this.acc, this.target, ASSIST_OMEGA, ASSIST_ZETA, ASSIST_ACCEL * (boostS < BOOST_S ? 1.5 : 1), dtS);
    this.keepOff(camera);

    // Chaff: a handful of magnesium flares, tumbling back toward the fleet.
    if (lock > 0.7 && nowMs >= this.nextChaffMs && this.asset !== null && this.hull !== null) {
      this.nextChaffMs = nowMs + 2000 + this.rnd() * 1500;
      const s = this.spark;
      s.size0 = 1.6;
      s.size1 = 0.7;
      s.alpha = 1;
      s.hard = 1;
      s.drag = 0.5;
      s.flicker = 0.7;
      s.color.setRGB(1.0, 0.97, 0.9).multiplyScalar(7);
      const tail = this.tmpB.set(0, 0, 4.5).applyMatrix4(this.hull.matrixWorld);
      for (let i = 0; i < 9; i++) {
        s.lifeS = 1.3 + this.rnd() * 1.1;
        this.tmp
          .copy(this.forward)
          .multiplyScalar(-(14 + this.rnd() * 10))
          .addScaledVector(this.right, (this.rnd() - 0.5) * 26)
          .addScaledVector(this.up, (this.rnd() - 0.3) * 20);
        this.sparks.emit(tail, this.tmp, s);
      }
    }
  }

  /** Fire from every in-band ship: alternating pulses and multicannon bursts. */
  private shoot(frame: GameFrame, nowMs: number, lock: number, fleet: Fleet): void {
    if (nowMs - this.phaseMs < WARP_IN_S * 1000) return;
    for (let i = 0; i < frame.riders.length; i++) {
      const rider = frame.riders[i]!;
      if (!rider.inBand) continue;
      if (!fleet.hardpoints(rider.riderId, this.hardL, this.hardR, this.nose)) continue;
      let g = this.gunners.get(rider.riderId);
      if (g === undefined) {
        g = { nextPulseMs: nowMs + i * 55, side: 0, nextBurstMs: nowMs + 900 + i * 700, burstLeft: 0 };
        this.gunners.set(rider.riderId, g);
      }
      if (nowMs >= g.nextPulseMs) {
        g.nextPulseMs = nowMs + PULSE_GAP_MS;
        g.side = 1 - g.side;
        this.color.set(identityColor(i));
        this.color.multiplyScalar(3.2);
        this.launch(g.side === 0 ? this.hardL : this.hardR, 0, PULSE_SPEED, lock);
      }
      if (g.burstLeft === 0 && nowMs >= g.nextBurstMs) {
        g.burstLeft = BURST_SHOTS;
        g.nextBurstMs = nowMs;
      }
      if (g.burstLeft > 0 && nowMs >= g.nextBurstMs) {
        g.burstLeft -= 1;
        g.nextBurstMs = g.burstLeft > 0 ? nowMs + BURST_GAP_MS : nowMs + BURST_EVERY_MS * (0.8 + 0.4 * this.rnd());
        this.color.setRGB(1.0, 0.78, 0.22).multiplyScalar(4);
        this.launch(g.burstLeft % 2 === 0 ? this.hardL : this.hardR, 1, TRACER_SPEED, lock);
      }
    }
  }

  /** One bolt from `origin` at the raider (led by its velocity), plus a muzzle flash. */
  private launch(origin: THREE.Vector3, kind: number, speed: number, lock: number): void {
    const bolt = this.bolts.find((b) => !b.active);
    if (bolt === undefined) return;
    const flight = this.aim.copy(this.pos).sub(origin).length() / speed;
    this.aim.copy(this.pos).addScaledVector(this.vel, flight);
    bolt.hit = this.rnd() < 0.45 + 0.5 * lock;
    if (!bolt.hit) {
      // A near miss: past the shield, never through the hull.
      this.aim.addScaledVector(this.right, (this.rnd() < 0.5 ? -1 : 1) * (8 + this.rnd() * 6)).addScaledVector(this.up, (this.rnd() - 0.5) * 8);
    }
    bolt.dir.copy(this.aim).sub(origin);
    bolt.range = bolt.dir.length() - MUZZLE_U - (bolt.hit ? 6 : 0);
    if (bolt.range < 2) return;
    bolt.dir.normalize();
    bolt.active = true;
    bolt.kind = kind;
    bolt.head.copy(origin).addScaledVector(bolt.dir, MUZZLE_U);
    bolt.speed = speed;
    bolt.travelled = 0;
    bolt.age = 0;
    bolt.life = BOLT_LIFE_S;
    bolt.color.copy(this.color);
    const s = this.spark;
    s.size0 = kind === 0 ? 1.5 : 1.1;
    s.size1 = 0.3;
    s.lifeS = 0.07;
    s.alpha = 1;
    s.hard = 1;
    s.drag = 0;
    s.flicker = 0;
    s.color.copy(this.color).multiplyScalar(1.3);
    this.sparks.emit(origin, this.tmp.set(0, 0, 0), s);
  }

  /** A static warp streak from `from` to `to`, fading over `life` seconds. */
  private streak(from: THREE.Vector3, to: THREE.Vector3, life: number, radius: number): void {
    const bolt = this.bolts.find((b) => !b.active);
    if (bolt === undefined) return;
    bolt.active = true;
    bolt.kind = 2;
    bolt.dir.copy(to).sub(from);
    bolt.length = Math.max(1, bolt.dir.length());
    bolt.dir.normalize();
    bolt.head.copy(to);
    bolt.radius = radius;
    bolt.age = 0;
    bolt.life = life;
    bolt.speed = 0;
    bolt.color.setRGB(0.6, 0.8, 1.0).multiplyScalar(4);
  }

  private updateBolts(nowMs: number, dtS: number, camera: THREE.PerspectiveCamera): void {
    // Pulses and tracers are sized on screen: world units per 1080p px at unit
    // depth, and the frame width at unit depth.
    const tanY = Math.tan((camera.fov * Math.PI) / 360);
    const unitPx = (2 * tanY) / 1080;
    const frameW = 2 * tanY * camera.aspect;
    let n = 0;
    for (const bolt of this.bolts) {
      if (!bolt.active) continue;
      bolt.age += dtS;
      if (bolt.kind !== 2) {
        bolt.travelled += bolt.speed * dtS;
        bolt.head.addScaledVector(bolt.dir, bolt.speed * dtS);
        if (bolt.hit && bolt.travelled >= bolt.range) {
          bolt.active = false;
          if (this.phase === 'alive') this.hitShield(bolt, nowMs);
          continue;
        }
      }
      if (bolt.age >= bolt.life) {
        bolt.active = false;
        continue;
      }
      let alpha = 1 - bolt.age / bolt.life;
      let length = bolt.length;
      let radius = bolt.radius * (1 + bolt.age * 3);
      if (bolt.kind !== 2) {
        // A few px wide at any depth, and long enough to cover ~3 % of the
        // frame width once foreshortened (it flies mostly into the shot).
        const mid = this.tmp.copy(bolt.head).addScaledVector(bolt.dir, -1).sub(camera.position);
        const depth = Math.max(mid.dot(this.forward), 1);
        const across = Math.sqrt(Math.max(0, 1 - bolt.dir.dot(mid.normalize()) ** 2));
        radius = BOLT_RADIUS_PX[bolt.kind === 0 ? 0 : 1] * unitPx * depth;
        length = Math.min((BOLT_LENGTH * frameW * depth) / Math.max(across, 0.12), 0.4 * depth, bolt.travelled + 0.5);
        alpha = clamp01((bolt.life - bolt.age) / 0.2);
      }
      this.tmp.copy(bolt.head).addScaledVector(bolt.dir, -length / 2);
      this.quat.setFromUnitVectors(Z_AXIS, bolt.dir);
      this.scale.set(radius, radius, length);
      this.matrix.compose(this.tmp, this.quat, this.scale);
      this.boltMesh.setMatrixAt(n, this.matrix);
      this.boltColor[n * 3] = bolt.color.r;
      this.boltColor[n * 3 + 1] = bolt.color.g;
      this.boltColor[n * 3 + 2] = bolt.color.b;
      this.boltAlpha[n] = alpha;
      n += 1;
    }
    this.boltMesh.count = n;
    this.boltMesh.visible = n > 0;
    if (n > 0) {
      this.boltMesh.instanceMatrix.needsUpdate = true;
      this.boltMesh.geometry.getAttribute('aColor').needsUpdate = true;
      this.boltMesh.geometry.getAttribute('aAlpha').needsUpdate = true;
    }
  }

  /** A hit lights the shield where the bolt landed and throws a few sparks. */
  private hitShield(bolt: Bolt, nowMs: number): void {
    this.hitMs = nowMs;
    const dir = this.tmp.copy(bolt.dir).negate();
    if (this.hull !== null) {
      const inv = this.tmpB.copy(dir).applyQuaternion(this.quat.copy(this.hull.quaternion).invert());
      (this.shieldMat.uniforms.uHitDir!.value as THREE.Vector3).copy(inv).normalize();
    }
    const s = this.spark;
    s.size0 = 0.9;
    s.size1 = 0.2;
    s.lifeS = 0.25;
    s.alpha = 1;
    s.hard = 1;
    s.drag = 3;
    s.flicker = 0.3;
    s.color.copy(bolt.color).lerp(WHITE, 0.4);
    const at = this.tmpB.copy(this.pos).addScaledVector(dir, 5.5);
    for (let i = 0; i < 6; i++) {
      this.aim.copy(dir).multiplyScalar(10).addScaledVector(this.right, (this.rnd() - 0.5) * 14).addScaledVector(this.up, (this.rnd() - 0.5) * 14);
      this.sparks.emit(at, this.aim, s);
    }
  }

  private escape(nowMs: number, dtS: number, camera: THREE.PerspectiveCamera): void {
    const t = (nowMs - this.phaseMs) / 1000;
    if (t < ESCAPE_CHARGE_S) {
      // Settle on the (destination-clear) mark and charge the drive.
      this.markPoint(this.mark.x, this.mark.y, this.mark.d, camera, this.target);
      flyToward(this.pos, this.vel, this.acc, this.target, ASSIST_OMEGA, 0.9, ASSIST_ACCEL, dtS);
      return;
    }
    if (!this.jumped) {
      // The jump: a flash and a streak to the vanishing point.
      this.jumped = true;
      this.escapeFrom.copy(this.pos);
      this.streak(this.pos, this.tmp.copy(this.pos).addScaledVector(this.forward, 900), 0.7, 1.4);
      const s = this.spark;
      s.size0 = 18;
      s.size1 = 6;
      s.lifeS = 0.5;
      s.color.setRGB(0.65, 0.82, 1.0).multiplyScalar(6);
      s.hard = 1;
      s.alpha = 1;
      s.drag = 0;
      s.flicker = 0;
      this.sparks.emit(this.pos, this.tmp.set(0, 0, 0), s);
    }
    const k = clamp01((t - ESCAPE_CHARGE_S) / 0.3);
    this.pos.copy(this.escapeFrom).addScaledVector(this.forward, 900 * k * k);
    if (t >= ESCAPE_S) this.retire();
  }

  /** Hull pose: nose into the shot, yaw/pitch off velocity, bank off accel. */
  private placeHull(nowMs: number, lighting: Lighting): void {
    const hull = this.hull;
    const mat = this.hullMat;
    const asset = this.asset;
    if (hull === null || mat === null || asset === null) return;
    const flying = this.phase === 'alive' || this.phase === 'escaping';
    const escapeT = this.phase === 'escaping' ? (nowMs - this.phaseMs) / 1000 : 0;
    // The hull vanishes into the jump flash and streak; it never stretches.
    hull.visible = flying && escapeT < ESCAPE_CHARGE_S;
    if (!hull.visible) return;

    const vr = this.vel.dot(this.right);
    const vu = this.vel.dot(this.up);
    const ar = this.acc.dot(this.right);
    const rollS = this.rollMs < 0 ? Infinity : (nowMs - this.rollMs) / 1000;
    if (rollS >= ROLL_S) this.rollMs = -1;
    const spin = rollS < ROLL_S ? this.rollDir * 2 * Math.PI * smootherstep(rollS / ROLL_S) : 0;
    this.basis.makeBasis(this.right, this.up, this.tmp.copy(this.forward).negate());
    hull.quaternion.setFromRotationMatrix(this.basis);
    this.euler.set(clamp(Math.atan2(vu, 70), -0.5, 0.5), clamp(-Math.atan2(vr, 70), -0.6, 0.6), clamp(-Math.atan2(ar, 60), -1.1, 1.1) + spin);
    hull.quaternion.multiply(this.quat.setFromEuler(this.euler));
    hull.position.copy(this.pos);
    // Warp-in: the hull arrives stretched along the travel axis and settles.
    const warpIn = clamp01((nowMs - this.phaseMs) / (WARP_IN_S * 1000));
    hull.scale.set(1, 1, this.phase === 'alive' ? lerp(7, 1, easeOutCubic(warpIn)) : 1);
    hull.updateMatrixWorld();

    lightHull(mat, lighting);
    // A hostile ember rim keeps the dark hull readable against the void.
    (mat.uniforms.uRimColor!.value as THREE.Color).setRGB(1.0, 0.3, 0.14);
    mat.uniforms.uRimGain!.value = 0.55;
    const charge = this.phase === 'escaping' ? clamp01(escapeT / ESCAPE_CHARGE_S) : 0;
    mat.uniforms.uShimmer!.value = charge * 1.4;
    mat.uniforms.uTime!.value = nowMs * 0.001;

    // Engines: hostile red-orange, flaring on boosts, blue-white on the jump.
    const boostS = this.boostMs < 0 ? Infinity : (nowMs - this.boostMs) / 1000;
    const flare = boostS < BOOST_S ? Math.sin(Math.PI * Math.min(1, boostS / 0.1) * 0.5) * (1 - boostS / BOOST_S) : 0;
    const spec = this.spec;
    spec.core.setRGB(1.0, 0.68, 0.28).lerp(this.tmpColor.setRGB(0.8, 0.9, 1.0), charge).multiplyScalar(4.5 * (1 + flare * 1.2 + charge));
    spec.edge.setRGB(1.0, 0.22, 0.08).lerp(this.tmpColor.setRGB(0.3, 0.55, 1.0), charge);
    spec.glowColor.copy(spec.core);
    spec.length = 3.4 * (1 + flare * 1.3 + charge * 0.8);
    spec.radius = 0.45 * (1 + flare * 0.4);
    spec.glowSize = 3.4 * (1 + flare * 1.6 + charge);
    spec.ring = boostS < 0.38 ? boostS / 0.38 : -1;
    spec.quaternion.copy(hull.quaternion);
    const enginePos = mat.uniforms.uEnginePos!.value as THREE.Vector3[];
    const engineColor = mat.uniforms.uEngineColor!.value as THREE.Color[];
    for (let i = 0; i < 2; i++) {
      spec.position.copy(asset.nozzles[i]!).applyMatrix4(hull.matrixWorld);
      spec.seed = 9 + i;
      this.engines.add(spec);
      enginePos[i]!.copy(spec.position);
      engineColor[i]!.copy(spec.core).multiplyScalar(0.1);
    }
  }

  private updateReticle(nowMs: number, lock: number, camera: THREE.PerspectiveCamera): void {
    const hull = this.hull;
    const show = this.phase === 'alive' && hull !== null;
    this.reticle.visible = show;
    this.reticleScreen.on = show;
    if (!show || hull === null) return;
    // Ring radius: 1.25x the half-diagonal of the hull's screen box, taken over
    // its six extremities (nose, tail, wingtips, top, belly) in the unstretched
    // pose, in 1080p px; the quad leaves room for the ticks.
    this.matrix.compose(this.pos, hull.quaternion, ONE);
    const b = this.hullBox;
    const c = b.getCenter(this.tmpB);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 6; i++) {
      const axis = i >> 1;
      const p = this.tmp
        .copy(c)
        .setComponent(axis, (i & 1 ? b.max : b.min).getComponent(axis))
        .applyMatrix4(this.matrix)
        .project(camera);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const ringPx = Math.max(1.25 * Math.hypot((x1 - x0) * 270 * camera.aspect, (y1 - y0) * 270), 26);
    const sizePx = ringPx + 10;
    const depth = Math.max(1, this.tmpB.copy(this.pos).sub(camera.position).dot(this.forward));
    const unitPx = (2 * Math.tan((camera.fov * Math.PI) / 360)) / 1080;
    this.reticle.position.copy(this.pos);
    this.reticle.quaternion.copy(camera.quaternion);
    this.reticle.scale.setScalar(sizePx * unitPx * depth);
    const u = this.reticleMat.uniforms;
    u.uRing!.value = ringPx;
    this.tmp.copy(this.pos).project(camera);
    this.reticleScreen.x = this.tmp.x * 0.5 + 0.5;
    this.reticleScreen.y = 0.5 - this.tmp.y * 0.5;
    this.reticleScreen.r = (ringPx + 10) / 1080;
    u.uSize!.value = sizePx;
    u.uLock!.value = lock;
    u.uSolid!.value = lock >= 0.999 ? 1 : 0;
    u.uTime!.value = nowMs * 0.001;
    u.uAlpha!.value = clamp01((nowMs - this.phaseMs) / 500);
  }

  private updateShield(nowMs: number): void {
    const k = this.hitMs < 0 ? 0 : Math.exp(-(nowMs - this.hitMs) / 110);
    const show = this.phase === 'alive' && k > 0.02 && this.hull !== null;
    this.shield.visible = show;
    if (!show || this.hull === null) return;
    this.shield.position.copy(this.pos);
    this.shield.quaternion.copy(this.hull.quaternion);
    this.shield.scale.set(7.2, 3.4, 6.2);
    this.shieldMat.uniforms.uLevel!.value = k * 0.7;
  }

  /** The kill: sparks, fireball, shock ring and debris, all from the wreck. */
  private explode(): void {
    this.wreck.copy(this.pos);
    this.fireMat.uniforms.uSeed!.value = this.seedF;
    const s = this.spark;
    // White core flash.
    s.size0 = 30;
    s.size1 = 12;
    s.lifeS = 0.35;
    s.alpha = 1;
    s.hard = 1;
    s.drag = 0;
    s.flicker = 0;
    s.color.setRGB(1, 0.97, 0.9).multiplyScalar(8);
    this.sparks.emit(this.wreck, this.tmp.set(0, 0, 0), s);
    // Hot sparks.
    s.size0 = 1.1;
    s.size1 = 0.3;
    s.drag = 1.2;
    s.flicker = 0.4;
    for (let i = 0; i < 70; i++) {
      s.lifeS = 0.5 + this.rnd() * 0.9;
      s.color.setRGB(1, 0.55 + this.rnd() * 0.35, 0.2).multiplyScalar(4 + this.rnd() * 3);
      this.randomDir(this.tmp).multiplyScalar(30 + this.rnd() * 55).addScaledVector(this.vel, 0.5);
      this.sparks.emit(this.wreck, this.tmp, s);
    }
    // Fireball puffs: one at the heart, the rest seeded around it, flung outward.
    for (let i = 0; i < this.puffs.length; i++) {
      const puff = this.puffs[i]!;
      this.randomDir(puff.dir);
      puff.offset = i === 0 ? 0 : 0.1 + this.rnd() * 0.3;
      puff.travel = i === 0 ? 0.05 : 0.15 + this.rnd() * 0.2;
      puff.size = i === 0 ? 0.75 : 0.45 + this.rnd() * 0.2;
    }
    for (const chunk of this.chunks) {
      chunk.pos.copy(this.wreck).addScaledVector(this.randomDir(this.tmp), 1.5);
      chunk.vel.copy(this.randomDir(this.tmp)).multiplyScalar(6 + this.rnd() * 16).addScaledVector(this.vel, 0.3);
      chunk.spin.set((this.rnd() - 0.5) * 9, (this.rnd() - 0.5) * 9, (this.rnd() - 0.5) * 9);
      chunk.rot.set(this.rnd() * 6.28, this.rnd() * 6.28, this.rnd() * 6.28);
      // Small dark shards, not plates.
      chunk.scale.set(0.25 + this.rnd() * 0.45, 0.12 + this.rnd() * 0.23, 0.5 + this.rnd() * 0.7);
    }
  }

  private randomDir(out: THREE.Vector3): THREE.Vector3 {
    do {
      out.set(this.rnd() * 2 - 1, this.rnd() * 2 - 1, this.rnd() * 2 - 1);
    } while (out.lengthSq() > 1 || out.lengthSq() < 0.01);
    return out.normalize();
  }

  private updateWreck(nowMs: number, dtS: number, camera: THREE.PerspectiveCamera, lighting: Lighting): void {
    const t = this.phase === 'down' ? (nowMs - this.phaseMs) / 1000 : Infinity;
    const on = t < DOWN_S;
    this.fireball.visible = on && t < FIRE_S;
    this.shock.visible = on && t < 1.6;
    this.debris.visible = on;
    if (!on) {
      if (this.phase === 'down') this.retire();
      return;
    }
    // The fleet overtakes the wreck: everything streams aft (toward camera).
    this.wreck.addScaledVector(this.forward, -WRECK_STREAM * 0.35 * dtS);
    if (this.fireball.visible) {
      // Sized on screen: the cluster swells to FIRE_PEAK of the frame height.
      const depth = Math.max(1, this.tmp.copy(this.wreck).sub(camera.position).dot(this.forward));
      const peak = FIRE_PEAK * 2 * depth * Math.tan((camera.fov * Math.PI) / 360);
      const grow = 1 - Math.exp(-t * 3.2);
      for (let i = 0; i < this.puffs.length; i++) {
        const puff = this.puffs[i]!;
        this.tmp.copy(this.wreck).addScaledVector(puff.dir, peak * (puff.offset + puff.travel * grow));
        this.scale.setScalar(peak * puff.size * (0.35 + 0.65 * grow));
        this.matrix.compose(this.tmp, IDENTITY, this.scale);
        this.fireball.setMatrixAt(i, this.matrix);
      }
      this.fireball.instanceMatrix.needsUpdate = true;
      (this.fireMat.uniforms.uCenter!.value as THREE.Vector3).copy(this.wreck);
      this.fireMat.uniforms.uRadius!.value = peak;
      this.fireMat.uniforms.uT!.value = t;
    }
    this.shock.position.copy(this.wreck);
    this.shock.quaternion.copy(camera.quaternion);
    // A crisp front that stops near 45 % of the frame height.
    this.shock.scale.setScalar(2 + 18 * easeOutCubic(t / 1.6));
    this.shockMat.uniforms.uLevel!.value = (1 - t / 1.6) * clamp01(t / 0.04);

    const heat = clamp01(1 - t / 2.6);
    this.debrisMat.uniforms.uHeat!.value = heat;
    (this.debrisMat.uniforms.uKeyColor!.value as THREE.Color).copy(lighting.key);
    (this.debrisMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
    this.debrisMat.uniforms.uAmbient!.value = lighting.ambient;
    const s = this.spark;
    s.size0 = 0.6;
    s.size1 = 0.15;
    s.lifeS = 0.35;
    s.alpha = heat;
    s.hard = 1;
    s.drag = 1;
    s.flicker = 0.3;
    s.color.setRGB(1, 0.45, 0.12).multiplyScalar(3.5);
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i]!;
      c.vel.multiplyScalar(Math.exp(-0.35 * dtS));
      c.pos.addScaledVector(c.vel, dtS).addScaledVector(this.forward, -WRECK_STREAM * dtS);
      c.rot.x += c.spin.x * dtS;
      c.rot.y += c.spin.y * dtS;
      c.rot.z += c.spin.z * dtS;
      this.quat.setFromEuler(c.rot);
      this.matrix.compose(c.pos, this.quat, c.scale);
      this.debris.setMatrixAt(i, this.matrix);
      // Every hot chunk sheds embers: a short glowing trail behind it.
      if (heat > 0.3 && this.rnd() < 0.5) this.sparks.emit(c.pos, this.tmp.set(0, 0, 0), s);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.boltMesh.geometry.dispose();
    (this.boltMesh.material as THREE.Material).dispose();
    this.boltMesh.dispose();
    this.quad.dispose();
    this.reticleMat.dispose();
    this.fireMat.dispose();
    this.fireball.dispose();
    this.shockMat.dispose();
    this.shield.geometry.dispose();
    this.shieldMat.dispose();
    this.debris.geometry.dispose();
    this.debrisMat.dispose();
    this.debris.dispose();
    this.hullMat?.dispose();
    if (this.asset !== null) disposeHull(this.asset);
    this.group.clear();
  }
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(1, 1, 1);
const ONE = new THREE.Vector3(1, 1, 1);
const IDENTITY = new THREE.Quaternion();
