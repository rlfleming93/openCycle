import * as THREE from 'three';

/**
 * Every engine in two draws: one instanced plume ribbon per nozzle and one glow
 * sprite per nozzle. The fleet and the raider fill a spec per nozzle each frame
 * (`begin`, `add` per nozzle, `end`).
 *
 * The plume is a soft transparent flame: an axial billboard (turned about the
 * plume axis to face the camera) whose light falls off along its length and
 * across its radius to zero at every edge, tapering toward the tip, with a hot
 * centre line; at full burn heat a train of shock diamonds runs down that
 * line. The glow is the small round nozzle core, plus a bright ring that
 * expands on a boost.
 */
const CAPACITY = 12;
/** Glow sprites grow this much while a boost ring runs (the ring's canvas). */
const RING_SCALE = 3;

const PLUME_VERT = /* glsl */ `
attribute vec3 aCore;
attribute vec3 aEdge;
attribute vec4 aParams; // opacity, heat, sputter, seed
varying vec2 vUv;
varying vec3 vCore;
varying vec3 vEdge;
varying vec4 vParams;
void main() {
  // The quad spans x -1..1 across the flame and y 0..1 from nozzle to tip.
  vUv = position.xy;
  vCore = aCore;
  vEdge = aEdge;
  vParams = aParams;
  mat4 m = modelMatrix * instanceMatrix;
  vec3 axis = m[2].xyz;
  float len = max(length(axis), 1e-4);
  axis /= len;
  vec3 p = m[3].xyz + axis * (position.y * len);
  // Turn about the axis to face the camera (end-on it thins to a line and
  // the nozzle glow takes over).
  vec3 side = cross(axis, normalize(cameraPosition - p));
  float s = length(side);
  side = s > 1e-4 ? side / s : normalize(m[0].xyz);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + side * (position.x * length(m[0].xyz)), 1.0);
}`;

const PLUME_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vCore;
varying vec3 vEdge;
varying vec4 vParams;
void main() {
  float along = clamp(vUv.y, 0.0, 1.0);
  float heat = vParams.y;
  float hot = smoothstep(1.3, 2.0, heat);
  // Tapers from the nozzle width to a narrow tip; soft all the way to the edge.
  float x = vUv.x / mix(1.0, 0.22, pow(along, 0.8));
  if (abs(x) >= 1.0) discard;
  float x2 = x * x;
  float radial = exp(-x2 * 3.0) * (1.0 - x2);
  float centre = exp(-x2 * 14.0);
  float fade = pow(1.0 - along, 1.5 + 0.6 * (1.0 - hot)) * smoothstep(0.0, 0.04, along);
  // White-hot along the centre near the nozzle, the throttle colour elsewhere.
  vec3 col = mix(vEdge, vCore, centre * (1.0 - smoothstep(0.0, 0.45 + 0.3 * hot, along)));
  float flicker = 0.9 + 0.1 * sin(uTime * 37.0 + along * 17.0 + vParams.w * 6.2831853);
  // Shock diamonds: standing bright knots on the centre line of an on-target burn.
  float diamonds = pow(0.5 + 0.5 * cos(along * 28.0), 12.0) * hot * centre * (1.0 - along);
  float a = vParams.x * fade * radial * flicker;
  a *= 1.0 - vParams.z * (0.55 + 0.45 * sin(uTime * 47.0 + along * 9.0));
  gl_FragColor = vec4((col + vCore * diamonds * 1.5) * a, 1.0);
}`;

const GLOW_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aGlow; // world size, alpha, ring phase (-1 none), sputter
uniform float uScreenScale;
varying vec3 vColor;
varying vec4 vGlow;
void main() {
  vColor = aColor;
  vGlow = aGlow;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aGlow.x * uScreenScale / max(-mv.z, 1.0), 2.0, 360.0);
}`;

const GLOW_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying vec4 vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  // While a boost ring runs the sprite is RING_SCALE times larger, so the
  // core is drawn at its usual size and the ring has room to expand.
  float phase = vGlow.z;
  float rc = phase < 0.0 ? r : r * ${RING_SCALE.toFixed(1)};
  float core = exp(-rc * rc * 22.0);
  float halo = exp(-rc * rc * 6.0) * 0.2;
  float a = (core * 1.3 + halo) * vGlow.y;
  a *= 1.0 - vGlow.w * (0.5 + 0.5 * sin(uTime * 47.0));
  float ring = phase < 0.0 ? 0.0 : exp(-pow((r - (0.1 + 0.85 * phase)) * 18.0, 2.0)) * (1.0 - phase) * (1.0 - phase);
  vec3 col = mix(vColor, vec3(1.0), core * 0.35);
  gl_FragColor = vec4(col * a + vec3(0.75, 0.88, 1.0) * ring * 3.0, 1.0);
}`;

/** One nozzle's look for this frame. Colours are linear HDR. */
export interface EngineSpec {
  /** Nozzle mouth in world space. */
  position: THREE.Vector3;
  /** Plume axis orientation (plume runs along local +Z). */
  quaternion: THREE.Quaternion;
  radius: number;
  length: number;
  core: THREE.Color;
  edge: THREE.Color;
  opacity: number;
  /** 0 idle, 1 cruise, 2 on-target burn (shock diamonds). */
  heat: number;
  sputter: number;
  glowSize: number;
  glowAlpha: number;
  glowColor: THREE.Color;
  /** Boost ring progress 0..1, or -1 for none. */
  ring: number;
  seed: number;
}

export class Engines {
  readonly group = new THREE.Group();
  private readonly plumes: THREE.InstancedMesh;
  private readonly plumeMat: THREE.ShaderMaterial;
  private readonly core = new Float32Array(CAPACITY * 3);
  private readonly edge = new Float32Array(CAPACITY * 3);
  private readonly params = new Float32Array(CAPACITY * 4);
  private readonly glowGeo = new THREE.BufferGeometry();
  private readonly glowMat: THREE.ShaderMaterial;
  private readonly glowPos = new Float32Array(CAPACITY * 3);
  private readonly glowColor = new Float32Array(CAPACITY * 3);
  private readonly glowData = new Float32Array(CAPACITY * 4);
  private readonly glows: THREE.Points;
  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();
  private count = 0;

  constructor() {
    // A ribbon from the nozzle mouth (y 0) to the tip (y 1); the vertex shader
    // lays it along the plume axis, facing the camera.
    const geo = new THREE.PlaneGeometry(2, 1);
    geo.translate(0, 0.5, 0);
    geo.setAttribute('aCore', new THREE.InstancedBufferAttribute(this.core, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aEdge', new THREE.InstancedBufferAttribute(this.edge, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    this.plumeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.plumes = new THREE.InstancedMesh(geo, this.plumeMat, CAPACITY);
    this.plumes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.plumes.frustumCulled = false;
    this.plumes.renderOrder = 5;
    this.plumes.count = 0;

    this.glowGeo.setAttribute('position', new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo.setAttribute('aColor', new THREE.BufferAttribute(this.glowColor, 3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo.setAttribute('aGlow', new THREE.BufferAttribute(this.glowData, 4).setUsage(THREE.DynamicDrawUsage));
    this.glowMat = new THREE.ShaderMaterial({
      uniforms: { uScreenScale: { value: 540 }, uTime: { value: 0 } },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glows = new THREE.Points(this.glowGeo, this.glowMat);
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 6;
    this.group.add(this.plumes, this.glows);
  }

  begin(): void {
    this.count = 0;
  }

  add(spec: EngineSpec): void {
    if (this.count >= CAPACITY) return;
    const i = this.count;
    this.count += 1;
    this.scale.set(spec.radius, spec.radius, Math.max(0.05, spec.length));
    this.matrix.compose(spec.position, spec.quaternion, this.scale);
    this.plumes.setMatrixAt(i, this.matrix);
    this.core[i * 3] = spec.core.r;
    this.core[i * 3 + 1] = spec.core.g;
    this.core[i * 3 + 2] = spec.core.b;
    this.edge[i * 3] = spec.edge.r;
    this.edge[i * 3 + 1] = spec.edge.g;
    this.edge[i * 3 + 2] = spec.edge.b;
    this.params[i * 4] = spec.opacity;
    this.params[i * 4 + 1] = spec.heat;
    this.params[i * 4 + 2] = spec.sputter;
    this.params[i * 4 + 3] = spec.seed;
    this.glowPos[i * 3] = spec.position.x;
    this.glowPos[i * 3 + 1] = spec.position.y;
    this.glowPos[i * 3 + 2] = spec.position.z;
    this.glowColor[i * 3] = spec.glowColor.r;
    this.glowColor[i * 3 + 1] = spec.glowColor.g;
    this.glowColor[i * 3 + 2] = spec.glowColor.b;
    this.glowData[i * 4] = spec.glowSize * (spec.ring >= 0 ? RING_SCALE : 1);
    this.glowData[i * 4 + 1] = spec.glowAlpha;
    this.glowData[i * 4 + 2] = spec.ring;
    this.glowData[i * 4 + 3] = spec.sputter;
  }

  end(timeS: number, screenScale: number): void {
    const n = this.count;
    this.plumes.count = n;
    this.plumes.visible = n > 0;
    this.glows.visible = n > 0;
    this.glowGeo.setDrawRange(0, n);
    if (n > 0) {
      this.plumes.instanceMatrix.needsUpdate = true;
      for (const name of ['aCore', 'aEdge', 'aParams']) this.plumes.geometry.getAttribute(name).needsUpdate = true;
      for (const name of ['position', 'aColor', 'aGlow']) this.glowGeo.getAttribute(name).needsUpdate = true;
    }
    this.plumeMat.uniforms.uTime!.value = timeS;
    this.glowMat.uniforms.uTime!.value = timeS;
    this.glowMat.uniforms.uScreenScale!.value = screenScale;
  }

  dispose(): void {
    this.plumes.geometry.dispose();
    this.plumeMat.dispose();
    this.plumes.dispose();
    this.glowGeo.dispose();
    this.glowMat.dispose();
  }
}
