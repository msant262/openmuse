import assert from "node:assert/strict";
import { test } from "node:test";
import { Mesh, Texture } from "three";
import { AVATAR_PRESETS } from "../../../packages/domain/src/avatar.ts";
import { createAvatarModel, disposeAvatarObject } from "../src/avatar/scene.ts";

test("3D avatar disposal releases each shared geometry and material once", () => {
  for (const design of AVATAR_PRESETS) {
    const model = createAvatarModel(design);
    const geometries = new Map<object, number>();
    const materials = new Map<object, number>();
    const textures = new Map<object, number>();
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
        for (const value of Object.values(material)) {
          if (!(value instanceof Texture) || textures.has(value)) continue;
          textures.set(value, 0);
          value.addEventListener("dispose", () =>
            textures.set(value, (textures.get(value) || 0) + 1),
          );
        }
      }
    });
    assert.ok(geometries.size > 5, design.species);
    assert.ok(materials.size > 3, design.species);
    disposeAvatarObject(model.root);
    assert.ok([...geometries.values()].every((count) => count === 1));
    assert.ok([...materials.values()].every((count) => count === 1));
    assert.ok(textures.size > 0, "locally generated textile texture is tracked");
    assert.ok([...textures.values()].every((count) => count === 1));
  }
});

test("plush companions keep fibers batched and share a bounded render budget", () => {
  for (const design of AVATAR_PRESETS) {
    const model = createAvatarModel(design);
    let meshes = 0;
    let vertices = 0;
    let fibers = 0;
    model.root.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      meshes++;
      vertices += child.geometry.getAttribute("position").count;
      if (child.name === "plush-fibers") fibers++;
    });
    assert.ok(meshes < 80, `${design.species} does not allocate a mesh per hair`);
    assert.ok(vertices < 420_000, `${design.species} keeps the mobile vertex budget`);
    assert.equal(fibers > 0, design.species !== "robot");
    assert.equal(model.desk.visible, false);
    assert.equal(model.arms.length, 2);
    disposeAvatarObject(model.root);
  }
});
