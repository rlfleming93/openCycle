import * as THREE from 'three';

import type { AppState } from '../store.js';
import { createGameDirector } from './director.js';
import type { GameDirector } from './director.js';
import { Post } from './world/post.js';
import { GameWorld } from './world/GameWorld.js';

// Frame loop: sample the director, hand the frame to the world, render through
// the post chain, publish the capture globals.

declare global {
  interface Window {
    /** Current degradation rung (0 = full quality) — read by perf traces. */
    __ocGameRung: number;
    /** Last frame scene draw calls (post chain excluded) — capture audit. */
    __ocDrawCalls: number;
    /** Rolling median frame time in ms over the last 300 frames. */
    __ocFrameMs: number;
  }
}

/** Internal render never exceeds 2560×1440; CSS upscales to 4K (spec §4). */
const MAX_INTERNAL_W = 2560;
const MAX_INTERNAL_H = 1440;
/** Degradation rung 3: internal 1080p. */
const RUNG3_W = 1920;
const RUNG3_H = 1080;
/** Spec §4: 5 s EMA of frame dt. */
const EMA_TAU_S = 5;
/** Enter the next rung when the EMA exceeds 20 ms (below 50 fps). */
const EMA_FLOOR_S = 0.02;
/** Rung-1 recover: EMA must stay under 14 ms. */
const EMA_RECOVER_S = 0.014;
/** Rung-1 recover hold: 10 s of good EMA before restoring the lens (bloom, streak, grain). */
const RECOVER_HOLD_S = 10;
/** After this many 1→0 recoveries the session sticks at rung ≥1. */
const MAX_RECOVERIES = 3;
/** Ignore compile/prewarm hitches for this long after start(). */
const GRACE_S = 5;
/** Rolling frame-time median window. */
const FRAME_WINDOW = 300;
const FRAME_MEDIAN_EVERY = 15;

export interface GameRendererHooks {
  /** Called once per frame with the destination marker position in CSS pixels
   *  relative to the container's top-left (visible=false when off-screen or
   *  when the session has no destination). `r` is the projected disc radius in
   *  CSS px, always 0 when not visible. */
  onDestinationScreen?: (point: { x: number; y: number; visible: boolean; r: number }) => void;
}

/**
 * Owns the WebGLRenderer, the director sample loop, the degradation ladder,
 * the world and the post chain.
 *
 * Disposal contract (everything the instance creates dies here):
 *  - RAF: canceled; the running flag stops the next scheduled callback.
 *  - ResizeObserver: disconnected.
 *  - GameWorld.dispose(): sky cube map + bake/sky/star passes, destination
 *    planet + features, fleet hulls/materials/textures, field streaks/dust/
 *    asteroids, route line, every pooled fx geometry/material.
 *  - Post.dispose(): HDR scene target, bloom mips, streak targets, pass materials.
 *  - renderer.dispose(): releases the GL context resources; the canvas is
 *    removed from the DOM.
 *  - window.__ocGameRung reset to 0.
 */
export class GameRenderer {
  private readonly container: HTMLElement;
  private readonly hooks: GameRendererHooks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: GameWorld;
  private readonly post: Post;
  private readonly director: GameDirector;
  private readonly ro: ResizeObserver;
  private readonly frameTimes = new Float32Array(FRAME_WINDOW);
  private raf = 0;
  private lastMs: number | null = null;
  private frameCount = 0;
  private frameCursor = 0;
  private emaDtS = 0;
  private rung = 0;
  private running = false;
  /** Seconds spent at rung 1 with EMA below the recover threshold. */
  private recoverHoldS = 0;
  /** Successful 1→0 recoveries this session (capped at MAX_RECOVERIES). */
  private recoveries = 0;
  /** Elapsed seconds since start(); grace ignores the first GRACE_S. */
  private aliveS = 0;
  /** Internal drawing-buffer height in device px (world size hints). */
  private internalH = 1440;

  constructor(container: HTMLElement, getState: () => AppState, hooks: GameRendererHooks = {}) {
    this.container = container;
    this.hooks = hooks;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // no MSAA (fill rate is the budget)
      powerPreference: 'high-performance',
    });
    // Tone mapping (AgX) and sRGB output happen in the post chain's composite.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 1);
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    this.world = new GameWorld();
    this.post = new Post(this.renderer, this.world.scene, this.world.camera);
    this.director = createGameDirector(getState);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    window.__ocGameRung = 0;
  }

  start(): void {
    if (this.running) return;
    this.resize();
    this.running = true;
    this.raf = requestAnimationFrame(this.loop);
    // Build the world, then prewarm: one compile for everything that exists
    // now, one more once the fleet GLBs are in the graph (inside attach).
    // A failed attach (no hulls, a lost context) leaves the HUD running.
    void this.world.attach(this.renderer).catch((err: unknown) => {
      console.warn('[renderer] world attach failed', err);
    });
  }

  private readonly loop = (nowMs: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dtS = this.lastMs === null ? 0 : Math.min((nowMs - this.lastMs) / 1000, 0.25);
    this.lastMs = nowMs;
    if (dtS > 0) this.degrade(dtS);

    const frame = this.director.sample(nowMs);
    this.world.update(frame, nowMs, dtS, { rung: this.rung, viewportH: this.internalH });
    window.__ocDrawCalls = this.post.render(this.world.lens);
    this.trackFrameTime(dtS * 1000);
    this.hooks.onDestinationScreen?.(
      this.world.destinationScreen() ?? { x: 0, y: 0, visible: false, r: 0 },
    );
  };

  /** Rolling median frame time over the last 300 frames (perf capture). */
  private trackFrameTime(dtMs: number): void {
    if (dtMs <= 0) return;
    this.frameTimes[this.frameCursor] = dtMs;
    this.frameCursor = (this.frameCursor + 1) % FRAME_WINDOW;
    this.frameCount = Math.min(this.frameCount + 1, FRAME_WINDOW);
    if (this.frameCount < FRAME_WINDOW && this.frameCursor % FRAME_MEDIAN_EVERY !== 0) return;
    const samples = Array.from(this.frameTimes.subarray(0, this.frameCount)).sort((a, b) => a - b);
    const mid = samples.length >> 1;
    const median =
      samples.length % 2 === 1 ? (samples[mid] ?? 0) : ((samples[mid - 1] ?? 0) + (samples[mid] ?? 0)) / 2;
    window.__ocFrameMs = median;
  }

  /**
   * Spec §4 degradation ladder: 5 s EMA of frame dt. Rung 1 (post off)
   * recovers after 10 s of EMA < 14 ms, at most 3 times per session; rungs
   * ≥2 stay one-way. The first 5 s after start() are ignored so prewarm /
   * compile hitches cannot trip the ladder. HUD is DOM and is unaffected.
   * Rungs: 1 lens off (tone map only) → 2 cheaper sky + field halved →
   * 3 internal 1080p → 4 planet flat (3 octaves) → 5 freeze 3D.
   */
  private degrade(dtS: number): void {
    if (this.rung >= 5) return;
    const inGrace = this.aliveS < GRACE_S;
    this.aliveS += dtS;
    // A lone stall (GC pause, tab hiccup, a screenshot) must not cost a rung:
    // cap each frame's contribution at 2× the floor, so only sustained slow
    // frames move the EMA past it.
    const sample = Math.min(dtS, EMA_FLOOR_S * 2);
    const alpha = 1 - Math.exp(-sample / EMA_TAU_S);
    this.emaDtS += (sample - this.emaDtS) * alpha;
    if (this.aliveS < GRACE_S) return;
    if (inGrace) {
      // Drop compile/prewarm hitch from the EMA so grace cannot trip rung 1.
      this.emaDtS = 0;
      return;
    }

    if (this.rung === 0) {
      if (this.emaDtS > EMA_FLOOR_S) this.setRung(1);
      return;
    }

    if (this.rung === 1) {
      if (this.emaDtS > EMA_FLOOR_S) {
        this.setRung(2);
        return;
      }
      if (this.recoveries < MAX_RECOVERIES && this.emaDtS < EMA_RECOVER_S) {
        this.recoverHoldS += dtS;
        if (this.recoverHoldS >= RECOVER_HOLD_S) {
          this.recoveries += 1;
          this.setRung(0);
        }
      } else {
        this.recoverHoldS = 0;
      }
      return;
    }

    if (this.emaDtS > EMA_FLOOR_S) this.setRung(this.rung + 1);
  }

  private setRung(rung: number): void {
    this.rung = Math.min(5, Math.max(0, rung));
    window.__ocGameRung = this.rung;
    this.emaDtS = 0;
    this.recoverHoldS = 0;
    this.post.setEnabled(this.rung < 1);
    if (this.rung === 3) this.resize();
    if (this.rung >= 5) {
      // Freeze: RAF stops, the last frame persists, the DOM HUD keeps living.
      this.running = false;
      cancelAnimationFrame(this.raf);
    }
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    const capW = this.rung >= 3 ? RUNG3_W : MAX_INTERNAL_W;
    const capH = this.rung >= 3 ? RUNG3_H : MAX_INTERNAL_H;
    const pr = Math.min(window.devicePixelRatio || 1, capW / w, capH / h);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.internalH = Math.max(2, Math.round(h * pr));
    this.post.setSize(Math.max(2, Math.round(w * pr)), Math.max(2, Math.round(h * pr)));
    this.world.camera.aspect = w / h;
    this.world.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.world.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    window.__ocGameRung = 0;
  }
}
