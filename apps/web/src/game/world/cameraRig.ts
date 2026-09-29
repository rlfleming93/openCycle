import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import {
  ARRIVAL_DEST_SCREEN,
  CRUISE_DEST_SCREEN,
  PLANET_DIR,
  RIG_DISTANCE,
  rigOffset,
} from './composition.js';
import { clamp, clamp01, easeInCubic, radians } from './math.js';

/**
 * Chase camera. The shot is anchored on the fleet lead (lower-left third, 3/4
 * rear view from above-left, ~24% of the viewport width) and aims from the
 * destination's world direction every frame, so the system stays on its
 * composition mark as the weather FOV breathes.
 *
 * Arrival: a 6 s push-in and slow orbit, and the destination mark walks from
 * CRUISE_DEST_SCREEN to ARRIVAL_DEST_SCREEN so the swelling disc stays fully
 * inside the frame (clear of the route strip) instead of being clipped by it.
 */
const ARRIVAL_PUSH_S = 6;
/** No dolly: the planet swells by scale, so the fleet keeps its frame and never
 *  drifts under the rider cards (measured bbox stays inside 30-72% x, 55-90% y). */
const PUSH_DISTANCE = 0;
const PUSH_RISE = 0;
const ORBIT_SWING_RAD = 0.05;
const ORBIT_RATE = 0.12;
/** Slow drift, never shake. */
const DRIFT_POS = 0.3;
const DRIFT_ROLL_RAD = 0.006;
/** Camera axis smoothing: enough to hide the per-frame FOV/mark jitter. */
const AXIS_TAU_S = 0.18;

export class CameraRig {
  /** 0..1 across the 6 s arrival push-in; stays 1 during the orbit hold. */
  arrivalT = 0;
  /** True once the push-in has finished (the field drops to a slow drift). */
  orbiting = false;
  private arrivalMs = -1;
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly pos = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly smoothedDir = new THREE.Vector3();
  private hasDir = false;

  update(
    frame: GameFrame,
    nowMs: number,
    dtS: number,
    camera: THREE.PerspectiveCamera,
    anchor: THREE.Vector3 | null,
    destinationCenter: THREE.Vector3 | null,
  ): void {
    if (this.arrivalMs < 0 && frame.events.some((e) => e.kind === 'arrival')) this.arrivalMs = nowMs;
    const t = this.arrivalMs < 0 ? 0 : clamp01((nowMs - this.arrivalMs) / (ARRIVAL_PUSH_S * 1000));
    this.arrivalT = t;
    this.orbiting = this.arrivalMs >= 0 && t >= 1;
    const push = easeInCubic(t);
    const sinceArrivalS = this.arrivalMs < 0 ? 0 : (nowMs - this.arrivalMs) / 1000;
    const orbitSwing = this.arrivalMs < 0 ? 0 : Math.sin(sinceArrivalS * ORBIT_RATE) * ORBIT_SWING_RAD;

    // Anchor on the fleet lead so the formation keeps its frame whatever slot
    // the lead rider flies; the push-in dollies forward from there.
    rigOffset(this.pos);
    if (anchor !== null) this.pos.add(anchor);
    this.pos.x += Math.sin(nowMs * 0.00021) * DRIFT_POS;
    this.pos.y += Math.cos(nowMs * 0.00017) * DRIFT_POS * 0.6 + push * PUSH_RISE;
    this.pos.z -= push * PUSH_DISTANCE;

    camera.fov = (42 + clamp(frame.weather, 0, 1.5) * 2) * (1 - 0.02 * push);
    camera.position.copy(this.pos);
    camera.up.set(0, 1, 0);

    // Destination mark: cruise -> arrival, eased with the push.
    const fx = CRUISE_DEST_SCREEN.x + (ARRIVAL_DEST_SCREEN.x - CRUISE_DEST_SCREEN.x) * push;
    const fy = CRUISE_DEST_SCREEN.y + (ARRIVAL_DEST_SCREEN.y - CRUISE_DEST_SCREEN.y) * push;

    const fovY = radians(camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect);
    const offX = (2 * fx - 1) * Math.tan(fovX / 2);
    const offY = (1 - 2 * fy) * Math.tan(fovY / 2);
    if (destinationCenter !== null) {
      this.dir.copy(destinationCenter).sub(this.pos).normalize();
    } else {
      // Open space: aim the same way using the nominal system direction, so the
      // fleet keeps the lower-left frame with no destination at all.
      this.dir.copy(PLANET_DIR);
    }
    // Exact pinhole framing: a point at NDC (nx, ny) sits at the view-space
    // direction (nx·tan hx, ny·tan hy, −1), so aiming means backing the camera
    // axis off the target direction by exactly that offset.
    this.right.crossVectors(this.dir, this.up).normalize();
    this.camUp.crossVectors(this.right, this.dir).normalize();
    this.dir.addScaledVector(this.right, -offX).addScaledVector(this.camUp, -offY).normalize();
    if (orbitSwing !== 0) this.dir.applyAxisAngle(this.up, orbitSwing);

    // Smooth the axis: the arrival mark lerp and the weather FOV would
    // otherwise couple tiny steps into visible jitter.
    if (!this.hasDir) {
      this.smoothedDir.copy(this.dir);
      this.hasDir = true;
    } else {
      const k = dtS <= 0 ? 1 : 1 - Math.exp(-dtS / AXIS_TAU_S);
      this.smoothedDir.lerp(this.dir, k).normalize();
    }
    this.target.copy(this.pos).addScaledVector(this.smoothedDir, RIG_DISTANCE * 5);

    camera.lookAt(this.target);
    camera.rotateZ(Math.sin(nowMs * 0.00013) * DRIFT_ROLL_RAD + push * 0.012);
    camera.updateProjectionMatrix();
  }
}
