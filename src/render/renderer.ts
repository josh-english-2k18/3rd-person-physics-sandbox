import {
  ACESFilmicToneMapping,
  Color,
  HalfFloatType,
  HemisphereLight,
  MathUtils,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { GradeEffect, HeightFogEffect } from './atmosphere';
import { loadSky } from './sky';

/** Lighting and look. Tuned for a late-afternoon sun over a grey test level. */
const LOOK = {
  // Placeholder procedural sky (until the HDRI arrives)
  sunElevation: 24, // degrees above the horizon
  sunAzimuth: 128,
  sunColor: '#ffe7c7',
  skyIntensity: 0.32,
  exposure: 1.12,
  /** Once the HDRI sky is in: */
  hdri: { background: 1.0, environment: 1.0 },
  sunIntensity: 3.6,
  /** Sky-to-ground bounce (stands in for GI: cool from above, warm grey from the floor). */
  bounce: { sky: '#cfe2ff', ground: '#6b5f52', intensity: 0.08 },
  /** Exponential height fog (see atmosphere.ts). */
  fog: { color: '#a9b8c8', density: 0.0042, falloff: 0.085, fromHorizon: 0.95 },
  bloom: { intensity: 0.85, threshold: 0.85, smoothing: 0.25, radius: 0.72 },
  /** Cascaded shadows: crisp near the camera, still present across the arena. */
  shadows: {
    cascades: 3,
    mapSize: 2048,
    maxFar: 150,
    /** Cascade ends (m): a tight near cascade gives ~1 cm texels on the operator. */
    splits: [10, 40, 150],
    /** PCF filter radius per cascade (texels): soft penumbrae up close. */
    softness: [3, 2, 1.5],
    bias: -0.00012,
    normalBias: 0.018,
  },
};

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly composer: EffectComposer;
  private readonly csm: CSM;
  private readonly fog: HeightFogEffect;
  private readonly sunDirection = new Vector3();
  private readonly skyMesh: Sky;
  private readonly chromatic: ChromaticAberrationEffect;
  private readonly prepared = new WeakSet<Material>();
  private sweepTimer = 0;
  private lastFov = 0;
  /** 0..1 pulse added to chromatic aberration (explosions, hits). */
  shock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping; // tone mapping happens in the post stack
    this.renderer.toneMappingExposure = LOOK.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 600);

    // Placeholder sky + image-based lighting from it (replaced by the HDRI in useHdri).
    const sky = new Sky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.6;
    u.rayleigh.value = 3.0;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.86;
    this.sunDirection.setFromSphericalCoords(1, MathUtils.degToRad(90 - LOOK.sunElevation), MathUtils.degToRad(LOOK.sunAzimuth));
    u.sunPosition.value.copy(this.sunDirection);
    this.scene.add(sky);
    this.skyMesh = sky;
    const pmrem = new PMREMGenerator(this.renderer);
    const envScene = new Scene();
    envScene.add(sky.clone());
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.renderer.toneMapping = NoToneMapping;
    this.scene.environmentIntensity = LOOK.skyIntensity;
    pmrem.dispose();

    // The sun: one shadow-casting light per cascade.
    const s = LOOK.shadows;
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: s.cascades,
      maxFar: s.maxFar,
      mode: 'custom',
      customSplitsCallback: (count: number, _near: number, far: number, target: number[]) => {
        for (let i = 0; i < count; i++) target.push(Math.min(s.splits[i] ?? far, far) / far);
      },
      shadowMapSize: s.mapSize,
      shadowBias: s.bias,
      lightDirection: this.sunDirection.clone().negate(),
      lightIntensity: LOOK.sunIntensity,
      lightMargin: 80,
    });
    this.csm.fade = true;
    this.csm.lights.forEach((light, i) => {
      light.color.set(LOOK.sunColor);
      light.shadow.normalBias = s.normalBias;
      light.shadow.radius = s.softness[i] ?? 1;
    });
    this.scene.add(new HemisphereLight(LOOK.bounce.sky, LOOK.bounce.ground, LOOK.bounce.intensity));

    // Post: AO -> height fog -> bloom -> tone mapping + grade + vignette/CA -> SMAA
    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const ao = new N8AOPostPass(this.scene, this.camera, window.innerWidth, window.innerHeight);
    ao.configuration.aoRadius = 1.2;
    ao.configuration.distanceFalloff = 0.8;
    ao.configuration.intensity = 2.4;
    ao.configuration.halfRes = false;
    ao.configuration.gammaCorrection = false;
    ao.setQualityMode('High');
    this.composer.addPass(ao);

    this.fog = new HeightFogEffect(this.camera);
    this.fog.set({ fogColor: new Color(LOOK.fog.color), sunColor: new Color(LOOK.sunColor), sunDirection: this.sunDirection, density: LOOK.fog.density, falloff: LOOK.fog.falloff });
    const bloom = new BloomEffect({
      intensity: LOOK.bloom.intensity,
      luminanceThreshold: LOOK.bloom.threshold,
      luminanceSmoothing: LOOK.bloom.smoothing,
      mipmapBlur: true,
      radius: LOOK.bloom.radius,
    });
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.5 });
    this.chromatic = new ChromaticAberrationEffect({ radialModulation: true, modulationOffset: 0.35 });
    this.chromatic.offset.set(0.0003, 0.0003);
    this.composer.addPass(new EffectPass(this.camera, this.fog));
    this.composer.addPass(new EffectPass(this.camera, bloom));
    this.composer.addPass(new EffectPass(this.camera, toneMapping, new GradeEffect(), vignette, this.chromatic));
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));

    window.addEventListener('resize', () => this.resize());
  }

  /** Swaps the procedural placeholder sky for an HDRI, re-deriving the sun and fog from it. */
  async useHdri(url: string): Promise<void> {
    const sky = await loadSky(this.renderer, url);
    this.scene.remove(this.skyMesh);
    this.scene.background = sky.background;
    this.scene.backgroundIntensity = LOOK.hdri.background;
    this.scene.environment?.dispose();
    this.scene.environment = sky.environment;
    this.scene.environmentIntensity = LOOK.hdri.environment;
    this.sunDirection.copy(sky.sunDirection);
    this.csm.lightDirection.copy(sky.sunDirection).negate();
    for (const light of this.csm.lights) light.color.copy(sky.sunColor);
    this.fog.set({ fogColor: sky.horizon.clone().multiplyScalar(LOOK.fog.fromHorizon), sunColor: sky.sunColor.clone().multiplyScalar(1.4), sunDirection: sky.sunDirection });
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.csm.updateFrustums();
  }

  /**
   * Registers every lit material in the scene with the shadow cascades (CSM needs each one patched;
   * an unpatched material would be lit by every cascade light). Chains onto existing
   * onBeforeCompile hooks (grid, rim light). New props, debris and effects are picked up by a
   * periodic sweep.
   */
  private prepareMaterials(root: Object3D): void {
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const lit = material as MeshStandardMaterial;
        if (this.prepared.has(material) || !(lit.isMeshStandardMaterial || (material as { isMeshLambertMaterial?: boolean }).isMeshLambertMaterial)) continue;
        this.prepared.add(material);
        const previous = material.onBeforeCompile;
        this.csm.setupMaterial(material);
        const cascades = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
          previous.call(material, shader, renderer);
          cascades.call(material, shader, renderer);
        };
        material.needsUpdate = true;
      }
    });
  }

  /** Per frame, before rendering: shadow cascades follow the camera. */
  followShadows(_focus: Vector3): void {
    if (this.camera.fov !== this.lastFov) {
      this.lastFov = this.camera.fov;
      this.csm.updateFrustums();
    }
    this.csm.update();
  }

  render(dt: number): void {
    this.sweepTimer -= dt;
    if (this.sweepTimer <= 0) {
      this.sweepTimer = 0.25;
      this.prepareMaterials(this.scene);
    }
    this.shock = Math.max(0, this.shock - dt * 3);
    const ca = 0.0003 + this.shock * 0.004;
    this.chromatic.offset.set(ca, ca);
    this.composer.render(dt);
  }
}
