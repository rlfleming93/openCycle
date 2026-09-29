import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { Belts } from './belts.js';
import { FLOW_GLSL, Flow, REVEAL_CALM_S, flowLayer } from './flow.js';
import type { ShipBounds } from './fleet.js';
import { NOISE_GLSL } from './glsl.js';
import { clamp01, seededRandom } from './math.js';
import { RAIDER_BOX } from './raiders.js';
import type { Lighting } from './sky.js';

/**
 * Everything that streams past and sells forward travel, all of it placed on
 * the GPU by the shared flow (flow.ts): short speed streaks, space dust,
 * glinting debris and ice shards that catch the anchor, a dust and ice haze on
 * burns, and the belts (belts.ts: rocks at three depths, hero rocks,
 * wreckage, the odd derelict). The CPU only integrates travel and sets a few
 * uniforms per frame.
 */
const STREAK_COUNT = 420;
const DUST_COUNT = 1600;
const GLINT_COUNT = 1100;
const HAZE_COUNT = 26;

/** Longest streak, as a fraction of the viewport height (plan: <= 3%). */
const STREAK_MAX_SCREEN_FRACTION = 0.03;
/** Streaks outrun the world: they are a speed cue, not objects. */
const STREAK_RATE = 1.8;

const FLAT: Record<LegKind, number> = { burn: 1, climb: 1, cruise: 1, coast: 1, launch: 1, approach: 1, free: 1 };
const GLINT_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.75, cruise: 0.5, coast: 0.3, launch: 0.4, approach: 0.4, free: 0.45 };
/** The haze is a burn thing: you punch through it. */
const HAZE_DENSITY: Record<LegKind, number> = { burn: 1, climb: 0.25, cruise: 0, coast: 0, launch: 0, approach: 0, free: 0 };

/** One streak = two vertices; the tail is solved on screen so it never exceeds the cap. */
const STREAK_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
attribute float aEnd;
uniform float uMaxNdc;
varying float vBright;
void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  float r = sqrt(mix(45.0 * 45.0, 230.0 * 230.0, h.x));
  vec2 lat = vec2(cos(h.y * 6.2831853), sin(h.y * 6.2831853)) * r;
  vec3 head = ocFlowPoint(lat, u);
  vec4 hc = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 tc = projectionMatrix * viewMatrix * vec4(head + uFlowT * 0.35 * max(-(viewMatrix * vec4(head, 1.0)).z, 1.0), 1.0);
  if (hc.w < 1.0 || tc.w < 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
  vec2 hn = hc.xy / hc.w;
  vec2 d = tc.xy / tc.w - hn;
  float len = length(vec2(d.x * aspect, d.y));
  d *= min(1.0, uMaxNdc / max(len, 1e-5));
  gl_Position = aEnd < 0.5 ? hc : vec4((hn + d) * tc.w, tc.z, tc.w);
  vBright = aSeed.z * ocFlowEnds(u) * ocDestClear(head, 0.0) * (aEnd < 0.5 ? 1.0 : 0.12);
}`;

const STREAK_FRAG = /* glsl */ `
uniform float uOpacity;
varying float vBright;
void main() {
  vec3 c = vec3(0.9, 0.93, 1.0) * vBright * uOpacity;
  gl_FragColor = vec4(c, 1.0);
}`;

const DUST_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
uniform float uSize;
varying float vFade;
void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  float r = 135.0 * sqrt(h.x);
  vec3 p = ocFlowPoint(vec2(cos(h.y * 6.2831853), sin(h.y * 6.2831853)) * r, u);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.4 + 0.9 * aSeed.z) * (260.0 / max(-mv.z, 1.0)), 1.0, 9.0);
  vFade = clamp(1.0 - (-mv.z) / 260.0, 0.15, 1.0) * ocFlowEnds(u) * smoothstep(3.0, 10.0, -mv.z);
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

/**
 * Glints: tiny tumbling flakes. Each has a facet normal spinning about its own
 * axis; it flashes when the facet mirrors the anchor into the camera, and ice
 * forward-scatters when you look toward the light.
 */
const GLINT_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
uniform vec3 uKeyColor;
uniform vec3 uSunDir;
uniform float uPxScale;
varying vec3 vColor;
void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  float r = 95.0 * sqrt(h.x);
  vec3 p = ocFlowPoint(vec2(cos(h.y * 6.2831853), sin(h.y * 6.2831853)) * r, u);
  float show = step(h.z, ocFlowDensity(u)) * ocFlowEnds(u);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  if (show <= 0.0 || depth < 2.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * mv;
  vec4 k = ocHash41(aSeed.y * 0.91 + 3.0);
  vec3 axis = normalize(k.xyz - 0.5);
  vec3 n = ocRotate(normalize(vec3(k.w - 0.5, 0.35, h.w - 0.5)), axis, uFlowTime * (1.0 + 3.0 * aSeed.w) + k.w * 9.0);
  vec3 V = normalize(cameraPosition - p);
  float mirror = pow(max(dot(reflect(-uSunDir, n), V), 0.0), 90.0);
  float ice = step(0.55, aSeed.z);
  float scatter = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  float light = 0.02 + 14.0 * mirror + ice * 0.5 * scatter;
  vec3 tint = mix(vec3(1.0, 0.92, 0.8), vec3(0.72, 0.88, 1.0), ice);
  // A flake is far below a pixel: its light spreads over a 1-3 px point.
  float px = clamp(uPxScale * 0.08 / depth, 1.0, 2.5) + 2.0 * mirror;
  gl_PointSize = px;
  vColor = tint * uKeyColor * light * show * smoothstep(240.0, 120.0, depth) / (px * px) * min(1.0, 40.0 / depth);
}`;

const GLINT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float f = exp(-dot(d, d) * 10.0);
  gl_FragColor = vec4(vColor * f, 1.0);
}`;

/**
 * Haze: soft camera-facing puffs of dust and ice, lit by the anchor with a
 * forward-scattering lobe. Each puff fades out before the camera reaches it
 * and wherever it would meet a surface edge-on is irrelevant: it is additive
 * and never writes depth.
 */
const HAZE_VERT = /* glsl */ `
${FLOW_GLSL}
attribute vec4 aSeed;
uniform vec3 uSunDir;
varying vec2 vUv;
varying float vAlpha;
varying float vPhase;
varying float vIce;
varying float vSeed;
void main() {
  float cycle;
  float u = ocFlowU(aSeed.x, cycle);
  vec4 h = ocHash41(aSeed.y * 1.37 + cycle * 7.13);
  float r = sqrt(mix(15.0 * 15.0, 150.0 * 150.0, h.x));
  vec3 c = ocFlowPoint(vec2(cos(h.y * 6.2831853), sin(h.y * 6.2831853)) * r, u);
  float radius = 12.0 + 20.0 * aSeed.z;
  float dist = length(c - cameraPosition);
  // Soft near fade: gone before the camera enters the puff.
  float near = smoothstep(radius * 0.9, radius * 2.2, dist);
  float show = step(h.z, ocFlowDensity(u)) * ocFlowEnds(u) * near * smoothstep(420.0, 260.0, dist);
  if (show <= 0.001) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 p = c + (right * position.x + up * position.y) * radius;
  vUv = position.xy;
  vAlpha = show;
  vPhase = dot(normalize(c - cameraPosition), uSunDir);
  vIce = step(0.5, h.w);
  vSeed = aSeed.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const HAZE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform vec3 uKeyColor;
uniform vec3 uFill;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vPhase;
varying float vIce;
varying float vSeed;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float n = ocFbm(vec3(vUv * 1.9, vSeed * 0.37), 3.0);
  // Soft wisps: a wide noise ramp (a narrow one cuts flat, hard-edged blobs).
  float d = exp(-r2 * 3.0) * smoothstep(0.25, 0.95, n + 0.15 * (1.0 - r2));
  // Henyey-Greenstein, g = 0.6, capped: the dust warms toward the anchor
  // without turning into a lamp.
  float g = 0.6;
  float hg = min((1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * vPhase, 1.5) * 0.25, 0.8);
  vec3 tint = mix(vec3(0.6, 0.5, 0.42), vec3(0.55, 0.75, 1.0), vIce);
  vec3 c = tint * (uKeyColor * (0.015 + hg) + uFill * 3.0) * d * vAlpha * uOpacity;
  gl_FragColor = vec4(c, 1.0);
}`;

export class Field {
  readonly group = new THREE.Group();
  /** The shared flow: travel, density ramp, corridor (flybys read `travel`). */
  readonly flow = new Flow();
  private readonly belts: Belts;
  private readonly streakGeo: THREE.BufferGeometry;
  private readonly streakMat: THREE.ShaderMaterial;
  private readonly dustGeo: THREE.BufferGeometry;
  private readonly dustMat: THREE.ShaderMaterial;
  private readonly glintGeo: THREE.BufferGeometry;
  private readonly glintMat: THREE.ShaderMaterial;
  private readonly hazeGeo: THREE.InstancedBufferGeometry;
  private readonly hazeMat: THREE.ShaderMaterial;
  private readonly haze: THREE.Mesh;
  private readonly raiderBox: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private rung = 0;
  private shipCount = -1;
  private reveal = 1;
  private elapsedS = 0;
  /** End of the reveal calm (s); -1 until the first frame. */
  private calmUntilS = -1;
  private settled = false;

  constructor() {
    const flow = this.flow;
    const streak = flow.add(flowLayer(260, 18, FLAT, STREAK_RATE));
    const dust = flow.add(flowLayer(200, 14, FLAT));
    const glints = flow.add(flowLayer(250, 10, GLINT_DENSITY));
    const haze = flow.add(flowLayer(460, 40, HAZE_DENSITY));

    // Streaks: two vertices each, sharing one seed.
    this.streakGeo = new THREE.BufferGeometry();
    const streakSeed = particleSeeds(STREAK_COUNT, 2, 101, (rnd) => 0.2 + rnd() * 0.35);
    const ends = new Float32Array(STREAK_COUNT * 2);
    for (let i = 0; i < STREAK_COUNT; i++) ends[i * 2 + 1] = 1;
    this.streakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STREAK_COUNT * 6), 3));
    this.streakGeo.setAttribute('aSeed', new THREE.BufferAttribute(streakSeed, 4));
    this.streakGeo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: { ...flow.uniforms, ...streak.uniforms, uMaxNdc: { value: 0.06 }, uOpacity: { value: 0.3 } },
      vertexShader: STREAK_VERT,
      fragmentShader: STREAK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const streaks = new THREE.LineSegments(this.streakGeo, this.streakMat);
    streaks.frustumCulled = false;
    streaks.renderOrder = 2;

    this.dustGeo = pointsGeometry(DUST_COUNT, 103);
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        ...flow.uniforms,
        ...dust.uniforms,
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

    this.glintGeo = pointsGeometry(GLINT_COUNT, 107);
    this.glintMat = new THREE.ShaderMaterial({
      uniforms: {
        ...flow.uniforms,
        ...glints.uniforms,
        uKeyColor: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uPxScale: { value: 1000 },
      },
      vertexShader: GLINT_VERT,
      fragmentShader: GLINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glintPoints = new THREE.Points(this.glintGeo, this.glintMat);
    glintPoints.frustumCulled = false;
    glintPoints.renderOrder = 3;

    this.hazeGeo = new THREE.InstancedBufferGeometry();
    this.hazeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.hazeGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.hazeGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(particleSeeds(HAZE_COUNT, 1, 109, (rnd) => rnd()), 4));
    this.hazeGeo.instanceCount = HAZE_COUNT;
    this.hazeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...flow.uniforms,
        ...haze.uniforms,
        uKeyColor: this.glintMat.uniforms.uKeyColor!,
        uSunDir: this.glintMat.uniforms.uSunDir!,
        uFill: { value: new THREE.Color() },
        uOpacity: { value: 0.045 },
      },
      vertexShader: HAZE_VERT,
      fragmentShader: HAZE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.haze = new THREE.Mesh(this.hazeGeo, this.hazeMat);
    this.haze.frustumCulled = false;
    this.haze.renderOrder = 4;

    this.belts = new Belts(flow);
    this.group.add(this.belts.group, streaks, dustPoints, glintPoints, this.haze);
  }

  /** Travel distance so far (u): the flybys drift on it. */
  get travel(): number {
    return this.flow.travel;
  }

  /**
   * Key light, sky fill and rim, bound by reference (they update in place),
   * and the anchor core the big solids keep clear of on screen.
   */
  setLighting(lighting: Lighting, anchorCore: number): void {
    this.belts.setLighting(lighting);
    this.glintMat.uniforms.uKeyColor!.value = lighting.key;
    this.glintMat.uniforms.uSunDir!.value = lighting.sunDir;
    this.hazeMat.uniforms.uFill!.value = lighting.fillSky;
    this.flow.setAnchor(lighting.sunDir, anchorCore * 1.3);
  }

  /** The FSD's system reveal (0 hidden, 1 shown): the big classes stay out until it has settled. */
  setReveal(k: number): void {
    this.reveal = k;
  }

  /** Rung 2+ halves every class and drops the haze. */
  setRung(rung: number): void {
    this.rung = rung;
    this.belts.setRung(rung);
    const k = rung >= 2 ? 0.5 : 1;
    this.dustGeo.setDrawRange(0, Math.round(DUST_COUNT * k));
    this.glintGeo.setDrawRange(0, Math.round(GLINT_COUNT * k));
    this.haze.visible = rung < 2;
  }

  /** Burn-start boost: a surge of speed and a burst of speed dust. */
  boost(nowMs: number): void {
    this.flow.boost(nowMs);
  }

  /**
   * Advance the flow and refresh the per-frame uniforms. `chase` adds the
   * raider's sightline to the corridor, `orbit` slows everything to a drift
   * for the arrival hold, and `cut` (or a changed fleet) re-solves the
   * corridor. Far objects clear the destination disc (`destination` null
   * without one).
   */
  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    bounds: readonly ShipBounds[],
    chase: boolean,
    orbit: boolean,
    cut: boolean,
    destination: THREE.Vector3 | null,
    destinationRadius: number,
    viewportH: number,
  ): void {
    const flow = this.flow;
    flow.update(frame, nowMs, dtS, camera, orbit, destination, destinationRadius);
    // The system reads clean at the reveal: heroes, wreckage and the derelict
    // stay out while it is hidden and for REVEAL_CALM_S after, then sweep in
    // from the far end. By then the camera has eased out of the jump pose, so
    // the corridor and the clear headings are solved again for the real shot.
    this.elapsedS += dtS;
    let solve = cut || bounds.length !== this.shipCount;
    if (this.reveal < 1 || this.calmUntilS < 0) {
      this.calmUntilS = this.elapsedS + REVEAL_CALM_S;
      this.settled = false;
    }
    if (!this.settled) {
      for (const layer of this.belts.big) flow.hold(layer, (this.calmUntilS - this.elapsedS) * flow.speed);
      if (this.elapsedS >= this.calmUntilS) {
        this.settled = true;
        solve = true;
      }
    }
    if (solve) {
      flow.solveCorridor(camera, bounds, chase ? this.solveRaiderBox(camera, bounds) : null);
      this.belts.solveSectors(camera);
      this.shipCount = bounds.length;
    }
    const burst = flow.burst;

    const pxScale = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.belts.update(pxScale);
    this.glintMat.uniforms.uPxScale!.value = pxScale;
    this.streakMat.uniforms.uMaxNdc!.value = STREAK_MAX_SCREEN_FRACTION * 2 * (1 + 1.5 * burst);
    this.streakMat.uniforms.uOpacity!.value = (0.1 + 0.22 * clamp01(frame.shipSpeed)) * (orbit ? 0.15 : 1) * (1 + 1.2 * burst);
    this.streakGeo.setDrawRange(0, Math.round(STREAK_COUNT * (this.rung >= 2 ? 0.5 : 1) * (orbit ? 0.3 : 1)) * 2);
    this.dustMat.uniforms.uOpacity!.value = 0.28 * (1 + 1.5 * burst);
  }

  /**
   * The raider's readable box in world space from this camera: its four screen
   * corners at the box's near and far depth past the fleet centre.
   */
  private solveRaiderBox(camera: THREE.PerspectiveCamera, bounds: readonly ShipBounds[]): THREE.Vector3[] {
    const axis = camera.getWorldDirection(this.tmp);
    let centerDepth = 30;
    if (bounds.length > 0) {
      centerDepth = 0;
      for (const b of bounds) centerDepth += this.tmp2.copy(b.position).sub(camera.position).dot(axis);
      centerDepth /= bounds.length;
    }
    let i = 0;
    for (const depth of RAIDER_BOX.depth) {
      for (const x of RAIDER_BOX.x) {
        for (const y of RAIDER_BOX.y) {
          const p = this.raiderBox[i++]!.set(2 * x - 1, 1 - 2 * y, 0.5).unproject(camera).sub(camera.position);
          p.multiplyScalar((centerDepth + depth) / p.dot(axis)).add(camera.position);
        }
      }
    }
    return this.raiderBox;
  }

  dispose(): void {
    this.belts.dispose();
    this.streakGeo.dispose();
    this.streakMat.dispose();
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.glintGeo.dispose();
    this.glintMat.dispose();
    this.hazeGeo.dispose();
    this.hazeMat.dispose();
    this.group.clear();
  }
}

/**
 * Seeds for `count` particles, each repeated `per` times (a streak's two
 * vertices): along phase on a golden-ratio sequence, a salt, a brightness or
 * size draw, a spin draw.
 */
function particleSeeds(count: number, per: number, salt: number, third: (rnd: () => number) => number): Float32Array {
  const rnd = seededRandom(`opencycle:flow:${salt}`);
  const out = new Float32Array(count * per * 4);
  for (let i = 0; i < count; i++) {
    const seed = [(i * 0.6180339887 + rnd() * 0.05) % 1, salt + i * 1.618 + rnd() * 0.5, third(rnd), rnd()];
    for (let v = 0; v < per; v++) out.set(seed, (i * per + v) * 4);
  }
  return out;
}

function pointsGeometry(count: number, salt: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(particleSeeds(count, 1, salt, (rnd) => rnd()), 4));
  return geo;
}
