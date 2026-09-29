import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Cinematic lens (vision law 5): scene (HDR) → highlight-only bloom (13-tap
 * down / tent up mip chain) + anamorphic horizontal streak on the hottest
 * points → filmic tone map (AgX) → gentle vignette, chromatic aberration in
 * the outer 15% only, very light grain. Supercruise adds a faint blue warp in
 * the left/right bands between the route strip and the rider cards.
 *
 * Rung ≥ 1 bypasses the lens: the scene still renders to the HDR target but
 * goes straight through the tone map, so colours stay correct.
 */
const LEVELS = 6;
/** Linear HDR level where bloom and the streak start (soft knee below it). */
const BLOOM_THRESHOLD = 1.4;
const BLOOM_KNEE = 0.6;
const BLOOM_GAIN = 0.05;
/** Each coarser bloom level adds this fraction: a tight glow, no veil over the shadow. */
const BLOOM_SPREAD = 0.5;
const STREAK_THRESHOLD = 5.0;
const STREAK_GAIN = 0.07;
const STREAK_TINT = new THREE.Color(0.55, 0.72, 1.0);
const GRAIN = 0.018;

/** What the world asks of the lens this frame. */
export interface LensState {
  /** 0..1: supercruise edge warp (cruise, climb and coast legs). */
  supercruise: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uPrefilter;
varying vec2 vUv;
vec3 tap(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
float wt(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 karis(vec3 a, vec3 b, vec3 c, vec3 d) {
  float wa = wt(a), wb = wt(b), wc = wt(c), wd = wt(d);
  return (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
}
void main() {
  vec3 a = tap(-2.0, -2.0), b = tap(0.0, -2.0), c = tap(2.0, -2.0);
  vec3 d = tap(-1.0, -1.0), e = tap(1.0, -1.0);
  vec3 f = tap(-2.0, 0.0), g = tap(0.0, 0.0), h = tap(2.0, 0.0);
  vec3 i = tap(-1.0, 1.0), j = tap(1.0, 1.0);
  vec3 k = tap(-2.0, 2.0), l = tap(0.0, 2.0), m = tap(2.0, 2.0);
  vec3 col;
  if (uPrefilter > 0.5) {
    // Karis-weighted blocks keep single hot pixels from flickering, then the
    // soft-knee threshold keeps the bloom on true highlights only.
    col = karis(d, e, i, j) * 0.5 + (karis(a, b, f, g) + karis(b, c, g, h) + karis(f, g, k, l) + karis(g, h, l, m)) * 0.125;
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - ${BLOOM_THRESHOLD.toFixed(3)} + ${BLOOM_KNEE.toFixed(3)}, 0.0, ${(2 * BLOOM_KNEE).toFixed(3)});
    soft = soft * soft / ${(4 * BLOOM_KNEE).toFixed(3)};
    col *= max(soft, br - ${BLOOM_THRESHOLD.toFixed(3)}) / max(br, 1e-4);
  } else {
    col = (d + e + i + j) * 0.125 + (a + b + f + g + b + c + g + h + f + g + k + l + g + h + l + m) * 0.03125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(float x, float y) { return texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
void main() {
  vec3 c = tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0)
    + 2.0 * (tap(0.0, -1.0) + tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, 1.0)) + 4.0 * tap(0.0, 0.0);
  gl_FragColor = vec4(c * ${(BLOOM_SPREAD / 16).toFixed(5)}, 1.0);
}`;

const STREAK_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uStep;
uniform float uCut;
varying vec2 vUv;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -7; i <= 7; i++) {
    float fi = float(i);
    float w = exp(-abs(fi) * 0.32);
    vec3 c = texture2D(tSrc, vUv + vec2(fi * uStep * uTexel.x, 0.0)).rgb;
    acc += max(c - uCut, 0.0) * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform float uLens;
uniform float uAspect;
uniform float uFrame;
uniform float uSupercruise;
uniform vec3 uStreakTint;
varying vec2 vUv;
${THREE.ShaderChunk.tonemapping_pars_fragment}

float ocHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 ocSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 col;
  if (uLens < 0.5) {
    col = texture2D(tScene, vUv).rgb;
  } else {
    vec2 c = vUv - 0.5;
    vec2 e = abs(c) * 2.0;
    // Screen y runs top-down: the supercruise bands sit between the route
    // strip (top 16%) and the rider cards (below 57%), left and right only.
    float sy = 1.0 - vUv.y;
    float edgeX = smoothstep(0.55, 1.0, e.x);
    float band = edgeX * edgeX * smoothstep(0.14, 0.3, sy) * (1.0 - smoothstep(0.42, 0.57, sy)) * uSupercruise;
    vec2 radial = c / max(length(c), 1e-4);
    vec2 uv = vUv - c * band * 0.012;
    float ca = smoothstep(0.85, 1.0, max(e.x, e.y)) * 0.0022 + band * 0.004;
    vec4 scene = texture2D(tScene, uv);
    col = ca > 0.0
      ? vec3(texture2D(tScene, uv + radial * ca).r, scene.g, texture2D(tScene, uv - radial * ca).b)
      : scene.rgb;
    // Scene alpha is 0 over a black hole's bare shadow: no glow veils it.
    float glow = clamp(scene.a, 0.0, 1.0);
    col += texture2D(tBloom, uv).rgb * (${BLOOM_GAIN.toFixed(3)} * glow);
    col += texture2D(tStreak, uv).rgb * uStreakTint * (${STREAK_GAIN.toFixed(3)} * glow);
    col += vec3(0.004, 0.01, 0.03) * band;
  }
  col = AgXToneMapping(col);
  if (uLens > 0.5) {
    vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
    float r = length(v) / length(vec2(uAspect, 1.0) * 0.5);
    col *= 1.0 - 0.3 * smoothstep(0.45, 1.05, r);
  }
  col = ocSrgb(clamp(col, 0.0, 1.0));
  if (uLens > 0.5) {
    // Film grain lives in the mids: blacks stay black, whites stay clean.
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col += (ocHash12(gl_FragCoord.xy + fract(uFrame * 0.618) * 947.0) - 0.5) * ${GRAIN.toFixed(3)} * 4.0 * l * (1.0 - l);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

function target(width: number, height: number, depth: boolean): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: depth,
    generateMipmaps: false,
  });
}

export class Post {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sceneRT = target(2, 2, true);
  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly streakA = target(2, 2, false);
  private readonly streakB = target(2, 2, false);
  private readonly quad = new FullScreenQuad();
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly streakMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;
  private enabled = true;
  private frame = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    // Draw-call accounting needs one reset per frame, not one per pass.
    renderer.info.autoReset = false;
    for (let i = 0; i < LEVELS; i++) this.mips.push(target(2, 2, false));
    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader, depthTest: false, depthWrite: false });
    this.downMat = pass(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } });
    this.upMat = pass(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat.blending = THREE.AdditiveBlending;
    this.upMat.transparent = true;
    this.streakMat = pass(STREAK_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uStep: { value: 1 },
      uCut: { value: 0 },
    });
    this.compositeMat = pass(COMPOSITE_FRAG, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: this.mips[0]!.texture },
      tStreak: { value: this.streakA.texture },
      uLens: { value: 1 },
      uAspect: { value: 16 / 9 },
      uFrame: { value: 0 },
      uSupercruise: { value: 0 },
      uStreakTint: { value: STREAK_TINT },
      toneMappingExposure: { value: renderer.toneMappingExposure },
    });
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height);
    for (let i = 0; i < LEVELS; i++) {
      this.mips[i]!.setSize(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1)));
    }
    this.streakA.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    this.streakB.setSize(Math.max(1, width >> 2), Math.max(1, height >> 2));
    this.compositeMat.uniforms.uAspect!.value = width / height;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Render one frame; returns the scene's own draw call count. */
  render(lens: LensState): number {
    const r = this.renderer;
    r.info.reset();
    r.setRenderTarget(this.sceneRT);
    r.render(this.scene, this.camera);
    const calls = r.info.render.calls;

    const u = this.compositeMat.uniforms;
    u.uLens!.value = this.enabled ? 1 : 0;
    if (this.enabled) {
      this.bloom();
      u.uFrame!.value = this.frame++;
      u.uSupercruise!.value = lens.supercruise;
    }
    this.quad.material = this.compositeMat;
    r.setRenderTarget(null);
    this.quad.render(r);
    return calls;
  }

  private bloom(): void {
    const r = this.renderer;
    const down = this.downMat.uniforms;
    let src = this.sceneRT;
    this.quad.material = this.downMat;
    for (let i = 0; i < LEVELS; i++) {
      down.tSrc!.value = src.texture;
      (down.uTexel!.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      down.uPrefilter!.value = i === 0 ? 1 : 0;
      r.setRenderTarget(this.mips[i]!);
      this.quad.render(r);
      src = this.mips[i]!;
    }

    // Anamorphic streak from the quarter-res level, before the up chain adds
    // into it: three widening horizontal passes over the hottest points only.
    const s = this.streakMat.uniforms;
    const quarter = this.mips[1]!;
    this.quad.material = this.streakMat;
    const passes: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, number, number][] = [
      [quarter, this.streakA, 1, STREAK_THRESHOLD - BLOOM_THRESHOLD],
      [this.streakA, this.streakB, 5, 0],
      [this.streakB, this.streakA, 25, 0],
    ];
    for (const [from, to, step, cut] of passes) {
      s.tSrc!.value = from.texture;
      (s.uTexel!.value as THREE.Vector2).set(1 / from.width, 1 / from.height);
      s.uStep!.value = step;
      s.uCut!.value = cut;
      r.setRenderTarget(to);
      this.quad.render(r);
    }

    // Tent upsample, added into the next finer level (no clear: it accumulates).
    const up = this.upMat.uniforms;
    const autoClear = r.autoClear;
    r.autoClear = false;
    this.quad.material = this.upMat;
    for (let i = LEVELS - 1; i > 0; i--) {
      const from = this.mips[i]!;
      up.tSrc!.value = from.texture;
      (up.uTexel!.value as THREE.Vector2).set(1 / from.width, 1 / from.height);
      r.setRenderTarget(this.mips[i - 1]!);
      this.quad.render(r);
    }
    r.autoClear = autoClear;
  }

  dispose(): void {
    this.sceneRT.dispose();
    for (const rt of this.mips) rt.dispose();
    this.streakA.dispose();
    this.streakB.dispose();
    this.quad.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.streakMat.dispose();
    this.compositeMat.dispose();
    this.renderer.info.autoReset = true;
  }
}
