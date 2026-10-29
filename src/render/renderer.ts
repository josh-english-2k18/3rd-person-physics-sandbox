import {
  ACESFilmicToneMapping,
  DirectionalLight,
  FogExp2,
  HalfFloatType,
  HemisphereLight,
  MathUtils,
  NoToneMapping,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
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

/** Lighting and look. Tuned for a late-afternoon sun over a grey test level. */
const LOOK = {
  sunElevation: 24, // degrees above the horizon
  sunAzimuth: 128,
  sunIntensity: 4.2,
  sunColor: '#ffe7c7',
  skyIntensity: 0.32,
  hemisphere: 0.12,
  fog: '#a9b8c8',
  fogDensity: 0.0075,
  bloom: { intensity: 0.9, threshold: 0.82, smoothing: 0.25, radius: 0.7 },
  shadowSize: 4096,
  shadowExtent: 28,
};

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly sun: DirectionalLight;
  readonly composer: EffectComposer;
  private readonly sunDirection = new Vector3();
  private readonly chromatic: ChromaticAberrationEffect;
  /** 0..1 pulse added to chromatic aberration (explosions, hits). */
  shock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping; // tone mapping happens in the post stack
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.camera = new PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.05, 600);

    // Sky + image-based lighting from the same sky.
    const sky = new Sky();
    sky.scale.setScalar(4000);
    const u = sky.material.uniforms;
    u.turbidity.value = 2.6;
    u.rayleigh.value = 3.0;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.86;
    const phi = MathUtils.degToRad(90 - LOOK.sunElevation);
    const theta = MathUtils.degToRad(LOOK.sunAzimuth);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDirection);
    this.scene.add(sky);

    const pmrem = new PMREMGenerator(this.renderer);
    const envScene = new Scene();
    const envSky = sky.clone();
    envScene.add(envSky);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.renderer.toneMapping = NoToneMapping;
    this.scene.environmentIntensity = LOOK.skyIntensity;
    pmrem.dispose();

    this.scene.fog = new FogExp2(LOOK.fog, LOOK.fogDensity);

    this.sun = new DirectionalLight(LOOK.sunColor, LOOK.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(LOOK.shadowSize, LOOK.shadowSize);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -LOOK.shadowExtent;
    cam.right = cam.top = LOOK.shadowExtent;
    cam.near = 1;
    cam.far = 160;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new HemisphereLight('#cfe2ff', '#4d4339', LOOK.hemisphere));

    // Post: AO -> bloom -> tone mapping -> vignette/CA -> SMAA
    this.composer = new EffectComposer(this.renderer, { frameBufferType: HalfFloatType });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const ao = new N8AOPostPass(this.scene, this.camera, window.innerWidth, window.innerHeight);
    ao.configuration.aoRadius = 1.6;
    ao.configuration.distanceFalloff = 0.6;
    ao.configuration.intensity = 2.6;
    ao.configuration.halfRes = true;
    ao.configuration.gammaCorrection = false;
    ao.setQualityMode('Medium');
    this.composer.addPass(ao);

    const bloom = new BloomEffect({
      intensity: LOOK.bloom.intensity,
      luminanceThreshold: LOOK.bloom.threshold,
      luminanceSmoothing: LOOK.bloom.smoothing,
      mipmapBlur: true,
      radius: LOOK.bloom.radius,
    });
    const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.55 });
    this.chromatic = new ChromaticAberrationEffect({ radialModulation: true, modulationOffset: 0.35 });
    this.chromatic.offset.set(0.0004, 0.0004);
    this.composer.addPass(new EffectPass(this.camera, bloom));
    this.composer.addPass(new EffectPass(this.camera, toneMapping, vignette, this.chromatic));
    this.composer.addPass(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.HIGH })));

    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  /** Keeps the sun's shadow frustum centred on the player, snapped to texels to avoid shimmer. */
  followShadows(focus: Vector3): void {
    const texel = (LOOK.shadowExtent * 2) / LOOK.shadowSize;
    const snapped = focus.clone();
    snapped.x = Math.round(snapped.x / texel) * texel;
    snapped.z = Math.round(snapped.z / texel) * texel;
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(this.sunDirection, 80);
  }

  render(dt: number): void {
    this.shock = Math.max(0, this.shock - dt * 3);
    const ca = 0.0004 + this.shock * 0.004;
    this.chromatic.offset.set(ca, ca);
    this.composer.render(dt);
  }
}

