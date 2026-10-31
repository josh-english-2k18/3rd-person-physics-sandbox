import { Color, type MeshStandardMaterial, type Texture } from 'three';

/**
 * A soft, sky-tinted fresnel rim added to a material's emissive term, brighter on upward-facing
 * surfaces. It lifts dark characters off the background the way a film rim light would, without
 * an extra light in the scene.
 */
const rimmed = new WeakSet<MeshStandardMaterial>();

export function addRimLight(material: MeshStandardMaterial, color = new Color('#bcd6ff'), strength = 0.32): void {
  // Materials are shared between meshes; patch each shader once.
  if (rimmed.has(material)) return;
  rimmed.add(material);
  const uniforms = { uRimColor: { value: color.clone().multiplyScalar(strength) } };
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 rimView = normalize(vViewPosition);
          float rim = pow(1.0 - saturate(dot(normal, rimView)), 3.0);
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          float sky = saturate(dot(normal, upView) * 0.6 + 0.55);
          totalEmissiveRadiance += uRimColor * rim * sky;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'rim-light';
  material.needsUpdate = true;
}

/** Sharper textures at grazing angles. */
export function setAnisotropy(material: MeshStandardMaterial, anisotropy: number): void {
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'] as const) {
    const texture = material[key] as Texture | null;
    if (texture) texture.anisotropy = anisotropy;
  }
}
