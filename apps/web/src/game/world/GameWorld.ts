import * as THREE from 'three';

import type { GameFrame } from '../director.js';
import { CameraRig } from './cameraRig.js';
import { Destination } from './planets.js';
import { Field } from './field.js';
import { Fleet } from './fleet.js';
import { Fx } from './fx.js';
import { Route } from './route.js';
import { Sky } from './sky.js';

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
 * The whole world behind the canvas: sky, destination system, fleet, streaming
 * field, route and effects, plus the ownship camera rig. One `update` per
 * rendered frame; the renderer owns the GL renderer and the post chain.
 */
export class GameWorld {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly sky = new Sky();
  private readonly destination = new Destination();
  private readonly fleet = new Fleet();
  private readonly field = new Field();
  private readonly route = new Route();
  private readonly fx = new Fx();
  private readonly rig = new CameraRig();
  private readonly lead = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer | null = null;
  private rung = 0;
  private hasDestination = false;

  constructor() {
    // Far plane clears the sky shell (9,000) and the horizon giant with room
    // to spare; near stays tight enough for hull-scale depth precision.
    this.camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.5, 20000);
    this.camera.position.set(16, 9, 62);
    this.scene.add(
      this.sky.group,
      this.destination.group,
      this.destination.horizonGiant,
      this.fleet.group,
      this.field.group,
      this.route.object,
      this.fx.group,
    );
  }

  /**
   * Bring the world up: compile what exists, load the fleet GLBs, compile
   * again so the first rendered frame never pays a shader compile.
   */
  async attach(renderer: THREE.WebGLRenderer): Promise<boolean> {
    this.renderer = renderer;
    this.sky.setPixelRatio(renderer.getPixelRatio());
    renderer.compile(this.scene, this.camera);
    const loaded = await this.fleet.load();
    renderer.compile(this.scene, this.camera);
    return loaded;
  }

  setPixelRatio(ratio: number): void {
    this.sky.setPixelRatio(ratio);
  }

  update(frame: GameFrame, nowMs: number, dtS: number, env: WorldEnv): void {
    const seed = frame.destination?.seed ?? frame.seed;
    this.sky.setSeed(seed);
    this.destination.setSeed(seed);
    const lighting = this.sky.lighting;
    this.destination.setLighting(lighting);
    this.field.setLighting(lighting);
    // Effect sizes are authored in 1080p pixels; these two keep them stable
    // across the internal-resolution rungs and the live FOV.
    this.fx.setViewportScale(env.viewportH / 1080);
    const screenScale = env.viewportH / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    this.fleet.setScreenScale(screenScale);
    this.fx.setScreenScale(screenScale);

    if (env.rung !== this.rung) {
      this.rung = env.rung;
      this.sky.setRung(env.rung);
      this.field.setRung(env.rung);
    }

    this.hasDestination = frame.destination !== null;
    this.destination.group.visible = this.hasDestination;

    for (const event of frame.events) {
      if (event.kind === 'legComplete' && event.clean) this.fleet.pulse(event.riderId, nowMs);
    }
    this.fleet.update(frame, nowMs, dtS, lighting, env.rung);

    // The rig anchors on the fleet lead, so resolve it before moving the
    // camera; the route reuses the same position.
    const leadId = frame.destination?.leadRiderId ?? frame.riders[0]?.riderId ?? null;
    const leadPosition = leadId === null ? null : this.fleet.shipPosition(leadId, this.lead);

    // Camera first: the destination's apparent size is measured from it.
    this.rig.update(
      frame,
      nowMs,
      dtS,
      this.camera,
      leadPosition,
      this.hasDestination ? this.destination.center : null,
    );
    this.destination.update({
      progress: frame.progress,
      revealed: frame.surveys.revealed,
      total: frame.surveys.total,
      arrivalT: this.rig.arrivalT,
      rung: env.rung,
      dtS,
      camera: this.camera,
    });
    this.sky.update(dtS);
    this.field.update(frame, dtS, this.camera, frame.legKind, this.rig.orbiting);

    // The route is a cruise instrument: once arrival starts the planet is the
    // subject and the dashed line would cut across it.
    const arrivalStarted = this.rig.arrivalT > 0;
    this.route.update(
      this.hasDestination && !arrivalStarted ? leadPosition : null,
      this.destination.center,
      this.destination.radius(),
    );
    this.fx.update(frame, dtS, this.camera, this.fleet, this.destination, this.route);
  }

  /**
   * Destination marker position in CSS pixels, or null without a destination.
   * `r` is the projected disc radius so the HUD ring can enclose the planet.
   */
  destinationScreen(): DestinationScreen | null {
    // From arrival onward the marker yields to the arrival card and the orbit.
    if (!this.hasDestination || this.renderer === null || this.rig.arrivalT > 0) return null;
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return null;
    projection.copy(this.destination.center).project(this.camera);
    const visible = projection.z < 1 && Math.abs(projection.x) < 1.15 && Math.abs(projection.y) < 1.15;
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
    this.route.dispose();
    this.fx.dispose();
    this.scene.clear();
  }
}
