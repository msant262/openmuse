import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { AvatarDesign, AvatarMotionState } from "../../../../packages/domain/src/avatar";

export type AvatarSceneOptions = {
  design: AvatarDesign;
  state?: AvatarMotionState;
  active?: boolean;
  reducedMotion?: boolean;
  interactive?: boolean;
  framing?: "full" | "portrait";
  onFailure?: () => void;
};
export type AvatarSceneController = {
  update: (options: Partial<AvatarSceneOptions>) => void;
  dispose: () => void;
};
export { createAvatarModel } from "./model";

import { createAvatarModel } from "./model";

export function disposeAvatarObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      geometries.add(child.geometry);
      for (const mat of Array.isArray(child.material) ? child.material : [child.material])
        materials.add(mat);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const mat of materials) {
    for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value);
    mat.dispose();
  }
  for (const texture of textures) texture.dispose();
}

/** A small, self-contained scene with no loaders, network requests, or remote code. */
export function mountAvatarScene(
  host: HTMLElement,
  initial: AvatarSceneOptions,
): AvatarSceneController {
  let options = { state: "idle" as AvatarMotionState, active: true, ...initial };
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.97;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:pan-y;";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const environmentGenerator = new THREE.PMREMGenerator(renderer);
  const studio = new RoomEnvironment();
  const environment = environmentGenerator.fromScene(studio, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.48;
  studio.dispose();
  environmentGenerator.dispose();
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 30);
  camera.position.set(0.88, 2.5, 7);
  camera.lookAt(0, 1.51, 0);
  scene.add(new THREE.HemisphereLight("#FFF9F1", "#A49A99", 0.85));
  const key = new THREE.DirectionalLight("#FFF5E8", 2.3);
  key.position.set(-3, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -2.3;
  key.shadow.camera.right = 2.3;
  key.shadow.camera.top = 3.5;
  key.shadow.camera.bottom = -1;
  key.shadow.normalBias = 0.025;
  key.shadow.bias = -0.0002;
  scene.add(key);
  const fill = new THREE.DirectionalLight("#DDEAFF", 1.2);
  fill.position.set(3, 3, -2);
  scene.add(fill);
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const context = shadowCanvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
    gradient.addColorStop(0, "rgba(58,47,68,0.24)");
    gradient.addColorStop(0.5, "rgba(58,47,68,0.1)");
    gradient.addColorStop(1, "rgba(58,47,68,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.3, 2.3),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.05;
  scene.add(shadow);
  let model = createAvatarModel(options.design);
  scene.add(model.root);
  let disposed = false;
  let intersecting = true;
  let hidden = document.hidden;
  let paused = false;
  let elapsed = 0;
  let previous = 0;
  let lastFrame = 0;
  let yaw = 0;
  const pointer = { x: 0, y: 0 };
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let systemReducedMotion = motionQuery?.matches ?? false;
  const reduced = () => options.reducedMotion ?? systemReducedMotion;
  const render = () => renderer.render(scene, camera);
  function resize() {
    if (disposed) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const aspect = width / height;
    const portrait = options.framing === "portrait";
    const halfHeight = portrait ? 1.22 : 1.75;
    camera.position.set(0.88, portrait ? 2.82 : 2.5, 7);
    camera.lookAt(0, portrait ? 1.95 : 1.51, 0);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }
  function frame(timestamp: number) {
    if (disposed || paused) return;
    // 30 fps is enough for gentle character motion and keeps laptops and WebViews quiet.
    if (timestamp - lastFrame < 32) return;
    lastFrame = timestamp;
    elapsed += previous ? Math.min((timestamp - previous) / 1000, 0.05) : 0;
    previous = timestamp;
    const breathing = Math.sin(elapsed * 1.8);
    const thinking = options.state === "thinking";
    const talking = options.state === "talking";
    model.root.scale.y = 1 + breathing * 0.009;
    model.head.position.y = model.headY + breathing * 0.009;
    model.head.rotation.y = Math.sin(elapsed * 0.63) * 0.045 + pointer.x * 0.13;
    model.head.rotation.z = thinking
      ? Math.sin(elapsed * 1.8) * 0.025
      : Math.sin(elapsed * 0.8) * 0.012;
    model.head.rotation.x =
      pointer.y * 0.035 + (thinking ? 0.13 : talking ? Math.sin(elapsed * 5) * 0.035 : 0);
    model.root.rotation.y += (yaw - model.root.rotation.y) * 0.12;
    const blinkPhase = elapsed % 4.7;
    const blink =
      blinkPhase > 4.42 ? 1 - Math.sin(((blinkPhase - 4.42) / 0.28) * Math.PI) * 0.95 : 1;
    for (const eye of model.eyes) eye.scale.y = blink;
    for (const pupil of model.pupils) {
      pupil.position.x = pointer.x * 0.02 + Math.sin(elapsed * 0.63) * 0.008;
      pupil.position.y = pointer.y * -0.015;
    }
    model.mouth.scale.y = talking ? 0.025 + Math.abs(Math.sin(elapsed * 8)) * 0.067 : 0.008;
    if (model.tail) model.tail.rotation.y = Math.sin(elapsed * (talking ? 3 : 1.3)) * 0.08;
    for (let n = 0; n < model.ears.length; n++) {
      const ear = model.ears[n];
      ear.rotation.x = Math.sin(elapsed * 0.7 + n) * 0.035;
    }
    model.desk.visible = thinking;
    model.thought.visible = thinking;
    model.arms.forEach((arm, n) => {
      const side = n === 0 ? -1 : 1;
      arm.rotation.x = thinking
        ? -0.92 + Math.sin(elapsed * 7 + n * 2) * 0.11
        : talking
          ? -0.12 + Math.sin(elapsed * 3 + n) * 0.08
          : 0;
      arm.rotation.z =
        side * (thinking ? -0.2 : talking ? 0.23 + Math.sin(elapsed * 2.4 + n) * 0.09 : 0.16);
    });
    model.thought.children.forEach((dot, n) => {
      const scale = 1 + Math.sin(elapsed * 3 - n * 0.8) * 0.25;
      dot.scale.setScalar(scale);
      dot.position.y = 3.13 + Math.sin(elapsed * 3 - n * 0.8) * 0.025;
    });
    render();
  }
  function syncAnimation() {
    if (disposed) return;
    paused = !options.active || hidden || !intersecting || reduced();
    previous = 0;
    renderer.setAnimationLoop(paused ? null : frame);
    if (reduced()) {
      model.root.scale.y = 1;
      model.head.rotation.set(0, 0, 0);
      for (const eye of model.eyes) eye.scale.y = 1;
      model.mouth.scale.y = 0.008;
      model.thought.visible = options.state === "thinking";
      model.desk.visible = options.state === "thinking";
      model.arms.forEach((arm, n) => {
        arm.rotation.x = options.state === "thinking" ? -0.92 : 0;
        arm.rotation.z = (n === 0 ? -1 : 1) * (options.state === "thinking" ? -0.2 : 0.16);
      });
    }
    render();
  }
  function onVisibility() {
    hidden = document.hidden;
    syncAnimation();
  }
  function onMotion(event: MediaQueryListEvent) {
    systemReducedMotion = event.matches;
    syncAnimation();
  }
  function onPointer(event: PointerEvent) {
    if (!options.interactive || reduced()) return;
    const box = host.getBoundingClientRect();
    pointer.x = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width - 0.5) * 2));
    pointer.y = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height - 0.5) * 2));
    // Deliberately bounded: inspecting the shape never turns the character away completely.
    yaw = pointer.x * 0.34;
  }
  function resetPointer() {
    pointer.x = 0;
    pointer.y = 0;
    yaw = 0;
  }
  function lostContext(event: Event) {
    event.preventDefault();
    dispose();
    options.onFailure?.();
  }
  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : undefined;
  resizeObserver?.observe(host);
  const intersection =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          ([entry]) => {
            intersecting = entry.isIntersecting;
            syncAnimation();
          },
          { threshold: 0.01 },
        )
      : undefined;
  intersection?.observe(host);
  document.addEventListener("visibilitychange", onVisibility);
  motionQuery?.addEventListener?.("change", onMotion);
  window.addEventListener("resize", resize);
  host.addEventListener("pointermove", onPointer);
  host.addEventListener("pointerleave", resetPointer);
  renderer.domElement.addEventListener("webglcontextlost", lostContext);
  resize();
  syncAnimation();
  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    resizeObserver?.disconnect();
    intersection?.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    motionQuery?.removeEventListener?.("change", onMotion);
    window.removeEventListener("resize", resize);
    host.removeEventListener("pointermove", onPointer);
    host.removeEventListener("pointerleave", resetPointer);
    renderer.domElement.removeEventListener("webglcontextlost", lostContext);
    disposeAvatarObject(scene);
    key.shadow.dispose();
    environment.dispose();
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }
  return {
    update(next) {
      if (disposed) return;
      if (next.design && JSON.stringify(next.design) !== JSON.stringify(options.design)) {
        scene.remove(model.root);
        disposeAvatarObject(model.root);
        model = createAvatarModel(next.design);
        scene.add(model.root);
      }
      options = { ...options, ...next };
      if (next.framing) resize();
      syncAnimation();
    },
    dispose,
  };
}
