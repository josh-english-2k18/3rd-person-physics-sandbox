import { Color, Matrix4, Uniform, Vector3, type PerspectiveCamera } from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

/**
 * UE-style exponential height fog with sun inscattering, applied in the post stack from the depth
 * buffer (before bloom and tone mapping, so it works in linear HDR):
 *
 *   density(h) = d * exp(-falloff * (h - base))
 *
 * integrated analytically along each view ray. Looking toward the sun, the fog takes on the sun's
 * color (directional inscattering); the sky gets fog only near the horizon, where rays stay low.
 */
export class HeightFogEffect extends Effect {
  private readonly camera: PerspectiveCamera;

  constructor(camera: PerspectiveCamera) {
    super('HeightFog', /* glsl */ `
      uniform mat4 uInvProjection;
      uniform mat4 uCameraWorld;
      uniform vec3 uCameraPos;
      uniform vec3 uSunDir;
      uniform vec3 uFogColor;
      uniform vec3 uSunColor;
      uniform float uDensity;
      uniform float uFalloff;
      uniform float uBase;
      uniform float uSkyDistance;
      uniform float uMaxOpacity;

      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 view = uInvProjection * clip;
        view /= view.w;
        vec3 world = (uCameraWorld * vec4(view.xyz, 1.0)).xyz;
        vec3 ray = world - uCameraPos;
        float dist = length(ray);
        vec3 dir = ray / max(dist, 1e-4);
        if (depth >= 0.99999) dist = uSkyDistance;

        // Optical depth of exponential height fog along the ray.
        float h = uCameraPos.y - uBase;
        float k = uFalloff * dir.y * dist;
        float integral = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
        float optical = uDensity * exp(-uFalloff * h) * dist * integral;
        float fog = min(1.0 - exp(-optical), uMaxOpacity);

        float toSun = max(dot(dir, uSunDir), 0.0);
        float scatter = pow(toSun, 6.0) * 0.8 + pow(toSun, 48.0) * 1.6;
        vec3 color = uFogColor + uSunColor * scatter;
        outputColor = vec4(mix(inputColor.rgb, color, fog), inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ['uInvProjection', new Uniform(new Matrix4())],
        ['uCameraWorld', new Uniform(new Matrix4())],
        ['uCameraPos', new Uniform(new Vector3())],
        ['uSunDir', new Uniform(new Vector3(0, 1, 0))],
        ['uFogColor', new Uniform(new Color('#a9b8c8'))],
        ['uSunColor', new Uniform(new Color('#ffd9a8'))],
        ['uDensity', new Uniform(0.012)],
        ['uFalloff', new Uniform(0.09)],
        ['uBase', new Uniform(0)],
        ['uSkyDistance', new Uniform(900)],
        ['uMaxOpacity', new Uniform(0.92)],
      ]),
    });
    this.camera = camera;
  }

  set(options: { fogColor?: Color; sunColor?: Color; sunDirection?: Vector3; density?: number; falloff?: number }): void {
    const u = this.uniforms;
    if (options.fogColor) u.get('uFogColor')!.value.copy(options.fogColor);
    if (options.sunColor) u.get('uSunColor')!.value.copy(options.sunColor);
    if (options.sunDirection) u.get('uSunDir')!.value.copy(options.sunDirection).normalize();
    if (options.density !== undefined) u.get('uDensity')!.value = options.density;
    if (options.falloff !== undefined) u.get('uFalloff')!.value = options.falloff;
  }

  override update(): void {
    const u = this.uniforms;
    u.get('uInvProjection')!.value.copy(this.camera.projectionMatrixInverse);
    u.get('uCameraWorld')!.value.copy(this.camera.matrixWorld);
    u.get('uCameraPos')!.value.setFromMatrixPosition(this.camera.matrixWorld);
  }
}

/**
 * Filmic grade after tone mapping: a gentle S-curve, warm highlights over cool shadows (the
 * UE5 "golden hour" split), and a touch of saturation.
 */
export class GradeEffect extends Effect {
  constructor() {
    super('Grade', /* glsl */ `
      uniform vec3 uShadowTint;
      uniform vec3 uHighlightTint;
      uniform float uContrast;
      uniform float uSaturation;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSaturation);
        c += uShadowTint * (1.0 - smoothstep(0.0, 0.45, l)) + uHighlightTint * smoothstep(0.45, 1.0, l);
        c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
        outputColor = vec4(c, inputColor.a);
      }`, {
      uniforms: new Map<string, Uniform>([
        ['uShadowTint', new Uniform(new Vector3(-0.012, 0.0, 0.018))],
        ['uHighlightTint', new Uniform(new Vector3(0.022, 0.008, -0.014))],
        ['uContrast', new Uniform(0.18)],
        ['uSaturation', new Uniform(1.06)],
      ]),
    });
  }
}
