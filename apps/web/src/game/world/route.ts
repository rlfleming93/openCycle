import * as THREE from 'three';

import { clamp01 } from './math.js';

const POINTS = 48;
/** Dash + gap in world units along the curve. */
const DASH = 9;
const GAP = 7;
/** Curve lift as a fraction of the span, so the route arcs over the fleet. */
const LIFT = 0.05;
/** Stop short of the planet by this many world units. */
const STANDOFF = 30;

/**
 * The voyage route: a dashed amber line from the fleet lead to the
 * destination's limb, along a gently lifted quadratic curve. Hidden whenever
 * the session has no destination (free ride = open space).
 */
export class Route {
  readonly object: THREE.Line;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.LineDashedMaterial;
  private readonly positions: Float32Array;
  private readonly control = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly at = new THREE.Vector3();

  constructor() {
    this.positions = new Float32Array(POINTS * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mat = new THREE.LineDashedMaterial({
      color: 0xffc38a,
      dashSize: DASH,
      gapSize: GAP,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.object = new THREE.Line(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /**
   * Rebuild the curve. `from` is the fleet lead, `center`/`radius` describe the
   * destination planet; null hides the route.
   */
  update(from: THREE.Vector3 | null, center: THREE.Vector3, radius: number): void {
    if (from === null) {
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.dir.copy(center).sub(from);
    const span = this.dir.length();
    if (span < 1) {
      this.object.visible = false;
      return;
    }
    this.dir.multiplyScalar(1 / span);
    this.at.copy(center).addScaledVector(this.dir, -(radius + STANDOFF));
    this.control.copy(from).add(this.at).multiplyScalar(0.5);
    this.control.y += span * LIFT;

    for (let i = 0; i < POINTS; i++) {
      const t = i / (POINTS - 1);
      const u = 1 - t;
      const x = u * u * from.x + 2 * u * t * this.control.x + t * t * this.at.x;
      const y = u * u * from.y + 2 * u * t * this.control.y + t * t * this.at.y;
      const z = u * u * from.z + 2 * u * t * this.control.z + t * t * this.at.z;
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
    }
    this.geo.getAttribute('position').needsUpdate = true;
    this.object.computeLineDistances();
  }

  /** A point along the route at fraction t (beacon flares). */
  pointAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const clamped = clamp01(t);
    const i = clamped * (POINTS - 1);
    const a = Math.min(Math.floor(i), POINTS - 2);
    const f = i - a;
    return out.set(
      this.positions[a * 3]! + (this.positions[(a + 1) * 3]! - this.positions[a * 3]!) * f,
      this.positions[a * 3 + 1]! + (this.positions[(a + 1) * 3 + 1]! - this.positions[a * 3 + 1]!) * f,
      this.positions[a * 3 + 2]! + (this.positions[(a + 1) * 3 + 2]! - this.positions[a * 3 + 2]!) * f,
    );
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
