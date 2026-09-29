import * as THREE from 'three';

import { radians } from './math.js';

/**
 * The shot: one source of truth for where the fleet, the destination system and
 * the celestial anchor sit relative to the chase camera. cameraRig.ts,
 * planets.ts and anchor.ts all read it, so the composition cannot drift apart.
 *
 * Solved geometry (1920x1080, 42 deg vertical FOV):
 *  - fleet lead: 24 units from the camera at 20 deg azimuth (camera to port)
 *    and 13.5 deg above the fleet plane, so the lead projects to ~24% of the
 *    viewport width with its top surface and both wings showing;
 *  - the destination lands on CRUISE_DEST_SCREEN while cruising and walks to
 *    ARRIVAL_DEST_SCREEN as the arrival push runs, so a growing disc never
 *    slides under the route strip.
 */
export const RIG_DISTANCE = 24;
export const RIG_AZIMUTH_RAD = radians(20);
export const RIG_ELEVATION_RAD = radians(13.5);
/** Where the fleet lead must land on screen. */
export const LEAD_SCREEN = { x: 0.42, y: 0.62 } as const;
/** Destination marks: cruise keeps it clear of the horizon HUD; arrival centres it. */
export const CRUISE_DEST_SCREEN = { x: 0.62, y: 0.33 } as const;
export const ARRIVAL_DEST_SCREEN = { x: 0.56, y: 0.42 } as const;
/** Destination distance is fixed; the disc is scaled to the progress curve. */
export const PLANET_DISTANCE = 2600;
/**
 * Anchor core mark in the chase shot: upper right, below the route strip and
 * right of the destination, so its disk or halo may crop at the frame edge and
 * at arrival the swollen planet sits in front of it.
 */
export const ANCHOR_SCREEN = { x: 0.8, y: 0.27 } as const;

/** Nominal FOV the shot was solved at (weather moves it by at most 3 deg). */
export const NOMINAL_FOV_Y_RAD = radians(42);
export const NOMINAL_ASPECT = 16 / 9;

export function nominalFovX(): number {
  return 2 * Math.atan(Math.tan(NOMINAL_FOV_Y_RAD / 2) * NOMINAL_ASPECT);
}

/**
 * Camera position relative to its anchor (-X port, +Y up, +Z aft).
 * Defaults are the default chase pose; the rig passes its setup's pose.
 */
export function rigOffset(
  out: THREE.Vector3,
  azimuth = RIG_AZIMUTH_RAD,
  elevation = RIG_ELEVATION_RAD,
  distance = RIG_DISTANCE,
): THREE.Vector3 {
  const horizontal = distance * Math.cos(elevation);
  return out.set(
    -horizontal * Math.sin(azimuth),
    distance * Math.sin(elevation),
    horizontal * Math.cos(azimuth),
  );
}

/**
 * The destination's world direction, derived from the shot above: the ship art
 * is solved first, and the system moves to wherever that puts the camera axis.
 * `LEAD_SCREEN` and `CRUISE_DEST_SCREEN` differ horizontally by
 * (fx - LEAD.x) * fovX, so the system sits that far to starboard of the
 * camera's tail axis; vertically the camera's 13.5 deg elevation plus the
 * screen difference sets the system's elevation.
 */
export const PLANET_DIR = (() => {
  const yaw = RIG_AZIMUTH_RAD + (CRUISE_DEST_SCREEN.x - LEAD_SCREEN.x) * nominalFovX();
  const height = RIG_DISTANCE * Math.sin(RIG_ELEVATION_RAD);
  // Pitch of the system as seen from the camera, then converted to world.
  const pitchFromCamera =
    -RIG_ELEVATION_RAD + (LEAD_SCREEN.y - CRUISE_DEST_SCREEN.y) * NOMINAL_FOV_Y_RAD;
  const y = height + PLANET_DISTANCE * Math.tan(pitchFromCamera);
  const pitch = Math.atan2(y, PLANET_DISTANCE);
  return new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
})();

/** Base camera position for a fleet lead at `anchor` (no arrival push). */
export function baseCameraPosition(anchor: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  rigOffset(out);
  return out.add(anchor);
}

/** World yaw of the camera axis that puts the destination on `fx`. */
export function axisYaw(planetYaw: number, fovX: number, fx: number): number {
  return planetYaw - (fx - 0.5) * fovX;
}

/** World pitch of the camera axis that puts the destination on `fy`. */
export function axisPitch(planetPitch: number, fovY: number, fy: number): number {
  return planetPitch - (0.5 - fy) * fovY;
}

/**
 * The cruise-pose camera axis direction (world). Sky/giant decorations use it
 * to place themselves relative to what the frame actually shows.
 */
export function nominalAxisDirection(out: THREE.Vector3): THREE.Vector3 {
  const base = baseCameraPosition(new THREE.Vector3(), new THREE.Vector3());
  const toPlanet = PLANET_DIR.clone().multiplyScalar(PLANET_DISTANCE).sub(base).normalize();
  const right = new THREE.Vector3().crossVectors(toPlanet, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, toPlanet).normalize();
  const fovX = nominalFovX();
  return out
    .copy(toPlanet)
    .addScaledVector(right, -(2 * CRUISE_DEST_SCREEN.x - 1) * Math.tan(fovX / 2))
    .addScaledVector(up, -(1 - 2 * CRUISE_DEST_SCREEN.y) * Math.tan(NOMINAL_FOV_Y_RAD / 2))
    .normalize();
}

/** World direction that lands on screen point (x, y) in the nominal chase pose. */
export function chaseDirection(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  const axis = nominalAxisDirection(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(axis, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, axis).normalize();
  return out
    .copy(axis)
    .addScaledVector(right, (2 * x - 1) * Math.tan(nominalFovX() / 2))
    .addScaledVector(up, (1 - 2 * y) * Math.tan(NOMINAL_FOV_Y_RAD / 2))
    .normalize();
}

export const UP = new THREE.Vector3(0, 1, 0);
