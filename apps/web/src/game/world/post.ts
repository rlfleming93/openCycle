import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Post chain: scene → UnrealBloom (strength 0.5, radius 0.5, threshold 0.86)
 * → OutputPass (ACES filmic + sRGB, both read from the renderer). Rung 1 of the
 * degradation ladder bypasses the whole chain and renders straight to the
 * canvas; the scene is authored linear either way.
 */
class CountingRenderPass extends RenderPass {
  /** Scene draw calls of the last frame (excludes the post chain's own quads). */
  sceneCalls = 0;

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    renderer.info.reset();
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    this.sceneCalls = renderer.info.render.calls;
  }
}

export class Post {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scenePass: CountingRenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private enabled = true;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    // Draw-call accounting needs one reset per frame, not one per pass.
    renderer.info.autoReset = false;
    this.composer = new EffectComposer(renderer);
    this.scenePass = new CountingRenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.86);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Render one frame; returns the scene's own draw call count. */
  render(): number {
    if (!this.enabled) {
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
      return this.renderer.info.render.calls;
    }
    this.composer.render();
    return this.scenePass.sceneCalls;
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.info.autoReset = true;
  }
}
