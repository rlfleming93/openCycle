import type { LegKind } from '@opencycle/shared';
import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { Anchor } from './anchor.js';
import { CameraRig } from './cameraRig.js';
import { Engines } from './engines.js';
import { Destination } from './planets.js';
import { Field } from './field.js';
import { Flybys } from './flybys.js';
import { Fleet } from './fleet.js';
import type { Attitude } from './flight.js';
import { Fsd } from './fsd.js';
import { Fx } from './fx.js';
import type { LensState } from './post.js';
import { Raiders } from './raiders.js';
import { Route } from './route.js';
import { Sky } from './sky.js';
import { Sparks } from './sparks.js';

/** Per-frame environment the renderer owns (degradation + internal size). */
export interface WorldEnv {
  /** Degradation rung 0..5. */
  rung: number;
  /** Internal drawing-buffer height in device px. */
  viewportH: number;
}

export interface DestinationScreen {
  /** CSS pixels from the container's top-left. */
  x: number;
  y: number;
  visible: boolean;
  /** Projected destination disc radius in CSS px (0 when not visible). */
  r: number;
}

const projection = new THREE.Vector3();

/**
 * The whole world behind the canvas: the anchor and deep sky, destination
 * system, fleet, streaming field, route and effects, plus the ownship camera
 * rig. One `update` per rendered frame; the renderer owns the GL renderer and
 * the post chain, which reads `lens`.
 */
export class GameWorld {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Per-frame lens requests for the post chain. */
  readonly lens: LensState = { supercruise: 0 };
  private readonly anchor = new Anchor();
  private readonly sky = new Sky(this.anchor);
  private readonly destination = new Destination();
  private readonly engines = new Engines();
  private readonly sparks = new Sparks();
  private readonly fleet = new Fleet(this.engines, this.sparks);
  private readonly field = new Field();
  private readonly flybys = new Flybys();
  private readonly route = new Route();
  private readonly fx = new Fx();
  private readonly raiders = new Raiders(this.engines, this.sparks);
  private readonly fsd = new Fsd();
  private readonly rig = new CameraRig();
  private readonly lead = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly attitude: Attitude = { yaw: 0, pitch: 0, roll: 0 };
  /** Previous frame's leg kind (undefined before the first frame): a new burn boosts. */
  private lastLegKind: LegKind | null | undefined = undefined;
  private renderer: THREE.WebGLRenderer | null = null;
  private rung = 0;
  private hasDestination = false;

  constructor() {
    // Far plane clears the destination system (2,600) with room to spare; the
    // sky and anchor sit at infinity in their own pass. Near stays tight enough
    // for hull-scale depth precision.
    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 20000);
    this.camera.position.set(16, 9, 62);
    this.scene.add(
      this.sky.group,
      this.destination.group,
      this.flybys.group,
      this.fleet.group,
      this.field.group,
      this.route.object,
      this.fx.group,
      this.raiders.group,
      this.engines.group,
      this.sparks.object,
      this.fsd.group,
    );
  }

  /**
   * Bring the world up: compile what exists, load the fleet GLBs, compile
   * again so the first rendered frame never pays a shader compile.
   */
  async attach(renderer: THREE.WebGLRenderer): Promise<boolean> {
    this.renderer = renderer;
    renderer.compile(this.scene, this.camera);
    const loaded = await this.fleet.load();
    await this.raiders.load();
    renderer.compile(this.scene, this.camera);
    return loaded;
  }

  update(frame: GameFrame, nowMs: number, dtS: number, env: WorldEnv): void {
    const seed = frame.destination?.seed ?? frame.seed;
    this.anchor.setSeed(seed);
    this.sky.setSeed(seed);
    this.destination.setSeed(seed);
    this.flybys.setSeed(seed);
    const lighting = this.anchor.lighting;
    this.destination.setLighting(lighting);
    this.field.setLighting(lighting, this.anchor.coreRadius);
    this.flybys.setLighting(lighting, this.anchor.coreRadius);
    this.sky.setViewport(env.viewportH, this.camera.aspect);
    // Effect sizes are authored in 1080p pixels; these two keep them stable
    // across the internal-resolution rungs and the live FOV.
    this.fx.setViewportScale(env.viewportH / 1080);
    const screenScale = env.viewportH / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    this.fx.setScreenScale(screenScale);

    if (env.rung !== this.rung) {
      this.rung = env.rung;
      this.sky.setRung(env.rung);
      this.field.setRung(env.rung);
      this.sparks.setRung(env.rung);
    }

    this.hasDestination = frame.destination !== null;
    this.destination.group.visible = this.hasDestination;

    for (const event of frame.events) {
      if (event.kind !== 'legComplete') continue;
      if (!event.clean) continue;
      // Every clean survey rolls that rider's ship; burns hand the payoff to
      // the raider instead of the survey probe.
      this.fleet.pulse(event.riderId, nowMs);
      this.fleet.rollPulse(event.riderId, nowMs);
    }
    // A new burn opens with a boost: engine flares and nozzle rings, the
    // camera's FOV kick and a burst of speed dust.
    if (frame.legKind === 'burn' && this.lastLegKind !== undefined && this.lastLegKind !== 'burn') {
      this.fleet.boost(nowMs);
      this.rig.boost(nowMs);
      this.field.boost(nowMs);
    }
    this.lastLegKind = frame.legKind;
    // Frame shift drive: the session-start jump hides the system until its
    // exit flash; cruise, climb and coast legs fly in supercruise.
    this.fsd.update(frame, nowMs, dtS, this.fleet.ready, this.rig.arrivalT > 0, this.camera);
    this.fleet.setJump(this.fsd.charge, this.fsd.tunnel);
    this.sky.setReveal(this.fsd.reveal);
    this.destination.setReveal(this.fsd.reveal);
    this.flybys.setReveal(this.fsd.reveal);
    this.field.setReveal(this.fsd.reveal);
    this.lens.supercruise = this.fsd.supercruise;

    this.engines.begin();
    this.fleet.cameraPosition.copy(this.camera.position);
    // Last frame's camera, reticle and raider: the fleet parts its hulls on
    // screen, keeps the wingmen off the raider's reticle and swings the
    // in-band ships' guns onto the raider.
    this.fleet.update(frame, nowMs, dtS, lighting, env.rung, this.camera, this.raiders.reticleScreen, this.raiders.gunTarget);

    // The route runs from the lead ship; the camera follows the fleet centre so
    // the ships' own weave reads against the sky.
    const leadId = frame.destination?.leadRiderId ?? frame.riders[0]?.riderId ?? null;
    const leadPosition = leadId === null ? null : this.fleet.shipPosition(leadId, this.lead);
    const fleetCenter = this.fleet.fleetCenter(this.center);

    // Camera first: the destination's apparent size is measured from it. The
    // arrival drops out of supercruise with a flash and a shock ring.
    const arriving = this.rig.arrivalT === 0 && frame.events.some((e) => e.kind === 'arrival');
    this.rig.update(
      frame,
      nowMs,
      dtS,
      this.camera,
      fleetCenter,
      this.fleet.fleetAttitude(this.attitude),
      this.fleet.bounds,
      this.hasDestination ? this.destination.center : null,
      this.destination.radius(),
      this.fsd.jump,
      this.fsd.fovAdd,
    );
    if (arriving) this.fsd.drop(nowMs, fleetCenter ?? this.lead);
    this.destination.update({
      progress: frame.progress,
      revealed: frame.surveys.revealed,
      total: frame.surveys.total,
      arrivalT: this.rig.arrivalT,
      rung: env.rung,
      dtS,
      camera: this.camera,
      viewportH: env.viewportH,
    });
    this.anchor.update(dtS);
    if (this.renderer !== null) this.sky.bake(this.renderer, dtS);
    this.field.group.visible = this.fsd.tunnel <= 0;
    this.field.update(
      frame,
      nowMs,
      dtS,
      this.camera,
      this.fleet.bounds,
      this.rig.setup === 'chase',
      this.rig.orbiting,
      this.rig.cut,
      this.hasDestination ? this.destination.center : null,
      this.destination.radius(),
      env.viewportH,
    );
    // Passing bodies drift on the same travel, so their parallax matches the rocks.
    this.flybys.update(
      this.field.travel,
      dtS,
      this.camera,
      frame.progress,
      this.rig.arrivalT,
      env.rung,
      this.hasDestination ? this.destination.center : null,
      this.destination.radius(),
    );

    // The route is a cruise instrument: hidden until the jump reveals the
    // system, and once arrival starts the planet is the subject.
    const arrivalStarted = this.rig.arrivalT > 0;
    this.route.update(
      this.hasDestination && !arrivalStarted && this.fsd.reveal >= 1 ? leadPosition : null,
      this.destination.center,
      this.destination.radius(),
    );
    this.fx.update(frame, dtS, this.camera, this.fleet, this.destination, this.route);

    // Pursuit: resolve the encounter BEFORE the raider's update so the kill or
    // escape starts on the frame the burn ends. A kill lights the fleet from
    // the wreck and kicks the camera; the raider fires on its own update.
    for (const event of frame.events) {
      if (event.kind !== 'raider') continue;
      if (this.raiders.resolve(event.outcome, nowMs)) {
        this.fleet.flash(this.raiders.position, nowMs);
        this.rig.kill(nowMs);
      }
    }
    this.raiders.update(
      frame,
      nowMs,
      dtS,
      this.fleet,
      lighting,
      this.camera,
      this.hasDestination ? this.destination.center : null,
      this.destination.radius(),
    );
    this.engines.end(nowMs * 0.001, screenScale);
    this.sparks.update(dtS, screenScale);
  }

  /**
   * Destination marker position in CSS pixels, or null without a destination.
   * `r` is the projected disc radius so the HUD ring can enclose the planet.
   */
  destinationScreen(): DestinationScreen | null {
    // From arrival onward the marker yields to the arrival card and the orbit;
    // before the jump's exit flash there is no system to mark.
    if (!this.hasDestination || this.renderer === null || this.rig.arrivalT > 0 || this.fsd.reveal < 1) return null;
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return null;
    projection.copy(this.destination.center).project(this.camera);
    const visible = projection.z < 1 && Math.abs(projection.x) <= 1 && Math.abs(projection.y) <= 1;
    const distance = Math.max(1, this.camera.position.distanceTo(this.destination.center));
    const screenScale = height / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    return {
      x: (projection.x * 0.5 + 0.5) * width,
      y: (-projection.y * 0.5 + 0.5) * height,
      visible,
      r: visible ? (this.destination.radius() / distance) * screenScale : 0,
    };
  }

  dispose(): void {
    this.sky.dispose();
    this.destination.dispose();
    this.fleet.dispose();
    this.field.dispose();
    this.flybys.dispose();
    this.route.dispose();
    this.fx.dispose();
    this.raiders.dispose();
    this.engines.dispose();
    this.sparks.dispose();
    this.fsd.dispose();
    this.scene.clear();
  }
}
