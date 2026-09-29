import * as THREE from 'three';

/**
 * Every short-lived sprite in one additive Points draw: RCS puffs, muzzle
 * flashes, chaff flares, shield hits and explosion sparks. Particles are
 * CPU-integrated (drag, growth, fade) and sized in world units, so they sit at
 * the right depth; the live ones are kept packed at the front of the buffers.
 */
const CAPACITY = 768;

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aHard;
uniform float uScreenScale;
varying vec3 vColor;
varying float vAlpha;
varying float vHard;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vHard = aHard;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScreenScale / max(-mv.z, 0.5), 1.0, 320.0);
}`;

/** Soft gas (hard 0) through hot sparks (hard 1): a gaussian or a core + halo. */
const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vHard;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float soft = exp(-r2 * 3.2) * (1.0 - r2);
  float hot = exp(-r2 * 18.0) * 1.6 + exp(-r2 * 4.0) * 0.35;
  float a = mix(soft, hot, vHard) * vAlpha;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

export interface SparkSpec {
  /** World size at birth and at death (units). */
  size0: number;
  size1: number;
  lifeS: number;
  /** Linear HDR colour; bright cores go past 1 so post can bloom them. */
  color: THREE.Color;
  alpha: number;
  /** 0 soft puff .. 1 hot spark. */
  hard: number;
  /** Velocity decay per second. */
  drag: number;
  /** 0..1 random brightness flicker (magnesium flares). */
  flicker: number;
}

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  hard: number;
  drag: number;
  flicker: number;
  color: THREE.Color;
}

export class Sparks {
  readonly object: THREE.Points;
  private readonly geo = new THREE.BufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly colors = new Float32Array(CAPACITY * 3);
  private readonly sizes = new Float32Array(CAPACITY);
  private readonly alphas = new Float32Array(CAPACITY);
  private readonly hards = new Float32Array(CAPACITY);
  private readonly pool: Particle[] = [];
  private live = 0;
  /** Rung 2 halves particles. */
  private budget = CAPACITY;

  constructor() {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        age: 0,
        life: 1,
        size0: 1,
        size1: 1,
        alpha: 1,
        hard: 0,
        drag: 0,
        flicker: 0,
        color: new THREE.Color(),
      });
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aHard', new THREE.BufferAttribute(this.hards, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScreenScale: { value: 540 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 9;
    this.object.visible = false;
  }

  setRung(rung: number): void {
    this.budget = rung >= 2 ? CAPACITY / 2 : CAPACITY;
  }

  /** Spawn one particle; silently dropped when the pool is full. */
  emit(pos: THREE.Vector3, vel: THREE.Vector3, spec: SparkSpec): void {
    if (this.live >= this.budget) return;
    const p = this.pool[this.live]!;
    this.live += 1;
    p.pos.copy(pos);
    p.vel.copy(vel);
    p.age = 0;
    p.life = Math.max(0.02, spec.lifeS);
    p.size0 = spec.size0;
    p.size1 = spec.size1;
    p.alpha = spec.alpha;
    p.hard = spec.hard;
    p.drag = spec.drag;
    p.flicker = spec.flicker;
    p.color.copy(spec.color);
  }

  update(dtS: number, screenScale: number): void {
    let i = 0;
    while (i < this.live) {
      const p = this.pool[i]!;
      p.age += dtS;
      if (p.age >= p.life) {
        // Swap-remove keeps the live particles packed for the draw range.
        this.live -= 1;
        this.pool[i] = this.pool[this.live]!;
        this.pool[this.live] = p;
        continue;
      }
      p.vel.multiplyScalar(Math.exp(-p.drag * dtS));
      p.pos.addScaledVector(p.vel, dtS);
      const t = p.age / p.life;
      const o = i * 3;
      this.positions[o] = p.pos.x;
      this.positions[o + 1] = p.pos.y;
      this.positions[o + 2] = p.pos.z;
      this.colors[o] = p.color.r;
      this.colors[o + 1] = p.color.g;
      this.colors[o + 2] = p.color.b;
      this.sizes[i] = p.size0 + (p.size1 - p.size0) * t;
      const flicker = p.flicker > 0 ? 1 - p.flicker * Math.random() : 1;
      this.alphas[i] = p.alpha * (1 - t) * (1 - t) * flicker;
      this.hards[i] = p.hard;
      i += 1;
    }
    this.geo.setDrawRange(0, this.live);
    this.object.visible = this.live > 0;
    if (this.live > 0) {
      for (const name of ['position', 'aColor', 'aSize', 'aAlpha', 'aHard']) {
        const attr = this.geo.getAttribute(name) as THREE.BufferAttribute;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, this.live * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
    this.mat.uniforms.uScreenScale!.value = screenScale;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
