import * as THREE from 'three';

import { hashSeed } from '@opencycle/shared';

import { ANCHOR_SCREEN, UP, chaseDirection } from './composition.js';
import { BLACKBODY_GLSL, NOISE_GLSL } from './glsl.js';
import { lerp, seededRandom } from './math.js';
import type { Lighting } from './sky.js';

/**
 * The celestial anchor: one colossal body per system that dwarfs the fleet and
 * is the key light for everything (vision laws 1, 2 and 4). It sits at
 * infinity, so it is drawn by the sky's full-screen pass through ANCHOR_GLSL:
 * the black hole bends the view ray and returns where to look up the baked
 * sky; the stars are opaque discs with a corona and halo.
 *
 * Black hole: a Schwarzschild hole at ~38 Rs. Each pixel integrates its
 * photon's orbit equation u'' = 1.5u^2 - u in the plane of the ray (RK4 in
 * phi, Rs = 1), so the thin, nearly edge-on disk shows its direct image, the
 * lensed far side arcing over and under the shadow and the photon ring, with
 * Keplerian Doppler beaming and gravitational redshift. Escaping rays are
 * rotated by their deflection and sample the baked sky.
 */
export type AnchorKind = 'blackHole' | 'supergiant' | 'binary';

/** Seeded by the destination: black hole 45%, blue supergiant 30%, binary 25%. */
export function anchorKind(seed: string): AnchorKind {
  const roll = hashSeed(`${seed}:anchor`) % 100;
  return roll < 45 ? 'blackHole' : roll < 75 ? 'supergiant' : 'binary';
}

/** Critical impact parameter of a Schwarzschild hole (Rs = 1): the shadow edge. */
const B_CRIT = 1.5 * Math.sqrt(3);
/** Key light intensity (linear, luminance) every lit surface keys off. */
const KEY_INTENSITY = 2.1;
/** Faint cool bounce from the sky: the only ambient in the world. */
const FILL_SKY = new THREE.Color(0.012, 0.016, 0.028);
const FILL_GROUND = new THREE.Color(0.003, 0.004, 0.007);

/** Blackbody colour (see BLACKBODY_GLSL), linear sRGB with luminance 1. */
export function blackbody(kelvin: number, out: THREE.Color): THREE.Color {
  const T = Math.min(25000, Math.max(1667, kelvin));
  const t = 1000 / T;
  const x =
    T < 4000
      ? ((-0.2661239 * t - 0.2343589) * t + 0.8776956) * t + 0.17991
      : ((-3.0258469 * t + 2.1070379) * t + 0.2226347) * t + 0.24039;
  const y =
    T < 2222
      ? ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683
      : T < 4000
        ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
        : ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  const X = x / y;
  const Z = (1 - x - y) / y;
  return out.setRGB(
    Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z),
    Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z),
    Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z),
  );
}

export const ANCHOR_GLSL = /* glsl */ `
#define OC_PI 3.14159265
uniform vec3 uADir;
uniform vec3 uARight;
uniform vec3 uAUp;
uniform float uAKind;
uniform float uATime;
uniform float uAQuality;
uniform float uBhShadow;
uniform vec3 uBhN;
uniform vec3 uBhA;
uniform vec3 uBhB;
uniform vec2 uBhRange;
uniform float uBhTemp;
uniform float uBhGain;
uniform vec2 uStarPos[2];
uniform float uStarRad[2];
uniform vec2 uStarLight[2];
uniform float uStream;
${NOISE_GLSL}
${BLACKBODY_GLSL}

vec2 ocGeo(vec2 s) { return vec2(s.y, 1.5 * s.x * s.x - s.x); }

// Turbulent streaks in co-rotating (angle, radius) space: long along the orbit,
// fine across it, with slow hot spots riding the flow.
float ocStreaks(float a, float r, float seed) {
  vec3 p = vec3(cos(a) * 1.7, sin(a) * 1.7, r * 1.25 + seed);
  float n = ocNoise(p * vec3(1.0, 1.0, 2.4)) * 0.6 + ocNoise(p * vec3(2.3, 2.3, 6.0) + 3.1) * 0.4;
  if (uAQuality > 0.5) n = n * 0.72 + ocNoise(p * vec3(4.7, 4.7, 13.0) + 7.7) * 0.28;
  float spots = ocNoise(vec3(cos(a) * 0.8, sin(a) * 0.8, r * 0.35 + seed * 0.3));
  return n * (0.55 + 0.9 * spots);
}

// Disk emission at P (local frame, Rs units) seen along toEye; alpha is its opacity.
vec3 ocDisk(vec3 P, float r, vec3 toEye, out float alpha) {
  float x = uBhRange.x / r;
  // Thin-disk temperature profile, 1 at its peak just outside the inner edge.
  float prof = pow(x, 0.75) * pow(max(1.0 - sqrt(x), 0.0), 0.25) * 2.05;
  float beta = sqrt(0.5 / max(r - 1.0, 0.5));
  vec3 v = normalize(cross(uBhN, P));
  float gamma = inversesqrt(max(1.0 - beta * beta, 0.05));
  float g = sqrt(max(1.0 - 1.0 / r, 0.0)) / (gamma * (1.0 - beta * dot(v, toEye)));
  // Keplerian shear, cycled over two offset layers so the streaks never wind up.
  float ang = atan(dot(P, uBhB), dot(P, uBhA));
  float omega = 0.2 * pow(uBhRange.x / r, 1.5);
  float cyc = uATime / 30.0;
  float w = 1.0 - abs(2.0 * fract(cyc) - 1.0);
  float tex = ocStreaks(ang - omega * fract(cyc) * 30.0, r, 0.0) * w
    + ocStreaks(ang - omega * fract(cyc + 0.5) * 30.0, r, 11.0) * (1.0 - w);
  tex = smoothstep(0.12, 0.95, tex);
  // Broad ring gaps keep the disk from reading as one flat band.
  float gaps = 0.55 + 0.45 * smoothstep(0.3, 0.62, ocNoise(vec3(r * 0.85, 1.3, 2.7)));
  float edge = smoothstep(uBhRange.y, uBhRange.y * 0.5, r) * smoothstep(uBhRange.x * 0.98, uBhRange.x * 1.1, r);
  alpha = clamp((0.55 + 0.45 * tex) * edge * gaps * 1.2, 0.0, 0.96);
  float I = uBhGain * pow(prof, 4.0) * pow(g, 3.0) * (0.25 + 1.2 * tex) * gaps;
  // White-gold at the inner edge, amber mid-disk, dusky orange-red outside;
  // accretion light reads richer than a bare blackbody through the tone map.
  vec3 c = ocBlackbody(uBhTemp * mix(0.34, 1.0, prof) * g);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return max(mix(vec3(l), c, 1.45), 0.0) * I;
}

vec3 ocBlackHole(vec3 dir, float c, vec2 img, out vec3 skyDir, out float skyT, out float hole) {
  skyDir = dir;
  skyT = 0.0;
  hole = 0.0;
  float s = length(img);
  float D = ${B_CRIT.toFixed(6)} / sin(uBhShadow);
  float b = D * s;
  if (b < 1e-3) {
    hole = 1.0;
    return vec3(0.0);
  }
  vec2 e2 = img / s;
  vec3 e3 = vec3(e2, 0.0);
  const vec3 Z = vec3(0.0, 0.0, 1.0);
  // The disk plane meets this ray's orbital plane in a line through the hole:
  // the orbit crosses it at phi0 + k*pi.
  float phi0 = atan(-uBhN.z, dot(uBhN.xy, e2));
  if (phi0 < 0.0) phi0 += OC_PI;
  vec3 col = vec3(0.0);
  float T = 1.0;
  float deflect = 0.0;
  bool captured = false;
  if (b > uBhRange.y + 3.0) {
    // Weak field, beyond the disk: the deflection series to third order (it
    // meets the integrated orbits within 0.1%), tapered as the ray turns away.
    deflect = (2.0 / b + 2.9452 / (b * b) + 5.3333 / (b * b * b)) * smoothstep(0.05, 0.45, c);
  } else {
    float h = uAQuality > 0.5 ? 0.085 : 0.15;
    int steps = uAQuality > 0.5 ? 96 : 56;
    vec2 st = vec2(0.0, 1.0 / b);
    float phi = 0.0;
    float crossing = phi0;
    bool escaped = false;
    for (int i = 0; i < 96; i++) {
      if (i >= steps) break;
      vec2 k1 = ocGeo(st);
      vec2 k2 = ocGeo(st + 0.5 * h * k1);
      vec2 k3 = ocGeo(st + 0.5 * h * k2);
      vec2 k4 = ocGeo(st + h * k3);
      vec2 nx = st + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
      if (crossing <= phi + h) {
        float f = (crossing - phi) / h;
        float u = mix(st.x, nx.x, f);
        float du = mix(st.y, nx.y, f);
        if (u > 0.0) {
          float r = 1.0 / u;
          if (r > uBhRange.x && r < uBhRange.y) {
            vec3 er = cos(crossing) * Z + sin(crossing) * e3;
            vec3 ep = cos(crossing) * e3 - sin(crossing) * Z;
            vec3 back = normalize(ep - du * r * er);
            float a;
            vec3 e = ocDisk(r * er, r, -back, a);
            col += T * e * a;
            T *= 1.0 - a;
          }
        }
        crossing += OC_PI;
      }
      if (nx.x < 0.0) {
        deflect = phi + h * st.x / (st.x - nx.x) - OC_PI;
        escaped = true;
        break;
      }
      st = nx;
      phi += h;
      if (st.x > 1.0 || T < 0.02) break;
    }
    captured = !escaped;
  }
  // Photon ring: the stacked higher-order images at the critical impact
  // parameter, beamed like the disk.
  vec3 pr = normalize(e3 - uBhN * dot(uBhN, e3));
  float gr = 1.0 / (1.0 - 0.42 * dot(normalize(cross(uBhN, pr)), Z));
  float ring = exp(-pow((b - ${B_CRIT.toFixed(6)}) * 7.0, 2.0)) + 0.25 * exp(-pow((b - ${B_CRIT.toFixed(6)} * 1.03) * 2.2, 2.0));
  col += T * ocBlackbody(uBhTemp * 1.05 * gr) * uBhGain * 0.35 * ring * gr * gr * gr;
  if (captured) {
    skyT = 0.0;
    hole = T;
    return col;
  }
  skyT = T;
  vec3 axis = normalize(cross(dir, uADir));
  skyDir = dir * cos(deflect) + cross(axis, dir) * sin(deflect);
  return col;
}

// One star in tangent-plane units. The disc sits below clipping except a thin
// core: white-blue centre deepening to blue at the limb, granulation and bright
// faculae near the limb. Outside: a thin filamentary crown hugging the limb
// with a few long streamers, a fast halo and a few thin diffraction rays.
// cover = disc opacity.
vec3 ocStar(vec2 d, float R, vec2 light, float seed, float spikes, inout float cover) {
  float rho = length(d) / R;
  vec3 col = vec3(0.0);
  float px = fwidth(rho) * 1.2;
  float disc = 1.0 - smoothstep(1.0 - px, 1.0 + px, rho);
  if (disc > 0.0) {
    float mu = sqrt(max(1.0 - rho * rho, 0.0));
    float limb = 0.28 + 0.72 * pow(mu, 0.55);
    vec3 sp = vec3(d / R, mu);
    float gran = ocNoise(sp * 30.0 + vec3(seed, 0.0, uATime * 0.05)) * 0.55 + ocNoise(sp * 80.0 + seed) * 0.45;
    float faculae = smoothstep(0.62, 0.8, ocNoise(sp * 11.0 + seed + 3.0)) * smoothstep(0.5, 0.1, mu);
    vec3 centre = ocBlackbody(light.x * 1.2);
    vec3 rim = ocBlackbody(light.x) * vec3(0.5, 0.78, 1.3);
    float core = exp(-rho * rho * 30.0) * 1.3;
    col += mix(rim, centre, pow(mu, 0.7)) * light.y * (limb * (0.72 + 0.5 * gran) + faculae * 0.45 + core) * disc;
    cover = max(cover, disc);
  }
  float o = max(rho - 1.0, 0.0);
  float ang = atan(d.y, d.x + 1e-9);
  vec2 cs = vec2(cos(ang), sin(ang));
  float fil = ocNoise(vec3(cs * 24.0, o * 7.0 - uATime * 0.02 + seed));
  if (uAQuality > 0.5) fil = fil * 0.6 + ocNoise(vec3(cs * 55.0, o * 14.0 - uATime * 0.035 + seed * 1.7)) * 0.4;
  float streamers = pow(ocNoise(vec3(cs * 4.0, seed + 9.0)), 3.0) * 2.4;
  float crown = exp(-o * 16.0) * (0.25 + 1.8 * fil * fil) + exp(-o * 3.5) * streamers * fil * 0.5;
  float halo = 0.03 * exp(-o * 3.5) + 0.003 * exp(-o * 1.1);
  float rays = 0.0;
  for (int k = 0; k < 3; k++) {
    if (float(k) >= spikes * 0.5) break;
    float a = seed + float(k) * 6.2831853 / spikes;
    float perp = abs(dot(d / R, vec2(-sin(a), cos(a))));
    rays += exp(-perp * perp * 1400.0) * exp(-o * 2.6);
  }
  col += ocBlackbody(light.x * 1.05) * light.y * (crown * 0.5 + halo + rays * 0.18) * (1.0 - disc);
  return col;
}

// Roche-lobe overflow: a warm stream bowing off the primary's inner Lagrange
// point and winding onto a faint hot ring around the companion.
vec3 ocStreamGlow(vec2 q) {
  vec2 a = uStarPos[0];
  vec2 bc = uStarPos[1];
  vec2 ab = bc - a;
  float L = length(ab);
  vec2 t = ab / L;
  vec2 nrm = vec2(-t.y, t.x);
  vec2 l = vec2(dot(q - a, t), dot(q - a, nrm));
  float x0 = uStarRad[0] * 0.95;
  float x1 = L - uStarRad[1] * 1.6;
  float s = clamp((l.x - x0) / (x1 - x0), 0.0, 1.0);
  float bow = sin(s * OC_PI) * uStarRad[1] * 0.9;
  float width = mix(0.08, 0.3, s) * uStarRad[1];
  float along = smoothstep(-0.02, 0.05, (l.x - x0) / L) * (1.0 - smoothstep(0.95, 1.0, s));
  float stream = exp(-pow((l.y - bow) / width, 2.0)) * along;
  vec2 rb = q - bc;
  vec2 rl = vec2(dot(rb, t), dot(rb, nrm) * 2.6);
  float ringR = length(rl) / (uStarRad[1] * 1.9);
  float ringGlow = exp(-pow((ringR - 1.0) * 5.0, 2.0)) * 0.6;
  float n = ocNoise(vec3(l * 90.0, uATime * 0.05));
  vec3 warm = ocBlackbody(uStarLight[0].x * 1.1);
  vec3 hot = ocBlackbody(uStarLight[1].x * 0.8);
  return (mix(warm, hot, s) * stream * (0.6 + 0.6 * n) + hot * ringGlow) * uStream;
}

// Emitted anchor light for the view ray dir. skyDir is where the (lensed)
// background is looked up, skyT how much of it shows through, and hole how
// much of the pixel is bare shadow (the lens keeps that truly black).
vec3 ocAnchor(vec3 dir, out vec3 skyDir, out float skyT, out float hole) {
  skyDir = dir;
  skyT = 1.0;
  hole = 0.0;
  float c = dot(dir, uADir);
  if (c <= 0.05) return vec3(0.0);
  vec2 img = vec2(dot(dir, uARight), dot(dir, uAUp));
  if (uAKind < 0.5) return ocBlackHole(dir, c, img, skyDir, skyT, hole);
  vec2 q = img / c;
  float cover = 0.0;
  vec3 col = ocStar(q - uStarPos[0], uStarRad[0], uStarLight[0], 0.0, uAKind > 1.5 ? 0.0 : 6.0, cover);
  if (uAKind > 1.5) {
    col += ocStar(q - uStarPos[1], uStarRad[1], uStarLight[1], 13.0, 4.0, cover);
    col += ocStreamGlow(q) * (1.0 - cover);
  }
  skyT = 1.0 - cover;
  return col;
}
`;

/**
 * Seeded anchor parameters, the uniforms ANCHOR_GLSL reads, and the one shared
 * Lighting value every lit module consumes.
 */
export class Anchor {
  kind: AnchorKind = 'blackHole';
  /** Unit world direction from the stage toward the anchor centre (= lighting.sunDir). */
  readonly direction = new THREE.Vector3(0, 0, -1);
  /** Angular radius (rad) of the core: shadow, star disc or half the binary pair. */
  coreRadius = 0.07;
  /** Angular half-extent (rad) of everything visible: disk, corona, halo. */
  extentRadius = 0.3;
  readonly lighting: Lighting;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private seed = '';

  constructor() {
    this.lighting = {
      sunDir: this.direction,
      key: new THREE.Color(),
      fillSky: FILL_SKY.clone(),
      fillGround: FILL_GROUND.clone(),
      ambient: Array.from({ length: 6 }, () => new THREE.Color(0.08, 0.1, 0.16)),
      rim: new THREE.Color(),
    };
    this.uniforms = {
      uADir: { value: this.direction },
      uARight: { value: this.right },
      uAUp: { value: this.up },
      uAKind: { value: 0 },
      uATime: { value: 0 },
      uAQuality: { value: 1 },
      uBhShadow: { value: 0.07 },
      uBhN: { value: new THREE.Vector3(0, 1, 0) },
      uBhA: { value: new THREE.Vector3(1, 0, 0) },
      uBhB: { value: new THREE.Vector3(0, 0, 1) },
      uBhRange: { value: new THREE.Vector2(3, 13) },
      uBhTemp: { value: 5500 },
      uBhGain: { value: 5 },
      uStarPos: { value: [new THREE.Vector2(), new THREE.Vector2()] },
      uStarRad: { value: [0.08, 0.03] },
      uStarLight: { value: [new THREE.Vector2(20000, 30), new THREE.Vector2(15000, 30)] },
      uStream: { value: 0 },
    };
    this.setSeed('idle');
  }

  /** Re-seed kind, placement, size and light. Cheap; only runs on seed change. */
  setSeed(seed: string): void {
    if (seed === this.seed) return;
    this.seed = seed;
    const rnd = seededRandom(`${seed}:anchor:shape`);
    this.kind = anchorKind(seed);
    const u = this.uniforms;
    u.uAKind!.value = this.kind === 'blackHole' ? 0 : this.kind === 'supergiant' ? 1 : 2;

    chaseDirection(ANCHOR_SCREEN.x + (rnd() - 0.5) * 0.04, ANCHOR_SCREEN.y + (rnd() - 0.5) * 0.04, this.direction);
    this.right.crossVectors(this.direction, UP).normalize();
    this.up.crossVectors(this.right, this.direction).normalize();

    const key = this.lighting.key;
    if (this.kind === 'blackHole') {
      const shadow = lerp(0.062, 0.072, rnd());
      const inner = lerp(2.9, 3.2, rnd());
      const outer = lerp(11.5, 14, rnd());
      // Nearly edge-on (tilt 6-12 deg), seen from above; the roll always lifts
      // the left arm so it clears the cruise destination.
      const tilt = THREE.MathUtils.degToRad(lerp(6, 12, rnd()));
      const roll = THREE.MathUtils.degToRad(lerp(3, 9, rnd()));
      // Major axis a = (cos, -sin): the left end rises by the roll.
      const n = (u.uBhN!.value as THREE.Vector3)
        .set(Math.sin(roll) * Math.cos(tilt), Math.cos(roll) * Math.cos(tilt), Math.sin(tilt))
        .normalize();
      const a = (u.uBhA!.value as THREE.Vector3).set(Math.cos(roll), -Math.sin(roll), 0);
      (u.uBhB!.value as THREE.Vector3).crossVectors(n, a);
      (u.uBhRange!.value as THREE.Vector2).set(inner, outer);
      const temp = lerp(4600, 5600, rnd());
      u.uBhShadow!.value = shadow;
      u.uBhTemp!.value = temp;
      u.uBhGain!.value = 5;
      this.coreRadius = shadow;
      this.extentRadius = Math.atan(outer / (B_CRIT / Math.sin(shadow)));
      blackbody(temp * 0.9, key);
    } else {
      const pos = u.uStarPos!.value as THREE.Vector2[];
      const rad = u.uStarRad!.value as number[];
      const light = u.uStarLight!.value as THREE.Vector2[];
      if (this.kind === 'supergiant') {
        const r = lerp(0.06, 0.07, rnd());
        const temp = lerp(15000, 25000, rnd());
        pos[0]!.set(0, 0);
        rad[0] = r;
        rad[1] = 0.001;
        light[0]!.set(temp, 2.1);
        light[1]!.set(temp, 0);
        u.uStream!.value = 0;
        this.coreRadius = r;
        this.extentRadius = r * 3;
        blackbody(temp, key);
      } else {
        // One warm giant filling its Roche lobe at the anchor mark, one hot blue
        // companion outboard (away from the destination), so the planet can
        // sit in front of the pair at arrival without eclipsing the giant.
        const ra = lerp(0.055, 0.066, rnd());
        const rb = lerp(0.024, 0.03, rnd());
        const sep = lerp(0.15, 0.18, rnd());
        const angle = THREE.MathUtils.degToRad(lerp(-35, 15, rnd()));
        const ta = lerp(3900, 4800, rnd());
        const tb = lerp(14000, 20000, rnd());
        pos[0]!.set(0, 0);
        pos[1]!.set(Math.cos(angle) * sep, Math.sin(angle) * sep);
        rad[0] = ra;
        rad[1] = rb;
        light[0]!.set(ta, 3);
        light[1]!.set(tb, 8);
        u.uStream!.value = 1.2;
        this.coreRadius = ra;
        this.extentRadius = sep + ra * 2.5;
        const warm = blackbody(ta, new THREE.Color()).multiplyScalar(0.6);
        key.copy(blackbody(tb, new THREE.Color()).multiplyScalar(0.4)).add(warm);
      }
    }
    key.multiplyScalar(KEY_INTENSITY / (0.2126 * key.r + 0.7152 * key.g + 0.0722 * key.b));
    this.lighting.rim.copy(key).multiplyScalar(0.06);
  }

  /** Rung 2+ uses the cheaper anchor: fewer orbit steps and noise octaves. */
  setRung(rung: number): void {
    this.uniforms.uAQuality!.value = rung >= 2 ? 0 : 1;
  }

  update(dtS: number): void {
    this.uniforms.uATime!.value += dtS;
  }
}
