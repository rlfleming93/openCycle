import * as THREE from 'three';
import { hashSeed, mulberry32 } from '@opencycle/shared';
import type { LegKind } from '@opencycle/shared';

import type { GameFrame } from '../director.js';
import { CRUISE_DEST_SCREEN } from './composition.js';
import { clamp01, lerp } from './math.js';
import type { Lighting } from './sky.js';

/**
 * Everything that streams past the camera and sells forward travel: short
 * screen-constant speed streaks, space dust and an asteroid field in two belts
 * either side of the flight path. The fleet stays put; this volume recycles
 * past it at the frame's speed.
 *
 * Streaks are placed in *camera space* rather than a world box: their length is
 * solved from the depth so they never exceed STREAK_MAX_SCREEN_FRACTION of the
 * viewport height, and a protected ellipse in the middle of the frame (plus the
 * destination's own disc) is rejected at spawn, so the planet stays legible.
 */
const STREAK_COUNT = 420;
const DUST_COUNT = 700;
const ASTEROID_COUNT = 60;

/** Longest streak, as a fraction of the viewport height (plan: <= 3%). */
const STREAK_MAX_SCREEN_FRACTION = 0.03;
const STREAK_MIN_DEPTH = 45;
const STREAK_MAX_DEPTH = 260;
/** Fraction of the half-frame excluded around the centre and the destination. */
const CENTRE_CLEAR = 0.34;
const DEST_CLEAR = 0.22;
const DUST_DEPTH_MIN = 16;
const DUST_DEPTH_MAX = 200;
const DUST_HALF_X = 1.25;
const DUST_HALF_Y = 1.1;
const ASTEROID_DEPTH_MIN = 45;
const ASTEROID_DEPTH_MAX = 220;
/** Belts either side of the path, as fractions of the half-frame width. */
const BELT_INNER = 0.35;
const BELT_OUTER = 1.1;
const BELT_HALF_Y = 0.85;
const ASTEROID_SIZE_MIN = 0.5;
const ASTEROID_SIZE_MAX = 3;
const RECYCLE_BEHIND = 26;

/** Asteroid density by leg kind (plan §4 field). */
const ASTEROID_DENSITY: Record<LegKind, number> = {
  burn: 1,
  climb: 0.7,
  cruise: 0.4,
  coast: 0.2,
  launch: 0.2,
  approach: 0.2,
  free: 0.3,
};

const DUST_VERT = /* glsl */ `
attribute float aSize;
uniform float uSize;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * aSize * (260.0 / max(-mv.z, 1.0)), 1.0, 9.0);
  vFade = clamp(1.0 - (-mv.z) / 260.0, 0.15, 1.0);
}`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r) * uOpacity * vFade;
  gl_FragColor = vec4(uColor * a, a);
}`;

const ROCK_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  // Custom ShaderMaterial on an InstancedMesh: three declares instanceMatrix
  // under USE_INSTANCING but nothing applies it for us, so without this every
  // instance collapses onto the mesh origin.
  vec4 localPos = vec4(position, 1.0);
  vec3 localNormal = normal;
  #ifdef USE_INSTANCING
    localPos = instanceMatrix * localPos;
    localNormal = mat3(instanceMatrix) * localNormal;
  #endif
  mat3 world3 = mat3(modelMatrix);
  vNormalW = normalize(world3 * localNormal);
  vec4 wp = modelMatrix * localPos;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Key-lit dark rock with a faint rim, so the rocks read without a light rig. */
const ROCK_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform vec3 uFillSky;
uniform vec3 uFillGround;
uniform float uRim;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float lit = smoothstep(-0.25, 0.35, dot(N, uSunDir));
  vec3 col = uColor * (uKeyColor * (0.08 + 1.1 * lit) + 0.35 * mix(uFillGround, uFillSky, N.y * 0.5 + 0.5));
  col += uFillSky * pow(1.0 - max(dot(N, V), 0.0), 4.0) * uRim;
  gl_FragColor = vec4(col, 1.0);
}`;

interface Particle {
  x: number;
  y: number;
  z: number;
}

/** Camera basis captured once per frame; streaks and belts spawn in it. */
interface CameraBasis {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  tanHalfX: number;
  tanHalfY: number;
}

export class Field {
  readonly group = new THREE.Group();
  private readonly streakGeo: THREE.BufferGeometry;
  private readonly streakMat: THREE.LineBasicMaterial;
  private readonly streaks: Particle[] = [];
  private readonly streakPos: Float32Array;
  private readonly dustGeo: THREE.BufferGeometry;
  private readonly dustMat: THREE.ShaderMaterial;
  private readonly dust: Particle[] = [];
  private readonly dustPos: Float32Array;
  private readonly rockGeo: THREE.BufferGeometry;
  private readonly rockMat: THREE.ShaderMaterial;
  private readonly rocks: THREE.InstancedMesh;
  private readonly rockData: Particle[] = [];
  private readonly rockSpin: THREE.Euler[] = [];
  private readonly rockSize: number[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly basis: CameraBasis = {
    pos: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    tanHalfX: 0.7,
    tanHalfY: 0.4,
  };
  private aspect = 16 / 9;
  private baseRung = 0;
  private lastActive = 0;
  private elapsedS = 0;

  constructor() {
    const rnd = mulberry32(hashSeed('opencycle:field'));

    // --- speed streaks: one short screen-constant segment per streak.
    this.streakPos = new Float32Array(STREAK_COUNT * 2 * 3);
    const streakColors = new Float32Array(STREAK_COUNT * 2 * 3);
    for (let i = 0; i < STREAK_COUNT; i++) {
      // z is a negative depth ahead of the camera; seeds are resized on the
      // first update, so a placeholder only has to be "past the camera".
      this.streaks.push({ x: 0, y: 0, z: 1 });
      const b = 0.2 + rnd() * 0.35;
      for (let v = 0; v < 2; v++) {
        streakColors[(i * 2 + v) * 3] = b;
        streakColors[(i * 2 + v) * 3 + 1] = b;
        streakColors[(i * 2 + v) * 3 + 2] = b * 1.12;
      }
    }
    this.streakGeo = new THREE.BufferGeometry();
    this.streakGeo.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3));
    this.streakGeo.setAttribute('color', new THREE.BufferAttribute(streakColors, 3));
    this.streakMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const streakLines = new THREE.LineSegments(this.streakGeo, this.streakMat);
    streakLines.frustumCulled = false;
    streakLines.renderOrder = 2;

    // --- space dust
    this.dustPos = new Float32Array(DUST_COUNT * 3);
    const dustSize = new Float32Array(DUST_COUNT);
    for (let i = 0; i < DUST_COUNT; i++) {
      this.dust.push({ x: 0, y: 0, z: 1 });
      dustSize[i] = 0.4 + rnd() * 0.9;
    }
    this.dustGeo = new THREE.BufferGeometry();
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    this.dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dustSize, 1));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: 2.2 },
        uColor: { value: new THREE.Color(0xa8b4d8) },
        uOpacity: { value: 0.28 },
      },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dustPoints = new THREE.Points(this.dustGeo, this.dustMat);
    dustPoints.frustumCulled = false;
    dustPoints.renderOrder = 3;

    // --- asteroids: one instanced mesh, displaced icosahedra
    this.rockGeo = displacedIcosahedron('opencycle:rocks');
    this.rockMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x5d6169) },
        uKeyColor: { value: new THREE.Color(0xffffff) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uFillSky: { value: new THREE.Color(0x2b3a5c) },
        uFillGround: { value: new THREE.Color(0x05070c) },
        uRim: { value: 0.4 },
      },
      vertexShader: ROCK_VERT,
      fragmentShader: ROCK_FRAG,
    });
    this.rocks = new THREE.InstancedMesh(this.rockGeo, this.rockMat, ASTEROID_COUNT);
    this.rocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocks.frustumCulled = false;
    this.rocks.renderOrder = 1;
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      const rock: Particle = { x: 0, y: 0, z: 1 };
      this.rockData.push(rock);
      this.rockSpin.push(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
      // Biased toward the larger end: small rocks vanish long before they read.
      this.rockSize.push(ASTEROID_SIZE_MIN + Math.pow(rnd(), 0.55) * (ASTEROID_SIZE_MAX - ASTEROID_SIZE_MIN));
      this.dummy.position.set(rock.x, rock.y, rock.z);
      this.dummy.rotation.copy(this.rockSpin[i]!);
      this.dummy.scale.setScalar(this.rockSize[i]!);
      this.dummy.updateMatrix();
      this.rocks.setMatrixAt(i, this.dummy.matrix);
    }
    this.rocks.instanceMatrix.needsUpdate = true;

    this.group.add(streakLines, dustPoints, this.rocks);
  }

  /** Key light + rung-dependent counts. */
  setLighting(lighting: Lighting): void {
    (this.rockMat.uniforms.uKeyColor!.value as THREE.Color).copy(lighting.key);
    (this.rockMat.uniforms.uSunDir!.value as THREE.Vector3).copy(lighting.sunDir);
    (this.rockMat.uniforms.uFillSky!.value as THREE.Color).copy(lighting.fillSky);
    (this.rockMat.uniforms.uFillGround!.value as THREE.Color).copy(lighting.fillGround);
  }

  setRung(rung: number): void {
    this.baseRung = rung;
  }

  /**
   * Stream the field past the camera. `legKind` sets the asteroid density and
   * `orbit` fades the streaks to a near-stop during the arrival hold.
   */
  update(
    frame: GameFrame,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    legKind: LegKind | null,
    orbit: boolean,
  ): void {
    this.elapsedS += dtS;
    const speed = lerp(12, 60, clamp01(frame.shipSpeed)) * (0.8 + 0.4 * frame.weather) * (orbit ? 0.1 : 1);
    this.captureBasis(camera);

    const half = this.baseRung >= 2 ? 0.5 : 1;
    const streakCount = Math.max(0, Math.round(STREAK_COUNT * half * (orbit ? 0.15 : 1)));
    this.streakGeo.setDrawRange(0, streakCount * 2);
    // A z-extent at an off-axis position stretches with the perspective divide,
    // so the length is solved from the NDC extent instead of the depth: the
    // visible length never exceeds STREAK_MAX_SCREEN_FRACTION of the height.
    const maxNdcExtent = STREAK_MAX_SCREEN_FRACTION * 2;
    for (let i = 0; i < streakCount; i++) {
      const p = this.streaks[i]!;
      // Positions live in camera space: x/y are lateral offsets and z is a
      // negative depth ahead of the camera.
      p.z += speed * dtS;
      if (p.z > -STREAK_MIN_DEPTH * 0.6) {
        this.spawnPoint(p);
        p.z = -STREAK_MAX_DEPTH * (0.35 + Math.random() * 0.65);
      }
      const depth = -p.z;
      const ax = Math.abs(p.x) / (this.basis.tanHalfX * depth * depth) * this.aspect;
      const ay = Math.abs(p.y) / (this.basis.tanHalfY * depth * depth);
      const ndcPerUnit = Math.hypot(ax, ay);
      const len = Math.min(depth * 0.35, maxNdcExtent / Math.max(ndcPerUnit, 1e-6));
      const head = this.toWorld(p, this.scratchA);
      const tail = this.toWorld(this.scratchB.set(p.x, p.y, p.z - len), this.scratchB);
      const a = i * 6;
      this.streakPos[a] = tail.x;
      this.streakPos[a + 1] = tail.y;
      this.streakPos[a + 2] = tail.z;
      this.streakPos[a + 3] = head.x;
      this.streakPos[a + 4] = head.y;
      this.streakPos[a + 5] = head.z;
    }
    this.streakGeo.getAttribute('position').needsUpdate = true;
    this.streakMat.opacity = (0.1 + 0.22 * clamp01(frame.shipSpeed)) * (orbit ? 0.15 : 1);

    const dustCount = Math.max(0, Math.round(DUST_COUNT * half));
    this.dustGeo.setDrawRange(0, dustCount);
    for (let i = 0; i < dustCount; i++) {
      const p = this.dust[i]!;
      p.z += speed * dtS * 0.85;
      if (p.z > -DUST_DEPTH_MIN * 0.5) {
        const spawn = this.spawnVolume(p, DUST_HALF_X, DUST_HALF_Y, DUST_DEPTH_MIN, DUST_DEPTH_MAX);
        p.x = spawn.x;
        p.y = spawn.y;
        p.z = spawn.z;
      }
      const world = this.toWorld(p, this.scratchA);
      this.dustPos[i * 3] = world.x;
      this.dustPos[i * 3 + 1] = world.y;
      this.dustPos[i * 3 + 2] = world.z;
    }
    this.dustGeo.getAttribute('position').needsUpdate = true;

    // Asteroid density follows the leg kind; rung 2 halves the field again.
    const density = ASTEROID_DENSITY[legKind ?? 'free'];
    const active = Math.max(0, Math.round(ASTEROID_COUNT * density * half));
    this.rocks.count = active;
    for (let i = 0; i < active; i++) {
      const rock = this.rockData[i]!;
      if (i >= this.lastActive) {
        const spawn = this.spawnBelt(rock);
        rock.x = spawn.x;
        rock.y = spawn.y;
        rock.z = spawn.z;
      }
      rock.z += speed * dtS * 0.55;
      const depth = Math.max(1, -rock.z);
      const su = rock.x / (this.basis.tanHalfX * depth);
      const sv = rock.y / (this.basis.tanHalfY * depth);
      if (rock.z > -RECYCLE_BEHIND || Math.abs(su) > 1.5 || Math.abs(sv) > 1.5) {
        const spawn = this.spawnBelt(rock);
        rock.x = spawn.x;
        rock.y = spawn.y;
        rock.z = spawn.z;
      }
      const spin = this.rockSpin[i]!;
      const world = this.toWorld(rock, this.scratchA);
      const d = this.dummy;
      d.position.copy(world);
      d.rotation.set(spin.x + this.elapsedS * 0.05, spin.y + this.elapsedS * 0.04, spin.z);
      d.scale.setScalar(this.rockSize[i]!);
      d.updateMatrix();
      this.rocks.setMatrixAt(i, d.matrix);
    }
    this.rocks.instanceMatrix.needsUpdate = true;
    this.lastActive = active;
  }

  /** Cache the camera basis: the field lives in camera space. */
  private captureBasis(camera: THREE.PerspectiveCamera): void {
    this.basis.pos.copy(camera.position);
    camera.getWorldDirection(this.basis.forward);
    this.basis.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.basis.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const fovY = (camera.fov * Math.PI) / 180;
    this.basis.tanHalfY = Math.tan(fovY / 2);
    this.basis.tanHalfX = this.basis.tanHalfY * camera.aspect;
    this.aspect = camera.aspect;
  }

  /** Camera-space (lateral, lateral, -depth) -> world. Aliasing-safe: `out`
   *  may be the same object as `p`. */
  private toWorld(p: Particle, out: THREE.Vector3): THREE.Vector3 {
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    return out
      .copy(this.basis.pos)
      .addScaledVector(this.basis.forward, -pz)
      .addScaledVector(this.basis.right, px)
      .addScaledVector(this.basis.up, py);
  }

  /**
   * A streak spawn that keeps the middle of the frame clear: lateral offsets
   * are drawn in frame-scaled units and rejected inside the protected ellipse
   * around the centre and around the destination's mark.
   */
  private spawnPoint(into: Particle): Particle {
    const destU = 2 * CRUISE_DEST_SCREEN.x - 1;
    const destV = 1 - 2 * CRUISE_DEST_SCREEN.y;
    for (let attempt = 0; attempt < 6; attempt++) {
      const dz = STREAK_MIN_DEPTH + Math.random() * (STREAK_MAX_DEPTH - STREAK_MIN_DEPTH);
      const u = (Math.random() * 2 - 1) * 1.35 * this.basis.tanHalfX * dz;
      const v = (Math.random() * 2 - 1) * 1.35 * this.basis.tanHalfY * dz;
      const su = u / (this.basis.tanHalfX * dz);
      const sv = v / (this.basis.tanHalfY * dz);
      const nearCentre = Math.hypot(su, sv) < CENTRE_CLEAR;
      const nearDest = Math.hypot(su - destU, sv - destV) < DEST_CLEAR;
      if (nearCentre || nearDest) continue;
      into.x = u;
      into.y = v;
      return into;
    }
    // Fallback: push well out to the side of the frame.
    into.x = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.5) * this.basis.tanHalfX * STREAK_MAX_DEPTH;
    into.y = (Math.random() * 2 - 1) * this.basis.tanHalfY * STREAK_MAX_DEPTH;
    return into;
  }

  /** A dust spawn anywhere in the forward volume. */
  private spawnVolume(into: Particle, halfX: number, halfY: number, minDepth: number, maxDepth: number): Particle {
    const dz = minDepth + Math.random() * (maxDepth - minDepth);
    into.x = (Math.random() * 2 - 1) * halfX * this.basis.tanHalfX * dz;
    into.y = (Math.random() * 2 - 1) * halfY * this.basis.tanHalfY * dz;
    into.z = -dz;
    return into;
  }

  /** Asteroid spawn in one of the two side belts, never in front of the system. */
  private spawnBelt(into: Particle): Particle {
    for (let attempt = 0; attempt < 6; attempt++) {
      // Biased away from the camera: a 3 u rock at 45 u already covers ~120 px.
      const dz = ASTEROID_DEPTH_MIN + Math.pow(Math.random(), 0.85) * (ASTEROID_DEPTH_MAX - ASTEROID_DEPTH_MIN);
      const side = Math.random() < 0.5 ? -1 : 1;
      const belt = BELT_INNER + Math.random() * (BELT_OUTER - BELT_INNER);
      const u = side * belt * this.basis.tanHalfX * dz;
      const v = (Math.random() * 2 - 1) * BELT_HALF_Y * this.basis.tanHalfY * dz;
      const su = u / (this.basis.tanHalfX * dz);
      const sv = v / (this.basis.tanHalfY * dz);
      const dU = su - (2 * 0.62 - 1);
      const dV = sv + (2 * 0.33 - 1);
      if (Math.hypot(dU, dV) < DEST_CLEAR) continue;
      into.x = u;
      into.y = v;
      into.z = -dz;
      return into;
    }
    into.x = (Math.random() < 0.5 ? -1 : 1) * BELT_INNER * this.basis.tanHalfX * ASTEROID_DEPTH_MAX;
    into.y = 0;
    into.z = -ASTEROID_DEPTH_MAX;
    return into;
  }

  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();

  dispose(): void {
    this.streakGeo.dispose();
    this.streakMat.dispose();
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.rockGeo.dispose();
    this.rockMat.dispose();
    this.rocks.dispose();
    this.group.clear();
  }
}

/** Icosahedron with per-position radial displacement (welded, so it stays closed). */
function displacedIcosahedron(seed: string): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.getAttribute('position');
  const offsets = new Map<string, number>();
  const rnd = mulberry32(hashSeed(seed));
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3]!;
    const y = arr[i * 3 + 1]!;
    const z = arr[i * 3 + 2]!;
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let scale = offsets.get(key);
    if (scale === undefined) {
      scale = 0.68 + rnd() * 0.62;
      offsets.set(key, scale);
    }
    arr[i * 3] = x * scale;
    arr[i * 3 + 1] = y * scale;
    arr[i * 3 + 2] = z * scale;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
