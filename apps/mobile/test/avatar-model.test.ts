import assert from "node:assert/strict";
import { test } from "node:test";
import { Mesh } from "three";
import { AVATAR_PRESETS } from "../../../packages/domain/src/avatar.ts";
import { createAvatarModel, disposeAvatarObject } from "../src/avatar/scene.ts";

test("3D avatar disposal releases each shared geometry and material once", () => {
  for (const design of AVATAR_PRESETS) {
    const model = createAvatarModel(design);
    const geometries = new Map<object, number>();
    const materials = new Map<object, number>();
    model.root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      if (!geometries.has(child.geometry)) {
        const geometry = child.geometry;
        geometries.set(geometry, 0);
        geometry.addEventListener("dispose", () =>
          geometries.set(geometry, (geometries.get(geometry) || 0) + 1),
        );
      }
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (materials.has(material)) continue;
        materials.set(material, 0);
        material.addEventListener("dispose", () =>
          materials.set(material, (materials.get(material) || 0) + 1),
        );
      }
    });
    assert.ok(geometries.size > 5, design.species);
    assert.ok(materials.size > 3, design.species);
    disposeAvatarObject(model.root);
    assert.ok([...geometries.values()].every((count) => count === 1));
    assert.ok([...materials.values()].every((count) => count === 1));
  }
});
