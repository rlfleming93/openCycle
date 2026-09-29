import * as THREE from 'three';

/**
 * Analytic sphere bodies. A mesh silhouette is a polygon: at the horizon
 * giant's angular radius (~21 deg) even a 20k-triangle icosphere shows straight
 * limb segments at 4K. This renders a camera-facing quad and ray-intersects the
 * sphere in the fragment shader instead, so the limb is exactly round at any
 * resolution, and writes the true hit depth so the ring's far side and the
 * atmosphere still sort against it.
 *
 * Sizes are set in world units through `setSphere(center, radius)`.
 */
export const SPHERE_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
varying vec3 vView;
void main() {
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 centerView = viewMatrix * vec4(uCenter, 1.0);
  float d = max(-centerView.z, uRadius * 1.001);
  float halfExtent = uRadius * d / sqrt(max(d * d - uRadius * uRadius, 1e-4));
  vec3 world = uCenter + (camRight * position.x + camUp * position.y) * halfExtent;
  // View-space corner: interpolated perspective-correctly, so normalize(vView)
  // IS the exact eye ray for this fragment (the sphere can be far off-axis).
  vView = (viewMatrix * vec4(world, 1.0)).xyz;
  gl_Position = projectionMatrix * vec4(vView, 1.0);
}`;

/**
 * Ray-sphere prelude: resolves the hit, the outward normal, the world position
 * and the surface direction for the body's shading function.
 */
export const SPHERE_RAY_GLSL = /* glsl */ `
uniform float uProjA;
uniform float uProjB;

vec3 ocRayRight() { return vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]); }
vec3 ocRayUp() { return vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]); }
vec3 ocRayBack() { return vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]); }

/**
 * Returns false when the fragment misses the sphere (the quad's corners).
 * The ray frame is built from the inverse view basis, so no extra matrices.
 */
bool ocSphereHit(
  vec3 viewPos,
  vec3 center,
  float radius,
  out vec3 worldPos,
  out vec3 normalW,
  out float hitDepth
) {
  vec4 centerView = viewMatrix * vec4(center, 1.0);
  vec3 dirView = normalize(viewPos);
  float b = dot(dirView, centerView.xyz);
  float c = dot(centerView.xyz, centerView.xyz) - radius * radius;
  float disc = b * b - c;
  if (disc <= 0.0) return false;
  float t = b - sqrt(disc);
  if (t <= 0.0) return false;
  vec3 hitView = dirView * t;
  vec3 normalView = normalize(hitView - centerView.xyz);
  vec3 right = ocRayRight();
  vec3 up = ocRayUp();
  vec3 back = ocRayBack();
  normalW = normalize(right * normalView.x + up * normalView.y + back * normalView.z);
  worldPos = cameraPosition + (right * dirView.x + up * dirView.y + back * dirView.z) * t;
  // three's fragment prefix has no projectionMatrix, so the perspective terms
  // arrive as uniforms: clip.z = P22*(-t) + P32, clip.w = t for a sphere.
  hitDepth = 0.5 + 0.5 * ((-uProjA * t + uProjB) / t);
  return true;
}`;

/**
 * Build the impostor material: `surface` is the GLSL body of a function
 *
 *   vec3 ocSurface(vec3 objDir, vec3 N, vec3 V, vec3 worldPos)
 *
 * where `objDir` is the unit direction in the body's own (object) frame — for a
 * sphere that is the outward normal, which is what the procedural band/land
 * fields are keyed from.
 */
export function makeSphereMaterial(
  surface: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...uniforms,
      uCenter: { value: new THREE.Vector3() },
      uRadius: { value: 1 },
      uProjA: { value: -1 },
      uProjB: { value: -1 },
    },
    side: THREE.DoubleSide,
    vertexShader: SPHERE_VERT,
    fragmentShader: /* glsl */ `
uniform vec3 uCenter;
uniform float uRadius;
${SPHERE_RAY_GLSL}
${surface}
varying vec3 vView;
void main() {
  vec3 worldPos;
  vec3 N;
  float depth;
  if (!ocSphereHit(vView, uCenter, uRadius, worldPos, N, depth)) discard;
  vec3 V = normalize(cameraPosition - worldPos);
  gl_FragColor = vec4(ocSurface(N, N, V, worldPos), 1.0);
  gl_FragDepth = depth;
}`,
  });
}
