/**
 * Shared GLSL for the world modules. Kept as plain strings: three's
 * ShaderMaterial compiles GLSL ES 1.00 style sources (it injects
 * `#version 300 es` plus the varying/attribute defines for WebGL2), so
 * `texture2D`, `varying` and `dFdx` all work as written.
 */

/** Cheap 3D value noise + FBM (`ocFbm` takes a float octave count so the degradation ladder can drop to 3). */
export const NOISE_GLSL = /* glsl */ `
float ocHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float ocNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(ocHash(i + vec3(0.0, 0.0, 0.0)), ocHash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(ocHash(i + vec3(0.0, 1.0, 0.0)), ocHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(ocHash(i + vec3(0.0, 0.0, 1.0)), ocHash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(ocHash(i + vec3(0.0, 1.0, 1.0)), ocHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float ocFbm(vec3 p, float octaves) {
  float amp = 0.5;
  float sum = 0.0;
  for (int i = 0; i < 7; i++) {
    if (float(i) >= octaves) break;
    sum += amp * ocNoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
`;

/**
 * Blackbody colour: the Planckian locus (Kim et al. 2002) taken to linear sRGB
 * with luminance 1, for 1667-25000 K. Stars, the accretion disk and the key
 * light all read their colour from temperature through this one curve.
 */
export const BLACKBODY_GLSL = /* glsl */ `
vec3 ocBlackbody(float kelvin) {
  float T = clamp(kelvin, 1667.0, 25000.0);
  float t = 1000.0 / T;
  float x = T < 4000.0
    ? ((-0.2661239 * t - 0.2343589) * t + 0.8776956) * t + 0.179910
    : ((-3.0258469 * t + 2.1070379) * t + 0.2226347) * t + 0.240390;
  float y = T < 2222.0
    ? ((-1.1063814 * x - 1.34811020) * x + 2.18555832) * x - 0.20219683
    : T < 4000.0
      ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
      : ((3.0817580 * x - 5.87338670) * x + 3.75112997) * x - 0.37001483;
  vec3 xyz = vec3(x / y, 1.0, (1.0 - x - y) / y);
  return max(mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * xyz, 0.0);
}
`;

/**
 * Sky fill from the published ambient cube (`Lighting.ambient`, ordered +X, -X,
 * +Y, -Y, +Z, -Z): each axis contributes by the squared normal component on
 * its side, so a face turned toward a blue nebula takes a blue fill.
 */
export const AMBIENT_GLSL = /* glsl */ `
vec3 ocAmbient(vec3 N, vec3 cube[6]) {
  vec3 n2 = N * N;
  return n2.x * (N.x >= 0.0 ? cube[0] : cube[1])
    + n2.y * (N.y >= 0.0 ? cube[2] : cube[3])
    + n2.z * (N.z >= 0.0 ? cube[4] : cube[5]);
}
`;

/**
 * Derivative tangent frame: the fleet GLBs carry no tangent attribute, so the
 * normal map is decoded against screen-space derivatives (three's own
 * cotangent_frame trick, renamed to avoid collisions).
 */
export const TANGENT_FRAME_GLSL = /* glsl */ `
mat3 ocTangentFrame(vec3 N, vec3 p, vec2 uv) {
  vec3 dp1 = dFdx(p);
  vec3 dp2 = dFdy(p);
  vec2 duv1 = dFdx(uv);
  vec2 duv2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N);
  vec3 dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
  return mat3(T * invmax, B * invmax, N);
}

vec3 ocApplyNormalMap(sampler2D map, vec2 uv, vec3 N, vec3 p) {
  vec3 t = texture2D(map, uv).xyz * 2.0 - 1.0;
  return normalize(ocTangentFrame(N, p, uv) * t);
}
`;
