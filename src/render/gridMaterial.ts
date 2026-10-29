import { Color, MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';

/**
 * Unreal-style "prototype grid" material: a world-space triplanar grid (fine lines every
 * `cell` meters, bold lines every `major` cells) over a flat base color, with a little roughness
 * breakup so large surfaces catch the light. World-space mapping means any box or ramp tiles
 * consistently without UVs.
 */
export interface GridMaterialOptions extends MeshStandardMaterialParameters {
  color?: Color | string | number;
  lineColor?: Color | string | number;
  cell?: number;
  major?: number;
  lineWidth?: number;
}

export function createGridMaterial(options: GridMaterialOptions = {}): MeshStandardMaterial {
  const { lineColor = '#9aa0a8', cell = 1, major = 4, lineWidth = 0.012, ...params } = options;
  const material = new MeshStandardMaterial({ roughness: 0.82, metalness: 0, ...params });
  const uniforms = {
    uLineColor: { value: new Color(lineColor) },
    uCell: { value: cell },
    uMajor: { value: major },
    uLineWidth: { value: lineWidth },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGridPos;\nvarying vec3 vGridNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 gridWorld = modelMatrix * vec4(transformed, 1.0);
        vGridPos = gridWorld.xyz;
        vGridNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGridPos;
        varying vec3 vGridNormal;
        uniform vec3 uLineColor;
        uniform float uCell;
        uniform float uMajor;
        uniform float uLineWidth;

        float gridLine(vec2 p, float size, float width) {
          vec2 g = p / size;
          vec2 d = fwidth(g);
          vec2 a = abs(fract(g - 0.5) - 0.5) / max(d, vec2(1e-4));
          vec2 w = vec2(width / size) / max(d, vec2(1e-4));
          vec2 l = 1.0 - smoothstep(w, w + 1.0, a);
          return max(l.x, l.y);
        }
        float gridHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gridNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(gridHash(i), gridHash(i + vec2(1, 0)), f.x), mix(gridHash(i + vec2(0, 1)), gridHash(i + vec2(1, 1)), f.x), f.y);
        }
        float gridPlanar(vec2 p) {
          float fine = gridLine(p, uCell, uLineWidth);
          float bold = gridLine(p, uCell * uMajor, uLineWidth * 2.2);
          return max(fine * 0.55, bold);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 gn = abs(normalize(vGridNormal));
        vec3 bw = pow(gn, vec3(8.0));
        bw /= (bw.x + bw.y + bw.z);
        float lines = gridPlanar(vGridPos.zy) * bw.x + gridPlanar(vGridPos.xz) * bw.y + gridPlanar(vGridPos.xy) * bw.z;
        float breakup = gridNoise(vGridPos.xz * 0.35 + vGridPos.y * 0.2) * 0.5 + gridNoise(vGridPos.xz * 2.1) * 0.25;
        diffuseColor.rgb *= 0.92 + breakup * 0.16;
        diffuseColor.rgb = mix(diffuseColor.rgb, uLineColor, lines * 0.85);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor - lines * 0.25 + (breakup - 0.35) * 0.18, 0.05, 1.0);`,
      );
  };
  material.customProgramCacheKey = () => 'grid-material';
  return material;
}
