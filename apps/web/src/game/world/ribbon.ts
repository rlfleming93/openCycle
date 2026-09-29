import * as THREE from 'three';

/**
 * A camera-facing quad strip. Additive, dynamic, one draw call: the tether and
 * the probe trail both need a ribbon that stays a readable width on screen
 * without a geometry rebuild per frame, so they share this.
 *
 * Vertices are rebuilt in place each `setPath` (no allocation after
 * construction); callers pass world half-widths computed from the camera's
 * projection scale, so a ribbon keeps its on-screen thickness.
 */
export class Ribbon {
  readonly object: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geo: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly alphas: Float32Array;
  private readonly sides: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly sideAttr: THREE.BufferAttribute;
  private readonly points: number;
  private readonly tangent = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly nextDelta = new THREE.Vector3();
  private readonly point = new THREE.Vector3();

  constructor(points: number, baseOpacity = 0.85) {
    if (points < 2) throw new Error('Ribbon needs at least two points');
    this.points = points;
    this.positions = new Float32Array(points * 2 * 3);
    this.colors = new Float32Array(points * 2 * 3);
    this.alphas = new Float32Array(points * 2);
    this.sides = new Float32Array(points * 2);
    for (let i = 0; i < points; i++) {
      this.sides[i * 2] = 0;
      this.sides[i * 2 + 1] = 1;
    }
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1);
    this.sideAttr = new THREE.BufferAttribute(this.sides, 1);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.posAttr);
    this.geo.setAttribute('aColor', this.colAttr);
    this.geo.setAttribute('aAlpha', this.alphaAttr);
    this.geo.setAttribute('aSide', this.sideAttr);
    const index: number[] = [];
    for (let i = 0; i < points - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    this.geo.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: baseOpacity },
        uFeather: { value: 0.4 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSide;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAcross;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vAcross = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uFeather;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vAcross;
        void main() {
          // Soft across-the-ribbon falloff so the edges never read as a bar.
          float edge = smoothstep(0.0, uFeather, vAcross) * (1.0 - smoothstep(1.0 - uFeather, 1.0, vAcross));
          float a = uOpacity * vAlpha * (0.3 + 0.7 * edge);
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(this.geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 7;
    this.object.visible = false;
  }

  /**
   * Rebuild the ribbon along `path` (flat xyz, `points` entries). `halfWidths`
   * gives the world half-width per point (a one-element array stays constant).
   */
  setPath(
    path: Float32Array,
    halfWidths: Float32Array,
    cameraPosition: THREE.Vector3,
    colorA: THREE.Color,
    colorB: THREE.Color | null,
    alphaStart: number,
    alphaEnd: number,
  ): void {
    const n = this.points;
    for (let i = 0; i < n; i++) {
      const x = path[i * 3]!;
      const y = path[i * 3 + 1]!;
      const z = path[i * 3 + 2]!;
      this.tangent.set(0, 0, 0);
      if (i > 0) {
        this.tangent.set(
          x - path[(i - 1) * 3]!,
          y - path[(i - 1) * 3 + 1]!,
          z - path[(i - 1) * 3 + 2]!,
        );
      }
      if (i < n - 1) {
        this.nextDelta.set(
          path[(i + 1) * 3]! - x,
          path[(i + 1) * 3 + 1]! - y,
          path[(i + 1) * 3 + 2]! - z,
        );
        this.tangent.add(this.nextDelta);
      }
      if (this.tangent.lengthSq() < 1e-8) this.tangent.set(0, 0, 1);
      this.view.copy(cameraPosition).sub(this.point.set(x, y, z)).normalize();
      this.side.crossVectors(this.tangent, this.view);
      if (this.side.lengthSq() < 1e-8) this.side.set(0, 1, 0);
      this.side.normalize().multiplyScalar(halfWidths[Math.min(i, halfWidths.length - 1)]!);
      const t = i / (n - 1);
      const a = alphaStart + (alphaEnd - alphaStart) * t;
      for (let s = 0; s < 2; s++) {
        const sign = s === 0 ? -1 : 1;
        const o = (i * 2 + s) * 3;
        this.positions[o] = x + this.side.x * sign;
        this.positions[o + 1] = y + this.side.y * sign;
        this.positions[o + 2] = z + this.side.z * sign;
        this.colors[o] = colorB === null ? colorA.r : colorA.r + (colorB.r - colorA.r) * t;
        this.colors[o + 1] = colorB === null ? colorA.g : colorA.g + (colorB.g - colorA.g) * t;
        this.colors[o + 2] = colorB === null ? colorA.b : colorA.b + (colorB.b - colorA.b) * t;
        this.alphas[i * 2 + s] = a;
      }
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
