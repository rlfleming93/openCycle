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
