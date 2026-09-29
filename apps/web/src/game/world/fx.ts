import * as THREE from 'three';

import { identityColor } from '../../lib/identity.js';
import type { GameFrame } from '../director.js';
import type { Destination } from './planets.js';
import type { Fleet } from './fleet.js';
import { clamp01, easeOutCubic } from './math.js';
import { Ribbon } from './ribbon.js';
import type { Route } from './route.js';

/**
 * The co-op and survey effects: survey probes launched on clean legs, the
 * bothInZone tether between ships, beacon flares along the route and the rescue
 * shield.
 *
 * Sizes are authored in 1080p pixels and converted through the live projection
 * scale, so every effect stays readable at any internal resolution: the probe
 * head is an 18 px sprite, its trail a tapering ribbon, and the flares expand
 * to 150-220 px.
 */
const PROBE_POOL = 3;
const PROBE_DUR_S = 1.5;
/** After landing the trail keeps fading for this long, so the flight reads even
 *  in a capture taken a beat late. */
const PROBE_HOLD_S = 0.7;
const PROBE_TRAIL_POINTS = 14;
const PROBE_HEAD_PX = 26;
const PROBE_TRAIL_PX = 4.2;
const PROBE_TRAIL_FRACTION = 0.22;
const FLASH_DUR_S = 0.6;
const FLASH_PX_START = 60;
const FLASH_PX_END = 220;
const BEACON_DUR_S = 1.2;
const BEACON_PX_START = 40;
const BEACON_PX_END = 150;
const TETHER_POINTS = 24;
const TETHER_PX = 3.5;
const SHIELD_RADIUS = 5.4;

const FLARE_VERT = /* glsl */ `
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(2.0, uSize);
}`;

const FLARE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = smoothstep(0.5, 0.0, r);
  // A wide soft halo plus a hard core: reads over the nebula haze, which a
  // core-only sprite does not.
  float halo = smoothstep(0.5, 0.06, r);
  float a = (core * core + 0.35 * halo) * uOpacity;
  gl_FragColor = vec4(uColor * (0.75 + 0.9 * core), a);
}`;

const SHIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 2.2);
  float ripple = 0.85 + 0.15 * sin(vWorldPos.y * 1.4 - uTime * 2.6);
  float a = fres * uOpacity * ripple;
  gl_FragColor = vec4(uColor * a, a);
}`;

const SHIELD_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

interface Probe {
  head: THREE.Points;
  trail: Ribbon;
  /** Landing fade timer; -1 while flying. */
  hold: number;
  mat: THREE.ShaderMaterial;
  headPos: THREE.BufferAttribute;
  path: Float32Array;
  halfWidths: Float32Array;
  active: boolean;
  t: number;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  span: number;
}

export class Fx {
  readonly group = new THREE.Group();
  private readonly probes: Probe[] = [];
  private readonly flash: THREE.Points;
  private readonly flashMat: THREE.ShaderMaterial;
  private readonly beacon: THREE.Points;
  private readonly beaconMat: THREE.ShaderMaterial;
  private readonly tether: Ribbon;
  private readonly tetherPath = new Float32Array(TETHER_POINTS * 3);
  private readonly tetherWidths = new Float32Array(TETHER_POINTS);
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.ShaderMaterial;
  private readonly sphere: THREE.SphereGeometry;
  private readonly colorA = new THREE.Color();
  private readonly colorB = new THREE.Color();
  /** Pixels per world unit at one unit of depth (internal height based). */
  private screenScale = 540;
  /** Internal device pixels per 1080p pixel, so effect sizes stay CSS-stable. */
  private viewScale = 1;
  private flashLife = -1;
  private beaconLife = -1;
  private shieldLife = -1;
  private shieldRider: string | null = null;
  private elapsedS = 0;
  private readonly scratch = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();

  constructor() {
    for (let i = 0; i < PROBE_POOL; i++) this.probes.push(this.makeProbe());

    const flashGeo = new THREE.BufferGeometry();
    const flashPos = new THREE.BufferAttribute(new Float32Array(3), 3);
    flashGeo.setAttribute('position', flashPos);
    this.flashMat = this.flareMaterial(new THREE.Color(0xfff0d0), FLASH_PX_START);
    this.flash = new THREE.Points(flashGeo, this.flashMat);
    this.flash.visible = false;
    this.flash.frustumCulled = false;

    const beaconGeo = new THREE.BufferGeometry();
    const beaconPos = new THREE.BufferAttribute(new Float32Array(3), 3);
    beaconGeo.setAttribute('position', beaconPos);
    this.beaconMat = this.flareMaterial(new THREE.Color(0x5ee6a8), BEACON_PX_START);
    this.beacon = new THREE.Points(beaconGeo, this.beaconMat);
    this.beacon.visible = false;
    this.beacon.frustumCulled = false;

    this.tether = new Ribbon(TETHER_POINTS, 0.9);

    this.sphere = new THREE.SphereGeometry(1, 32, 20);
    this.shieldMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x5b8cff) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: SHIELD_VERT,
      fragmentShader: SHIELD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    this.shield = new THREE.Mesh(this.sphere, this.shieldMat);
    this.shield.visible = false;
    this.shield.frustumCulled = false;
    this.shield.scale.setScalar(SHIELD_RADIUS);

    this.group.add(
      ...this.probes.map((p) => p.head),
      ...this.probes.map((p) => p.trail.object),
      this.flash,
      this.beacon,
      this.tether.object,
      this.shield,
    );
  }

  private flareMaterial(color: THREE.Color, size: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color },
        uOpacity: { value: 0 },
        uSize: { value: size },
      },
      vertexShader: FLARE_VERT,
      fragmentShader: FLARE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }

  private makeProbe(): Probe {
    const headGeo = new THREE.BufferGeometry();
    const headPos = new THREE.BufferAttribute(new Float32Array(3), 3);
    headGeo.setAttribute('position', headPos);
    const mat = this.flareMaterial(new THREE.Color(0xffffff), PROBE_HEAD_PX);
    const head = new THREE.Points(headGeo, mat);
    head.visible = false;
    head.frustumCulled = false;
    const trail = new Ribbon(PROBE_TRAIL_POINTS, 0.95);
    return {
      head,
      trail,
      hold: -1,
      mat,
      headPos,
      path: new Float32Array(PROBE_TRAIL_POINTS * 3),
      halfWidths: new Float32Array(PROBE_TRAIL_POINTS),
      active: false,
      t: 0,
      from: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      span: 0,
    };
  }

  /** Keep screen sizes constant across the internal-resolution rungs. */
  setViewportScale(scale: number): void {
    this.viewScale = scale;
  }

  /** Pixels per world unit at one unit of depth, from the live camera. */
  setScreenScale(scale: number): void {
    this.screenScale = scale;
  }

  /**
   * Advance every effect for this frame.
   * `legComplete` (clean) launches a probe, `beacon` fires a route flare,
   * `syncLit` draws the tether and `rescue` holds the shield.
   */
  update(
    frame: GameFrame,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    fleet: Fleet,
    destination: Destination,
    route: Route,
  ): void {
    this.elapsedS += dtS;
    for (const event of frame.events) {
      if (event.kind === 'legComplete' && event.clean) this.launchProbe(event.riderId, fleet, destination);
      if (event.kind === 'beacon') this.fireBeacon(event.streakS, fleet, route, frame);
    }

    for (const probe of this.probes) {
      if (!probe.active) {
        // Landing hold: the trail lingers, fading, while the limb flash plays.
        if (probe.hold >= 0 && probe.trail.object.visible) {
          probe.hold += dtS;
          const k = clamp01(probe.hold / PROBE_HOLD_S);
          probe.trail.material.uniforms.uOpacity!.value = 0.9 * (1 - k);
          if (k >= 1) {
            probe.hold = -1;
            probe.trail.object.visible = false;
          }
        }
        continue;
      }
      probe.t += dtS / PROBE_DUR_S;
      if (probe.t >= 1) {
        probe.active = false;
        probe.head.visible = false;
        probe.hold = 0;
        this.flashLife = 0;
        destination.surfacePoint(probe.dir, this.scratch);
        (this.flash.geometry.getAttribute('position') as THREE.BufferAttribute).setXYZ(
          0,
          this.scratch.x,
          this.scratch.y,
          this.scratch.z,
        );
        (this.flash.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        continue;
      }
      this.layoutProbe(probe, camera);
    }

    if (this.flashLife >= 0) {
      this.flashLife += dtS;
      const k = clamp01(this.flashLife / FLASH_DUR_S);
      this.flash.visible = true;
      this.flashMat.uniforms.uOpacity!.value = (1 - k) * 0.95;
      this.flashMat.uniforms.uSize!.value = (FLASH_PX_START + (FLASH_PX_END - FLASH_PX_START) * easeOutCubic(k)) * this.viewScale;
      if (k >= 1) {
        this.flashLife = -1;
        this.flash.visible = false;
      }
    }

    if (this.beaconLife >= 0) {
      this.beaconLife += dtS;
      const k = clamp01(this.beaconLife / BEACON_DUR_S);
      this.beacon.visible = true;
      this.beaconMat.uniforms.uOpacity!.value = (1 - k) * (1 - k) * 0.95;
      this.beaconMat.uniforms.uSize!.value = (BEACON_PX_START + (BEACON_PX_END - BEACON_PX_START) * easeOutCubic(k)) * this.viewScale;
      if (k >= 1) {
        this.beaconLife = -1;
        this.beacon.visible = false;
      }
    }

    this.updateTether(frame, camera, fleet);
    this.updateShield(frame, dtS, fleet);
  }

  private launchProbe(riderId: string, fleet: Fleet, destination: Destination): void {
    const probe = this.probes.find((p) => !p.active);
    if (probe === undefined) return;
    if (fleet.enginePosition(riderId, probe.from) === null) return;
    probe.dir.copy(destination.center).sub(probe.from);
    probe.span = probe.dir.length();
    if (probe.span < 1) return;
    probe.dir.multiplyScalar(1 / probe.span);
    probe.t = 0;
    probe.hold = -1;
    probe.active = true;
    probe.head.visible = true;
    probe.trail.object.visible = true;
    probe.trail.material.uniforms.uOpacity!.value = 1.0;
  }

  private layoutProbe(probe: Probe, camera: THREE.PerspectiveCamera): void {
    const eased = easeOutCubic(probe.t);
    const travel = probe.span * eased;
    const lift = Math.sin(Math.PI * probe.t) * probe.span * 0.03;
    this.scratch.copy(probe.from).addScaledVector(probe.dir, travel);
    this.scratch.y += lift;
    probe.headPos.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);
    probe.headPos.needsUpdate = true;
    probe.mat.uniforms.uOpacity!.value = 0.95 * (1 - probe.t * 0.3);
    probe.mat.uniforms.uSize!.value = PROBE_HEAD_PX * this.viewScale;

    // Trail: the head's wake, tapering toward the ship and fading out.
    const steps = PROBE_TRAIL_POINTS - 1;
    for (let i = 0; i <= steps; i++) {
      const t = Math.max(0, eased - (1 - i / steps) * PROBE_TRAIL_FRACTION * eased);
      probe.path[i * 3] = probe.from.x + probe.dir.x * probe.span * t;
      probe.path[i * 3 + 1] = probe.from.y + probe.dir.y * probe.span * t + Math.sin(Math.PI * t) * probe.span * 0.03;
      probe.path[i * 3 + 2] = probe.from.z + probe.dir.z * probe.span * t;
      // Constant screen width: world half-width scales with depth.
      const depth = Math.max(1, camera.position.distanceTo(this.scratchB.set(probe.path[i * 3]!, probe.path[i * 3 + 1]!, probe.path[i * 3 + 2]!)));
      probe.halfWidths[i] = (PROBE_TRAIL_PX * 0.5 * this.viewScale * depth) / this.screenScale;
    }
    probe.trail.setPath(
      probe.path,
      probe.halfWidths,
      camera.position,
      this.colorA.set(0xffffff),
      null,
      0.15,
      1 - probe.t * 0.3,
    );
  }

  private fireBeacon(streakS: number, fleet: Fleet, route: Route, frame: GameFrame): void {
    const lead = frame.destination?.leadRiderId ?? frame.riders[0]?.riderId ?? null;
    if (lead === null || fleet.shipPosition(lead, this.scratchB) === null) return;
    // Beacon thresholds step 30/90/180/300… — map each to a route position.
    const fraction = clamp01(((streakS % 300) + 30) / 330);
    route.pointAt(fraction, this.scratch);
    const attr = this.beacon.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);
    attr.needsUpdate = true;
    this.beaconLife = 0;
  }

  private updateTether(frame: GameFrame, camera: THREE.PerspectiveCamera, fleet: Fleet): void {
    const riding = frame.riders.filter((r) => r.state === 'riding');
    if (!frame.syncLit || riding.length < 2) {
      this.tether.object.visible = false;
      return;
    }
    const a = riding[0]!;
    const b = riding[1]!;
    if (fleet.shipPosition(a.riderId, this.scratch) === null) return;
    if (fleet.shipPosition(b.riderId, this.scratchC) === null) return;
    this.colorA.set(identityColor(frame.riders.indexOf(a)));
    this.colorB.set(identityColor(frame.riders.indexOf(b)));
    const steps = TETHER_POINTS - 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const o = i * 3;
      this.tetherPath[o] = this.scratch.x + (this.scratchC.x - this.scratch.x) * t;
      this.tetherPath[o + 1] = this.scratch.y + (this.scratchC.y - this.scratch.y) * t + Math.sin(Math.PI * t) * -0.6;
      this.tetherPath[o + 2] = this.scratch.z + (this.scratchC.z - this.scratch.z) * t;
      const depth = Math.max(1, camera.position.distanceTo(this.scratchB.set(this.tetherPath[o]!, this.tetherPath[o + 1]!, this.tetherPath[o + 2]!)));
      this.tetherWidths[i] = (TETHER_PX * 0.5 * this.viewScale * depth) / this.screenScale;
    }
    this.tether.setPath(this.tetherPath, this.tetherWidths, camera.position, this.colorA, this.colorB, 0.95, 0.95);
    this.tether.material.uniforms.uOpacity!.value = 0.75 + 0.25 * Math.sin(this.elapsedS * 2.2);
    this.tether.object.visible = true;
  }

  private updateShield(frame: GameFrame, dtS: number, fleet: Fleet): void {
    const rescue = frame.rescue;
    if (rescue === null) {
      this.shield.visible = false;
      this.shieldLife = -1;
      this.shieldRider = null;
      return;
    }
    if (fleet.shipPosition(rescue.riderId, this.scratch) === null) {
      this.shield.visible = false;
      return;
    }
    if (this.shieldRider !== rescue.riderId) {
      this.shieldRider = rescue.riderId;
      this.shieldLife = 0;
      (this.shieldMat.uniforms.uColor!.value as THREE.Color).set(rescue.hue);
    }
    this.shieldLife = Math.max(0, this.shieldLife) + dtS;
    const rise = clamp01(this.shieldLife / 0.45);
    this.shield.position.copy(this.scratch);
    this.shield.scale.setScalar(SHIELD_RADIUS * (0.7 + 0.3 * easeOutCubic(rise)));
    this.shield.visible = true;
    this.shieldMat.uniforms.uOpacity!.value = 0.5 * easeOutCubic(rise);
    this.shieldMat.uniforms.uTime!.value = this.elapsedS;
  }

  dispose(): void {
    for (const probe of this.probes) {
      probe.head.geometry.dispose();
      probe.mat.dispose();
      probe.trail.dispose();
    }
    this.flash.geometry.dispose();
    this.beacon.geometry.dispose();
    this.flashMat.dispose();
    this.beaconMat.dispose();
    this.tether.dispose();
    this.sphere.dispose();
    this.shieldMat.dispose();
    this.group.clear();
  }
}
