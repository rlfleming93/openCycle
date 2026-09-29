import * as THREE from 'three';

import { radians } from './math.js';

export const UP = new THREE.Vector3(0, 1, 0);

/**
 * The fleet's travel direction (world). The fleet, the raider and the hull art
 * all fly the world frame with the nose on -Z, so this stays -Z: formation,
 * weave and every resting nose run along it, and the streaks, dust, rocks and
 * scenery flow away from its vanishing point.
 */
export const TRAVEL_DIR = new THREE.Vector3(0, 0, -1);

/**
 * HUD keep-outs in screen fractions from the top-left: the route strip across
 * the top, the workout sidebar down the left, and the rider cards: bottom left
 * and right for one or two riders, one full-width row for three or more.
 * Hulls, the raider and its reticle, the destination and the anchor core stay
 * out of all of them.
 */
export const KEEP_OUT = {
  /** Route strip: y < top. */
  top: 0.16,
  /** Workout sidebar: x < sideRight while sideTop < y < sideBottom. */
  sideRight: 0.2,
  sideTop: 0.14,
  sideBottom: 0.57,
  /** One or two riders: cards where y > cards and x < cardsLeft or x > cardsRight. */
  cards: 0.57,
  cardsLeft: 0.25,
  cardsRight: 0.75,
  /** Three or more riders: one card row across the frame below this line (its top measures 0.625-0.66 at 16:9). */
  cardRow: 0.62,
} as const;

/** Rider count from which the cards form one full-width row. */
export const CARD_ROW_RIDERS = 3;

/**
 * The chase shot: one source of truth for where the travel vanishing point, the
 * fleet, the destination system and the celestial anchor sit on screen.
 * cameraRig.ts, planets.ts, anchor.ts and sky.ts all read it, so the
 * composition cannot drift apart.
 *
 * Solved at 1920x1080 and a 42 deg vertical FOV: the camera rides behind and
 * above the fleet, CHASE_DISTANCE from its centre on CHASE_FLEET_SCREEN, so the
 * hulls point up the frame into the scene at TRAVEL_SCREEN, where the field
 * streams from. The destination sits just past that vanishing point, up and to
 * the right of the raider's lane, and walks to ARRIVAL_DEST_SCREEN as the
 * arrival push runs, so a growing disc never slides under the route strip.
 */
export const TRAVEL_SCREEN = { x: 0.54, y: 0.34 } as const;
export const CHASE_FLEET_SCREEN = { x: 0.47, y: 0.62 } as const;
export const CHASE_DISTANCE = 34;
export const CRUISE_DEST_SCREEN = { x: 0.63, y: 0.29 } as const;
export const ARRIVAL_DEST_SCREEN = { x: 0.56, y: 0.42 } as const;
/** Destination distance is fixed; the disc is scaled to the progress curve. */
export const PLANET_DISTANCE = 2600;
/**
 * Anchor core mark in the chase shot: upper right, below the route strip and
 * right of the destination, so its disk or halo may crop at the frame edge and
 * at arrival the swollen planet sits in front of it.
 */
export const ANCHOR_SCREEN = { x: 0.8, y: 0.27 } as const;

/** Nominal frame the shot was solved at: 42 deg vertical FOV at 16:9 (weather moves the FOV by at most 3 deg). */
const TAN_Y = Math.tan(radians(42) / 2);
const TAN_X = TAN_Y * (16 / 9);

const right = new THREE.Vector3();
const up = new THREE.Vector3();

/**
 * Pinhole framing: the zero-roll camera axis that puts world direction `aim`
 * on screen point `mark` (a point at NDC (nx, ny) sits at the view-space
 * direction (nx·tanX, ny·tanY, −1), so back the axis off by that offset).
 */
export function axisFor(
  aim: THREE.Vector3,
  mark: { x: number; y: number },
  tanX: number,
  tanY: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  right.crossVectors(aim, UP).normalize();
  up.crossVectors(right, aim).normalize();
  return out
    .copy(aim)
    .addScaledVector(right, -(2 * mark.x - 1) * tanX)
    .addScaledVector(up, -(1 - 2 * mark.y) * tanY)
    .normalize();
}

/** The world direction a zero-roll camera on `axis` shows at screen point (x, y). */
export function screenDirection(
  axis: THREE.Vector3,
  x: number,
  y: number,
  tanX: number,
  tanY: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  right.crossVectors(axis, UP).normalize();
  up.crossVectors(right, axis).normalize();
  return out
    .copy(axis)
    .addScaledVector(right, (2 * x - 1) * tanX)
    .addScaledVector(up, (1 - 2 * y) * tanY)
    .normalize();
}

/** The nominal chase axis: TRAVEL_DIR on TRAVEL_SCREEN. */
const CHASE_AXIS = axisFor(TRAVEL_DIR, TRAVEL_SCREEN, TAN_X, TAN_Y, new THREE.Vector3());

/** World direction that lands on screen point (x, y) in the nominal chase pose. */
export function chaseDirection(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
  return screenDirection(CHASE_AXIS, x, y, TAN_X, TAN_Y, out);
}

/** The destination's world direction from the fleet: CRUISE_DEST_SCREEN in the chase pose. */
export const PLANET_DIR = chaseDirection(CRUISE_DEST_SCREEN.x, CRUISE_DEST_SCREEN.y, new THREE.Vector3());

/** Chase camera position for a fleet centred on `anchor` (no arrival push). */
export function baseCameraPosition(anchor: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return chaseDirection(CHASE_FLEET_SCREEN.x, CHASE_FLEET_SCREEN.y, out).multiplyScalar(-CHASE_DISTANCE).add(anchor);
}
