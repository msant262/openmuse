import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { AvatarDesign, AvatarMotionState } from "../../../../packages/domain/src/avatar";

export type AvatarSceneOptions = {
  design: AvatarDesign;
  state?: AvatarMotionState;
  active?: boolean;
  reducedMotion?: boolean;
  interactive?: boolean;
  onFailure?: () => void;
};
export type AvatarSceneController = {
  update: (options: Partial<AvatarSceneOptions>) => void;
  dispose: () => void;
};
type AvatarModel = {
  root: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group[];
  pupils: THREE.Group[];
  mouth: THREE.Mesh;
  tail?: THREE.Group;
  ears: THREE.Group[];
  thought: THREE.Group;
};

function material(color: string, robot = false) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: robot ? 0.3 : 0.63,
    metalness: robot ? 0.18 : 0,
  });
}
function tint(color: string, white: number) {
  return `#${new THREE.Color(color).lerp(new THREE.Color("#ffffff"), white).getHexString()}`;
}

/** Each species has its own silhouette, muzzle, ears, paws and tail, assembled from local meshes. */
export function createAvatarModel(design: AvatarDesign): AvatarModel {
  const root = new THREE.Group();
  const head = new THREE.Group();
  const robot = design.species === "robot";
  const body = material(design.bodyColor, robot);
  const accent = material(design.accentColor, robot);
  const muzzle = material(tint(design.bodyColor, 0.13));
  const dark = material(robot ? "#263B40" : "#302C35");
  const pink = material("#E9ACA7");
  const iris = material(design.eyeColor);
  const glint = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.15 });
  const sphereGeometry = new THREE.SphereGeometry(1, 28, 20);
  const eyes: THREE.Group[] = [];
  const pupils: THREE.Group[] = [];
  const ears: THREE.Group[] = [];
  function ellipsoid(
    parent: THREE.Object3D,
    mat: THREE.Material,
    position: [number, number, number],
    scale: [number, number, number],
  ) {
    const mesh = new THREE.Mesh(sphereGeometry, mat);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    parent.add(mesh);
    return mesh;
  }
  function rounded(
    parent: THREE.Object3D,
    mat: THREE.Material,
    position: [number, number, number],
    size: [number, number, number],
    radius = 0.12,
  ) {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 3, radius), mat);
    mesh.position.set(...position);
    parent.add(mesh);
    return mesh;
  }
  function line(parent: THREE.Object3D, mat: THREE.Material, points: number[][], radius = 0.012) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    );
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, radius, 6, false), mat);
    parent.add(mesh);
    return mesh;
  }
  function pointedEar(x: number, y: number, height: number, width: number, lean: number) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, -0.01);
    pivot.rotation.z = lean;
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.quadraticCurveTo(-width * 0.47, height * 0.58, 0, height);
    shape.quadraticCurveTo(width * 0.47, height * 0.58, width / 2, 0);
    shape.quadraticCurveTo(0, -0.08, -width / 2, 0);
    const ear = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.13,
        bevelEnabled: true,
        bevelThickness: 0.045,
        bevelSize: 0.045,
        bevelSegments: 3,
        curveSegments: 8,
      }),
      body,
    );
    pivot.add(ear);
    const inner = new THREE.Mesh(ear.geometry, design.species === "wolf" ? accent : pink);
    inner.scale.set(0.56, 0.63, 0.34);
    inner.position.set(0, 0.09, 0.143);
    pivot.add(inner);
    head.add(pivot);
    ears.push(pivot);
  }
  const width = design.bodyShape === "round" ? 1.13 : design.bodyShape === "slender" ? 0.86 : 1;
  const height = design.bodyShape === "slender" ? 1.06 : 1;
  if (robot) {
    rounded(root, body, [0, 0.98, 0], [1.04 * width, 1.13 * height, 0.83], 0.21);
    rounded(root, accent, [0, 1.02, 0.42], [0.7 * width, 0.7, 0.07], 0.14);
    ellipsoid(root, iris, [0, 1.08, 0.49], [0.1, 0.1, 0.03]);
    line(
      root,
      dark,
      [
        [-0.15, 0.83, 0.47],
        [0, 0.8, 0.49],
        [0.15, 0.83, 0.47],
      ],
      0.02,
    );
  } else {
    ellipsoid(root, body, [0, 1.04, 0], [0.67 * width, 0.88 * height, 0.57]);
    ellipsoid(root, accent, [0, 1.01, 0.43], [0.39 * width, 0.57, 0.15]);
  }
  // Seated legs and expressive little forepaws.
  for (const side of [-1, 1]) {
    const leg = ellipsoid(root, body, [side * 0.49 * width, 0.34, 0.2], [0.34, 0.27, 0.44]);
    leg.rotation.z = -side * 0.15;
    ellipsoid(root, muzzle, [side * 0.49 * width, 0.28, 0.47], [0.26, 0.14, 0.18]);
    const arm = ellipsoid(root, body, [side * 0.51 * width, 0.94, 0.44], [0.23, 0.46, 0.22]);
    arm.rotation.z = side * 0.14;
    ellipsoid(root, accent, [side * 0.48 * width, 0.61, 0.58], [0.17, 0.14, 0.11]);
    if (!robot)
      for (const offset of [-0.075, 0.075])
        line(
          root,
          muzzle,
          [
            [side * 0.49 * width + offset, 0.31, 0.635],
            [side * 0.49 * width + offset, 0.28, 0.653],
          ],
          0.008,
        );
  }
  head.position.set(0, 2.02, 0.03);
  root.add(head);
  let eyeY = 0.14;
  let eyeX = 0.31;
  let eyeZ = 0.58;
  let mouthY = -0.27;
  let mouthZ = 0.86;
  let tail: THREE.Group | undefined;
  switch (design.species) {
    case "capybara": {
      // A barrel-shaped head, long blunt snout and tiny round ears distinguish the capybara.
      rounded(head, body, [0, 0.08, -0.02], [1.37, 1.01, 1.16], 0.32);
      rounded(head, muzzle, [0, -0.11, 0.55], [1.12, 0.67, 0.87], 0.25);
      ellipsoid(head, body, [0, -0.36, 0.42], [0.52, 0.2, 0.46]);
      for (const side of [-1, 1]) {
        const ear = new THREE.Group();
        ear.position.set(side * 0.57, 0.54, -0.18);
        ellipsoid(ear, body, [0, 0, 0], [0.17, 0.19, 0.12]);
        ellipsoid(ear, muzzle, [0, 0.01, 0.105], [0.085, 0.1, 0.027]);
        head.add(ear);
        ears.push(ear);
        ellipsoid(head, dark, [side * 0.24, -0.055, 0.977], [0.041, 0.031, 0.022]);
      }
      eyeX = 0.49;
      eyeY = 0.23;
      eyeZ = 0.64;
      mouthY = -0.3;
      mouthZ = 0.996;
      break;
    }
    case "wolf":
    case "fox": {
      const fox = design.species === "fox";
      ellipsoid(head, body, [0, 0.08, 0], [fox ? 0.66 : 0.72, 0.58, 0.59]);
      pointedEar(-0.43, 0.4, fox ? 0.72 : 0.63, 0.43, -0.2);
      pointedEar(0.43, 0.4, fox ? 0.72 : 0.63, 0.43, 0.2);
      for (const side of [-1, 1]) {
        ellipsoid(head, accent, [side * 0.32, -0.14, 0.39], [0.32, 0.27, 0.22]);
        const tuft = ellipsoid(head, accent, [side * 0.57, -0.13, 0.18], [0.24, 0.16, 0.2]);
        tuft.rotation.z = side * 0.48;
        const tuft2 = ellipsoid(head, body, [side * 0.64, 0.01, 0.04], [0.19, 0.11, 0.18]);
        tuft2.rotation.z = side * 0.25;
      }
      ellipsoid(head, accent, [0, -0.13, 0.64], [fox ? 0.28 : 0.34, 0.25, 0.32]);
      ellipsoid(head, dark, [0, -0.045, 0.943], [0.12, 0.076, 0.07]);
      ellipsoid(head, glint, [-0.028, -0.012, 0.996], [0.027, 0.012, 0.006]);
      tail = new THREE.Group();
      tail.position.set(0.6 * width, 0.39, -0.26);
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.5, 0.11, -0.1),
        new THREE.Vector3(0.72, 0.45, 0.12),
        new THREE.Vector3(0.75, 0.87, 0.32),
      ]);
      tail.add(
        new THREE.Mesh(new THREE.TubeGeometry(curve, 20, fox ? 0.23 : 0.2, 12, false), body),
      );
      const tip = ellipsoid(tail, accent, [0.74, 0.91, 0.34], [0.215, 0.29, 0.22]);
      tip.rotation.z = 0.13;
      root.add(tail);
      mouthZ = 0.923;
      break;
    }
    case "cat": {
      ellipsoid(head, body, [0, 0.06, 0], [0.75, 0.59, 0.58]);
      pointedEar(-0.49, 0.39, 0.47, 0.43, -0.22);
      pointedEar(0.49, 0.39, 0.47, 0.43, 0.22);
      for (const side of [-1, 1]) {
        ellipsoid(head, accent, [side * 0.18, -0.22, 0.55], [0.22, 0.16, 0.15]);
        for (const y of [-0.12, -0.2, -0.28])
          line(
            head,
            dark,
            [
              [side * 0.4, y, 0.48],
              [side * 0.66, y + 0.02, 0.55],
              [side * 0.86, y + 0.06, 0.44],
            ],
            0.007,
          );
        line(
          head,
          muzzle,
          [
            [side * 0.1, 0.57, 0.16],
            [side * 0.14, 0.46, 0.38],
          ],
          0.045,
        );
      }
      ellipsoid(head, pink, [0, -0.16, 0.706], [0.068, 0.048, 0.03]);
      mouthY = -0.3;
      mouthZ = 0.7;
      eyeX = 0.33;
      tail = new THREE.Group();
      tail.position.set(0.58, 0.38, -0.35);
      line(
        tail,
        body,
        [
          [0, 0, 0],
          [0.43, 0.12, -0.06],
          [0.56, 0.64, 0],
          [0.42, 1.03, 0.18],
          [0.25, 0.97, 0.2],
        ],
        0.095,
      );
      root.add(tail);
      break;
    }
    case "robot": {
      rounded(head, body, [0, 0.08, 0], [1.4, 1.03, 0.93], 0.25);
      rounded(head, dark, [0, 0.08, 0.47], [1.08, 0.72, 0.1], 0.15);
      const antenna = line(
        head,
        dark,
        [
          [0, 0.6, 0],
          [0, 0.9, 0],
        ],
        0.032,
      );
      antenna.name = "antenna";
      ellipsoid(head, iris, [0, 0.94, 0], [0.095, 0.095, 0.095]);
      eyeY = 0.13;
      eyeZ = 0.56;
      mouthY = -0.19;
      mouthZ = 0.555;
      for (const side of [-1, 1]) {
        const ear = new THREE.Group();
        ear.position.set(side * 0.75, 0.05, 0);
        ellipsoid(ear, accent, [0, 0, 0], [0.12, 0.22, 0.22]);
        head.add(ear);
        ears.push(ear);
      }
      break;
    }
  }
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * eyeX, eyeY, eyeZ);
    const radius = design.species === "capybara" ? 0.11 : 0.135;
    ellipsoid(eye, robot ? iris : dark, [0, 0, 0], [radius, radius * 1.13, 0.077]);
    const pupil = new THREE.Group();
    ellipsoid(pupil, iris, [0, 0, 0.06], [radius * 0.69, radius * 0.8, 0.026]);
    ellipsoid(pupil, dark, [0, 0, 0.081], [radius * 0.4, radius * 0.56, 0.011]);
    ellipsoid(pupil, glint, [-0.028, 0.04, 0.095], [0.025, 0.026, 0.013]);
    ellipsoid(pupil, glint, [0.032, -0.031, 0.086], [0.011, 0.011, 0.005]);
    eye.add(pupil);
    head.add(eye);
    eyes.push(eye);
    pupils.push(pupil);
    if (!robot) {
      const brow = ellipsoid(
        head,
        body,
        [side * eyeX, eyeY + radius * 1.37, eyeZ - 0.02],
        [radius * 1.05, 0.033, 0.08],
      );
      brow.rotation.z = side * -0.08;
      ellipsoid(
        head,
        pink,
        [side * (eyeX + 0.02), eyeY - 0.17, eyeZ - 0.03],
        [0.065, 0.028, 0.014],
      );
    }
  }
  // A curved smile remains visible around the tiny animated speaking mouth.
  line(
    head,
    dark,
    [
      [-0.13, mouthY + 0.035, mouthZ],
      [-0.065, mouthY - 0.008, mouthZ + 0.009],
      [0, mouthY - 0.025, mouthZ + 0.015],
      [0.065, mouthY - 0.008, mouthZ + 0.009],
      [0.13, mouthY + 0.035, mouthZ],
    ],
    0.011,
  );
  const mouth = ellipsoid(head, dark, [0, mouthY - 0.013, mouthZ + 0.015], [0.065, 0.008, 0.013]);
  const accessoryColor = material(design.species === "wolf" ? "#D99579" : design.accentColor);
  if (design.accessory === "scarf") {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.12, 10, 36), accessoryColor);
    collar.rotation.x = Math.PI / 2;
    collar.position.set(0, 1.55, 0);
    root.add(collar);
    const loose = rounded(root, accessoryColor, [0.3, 1.25, 0.61], [0.21, 0.56, 0.1], 0.05);
    loose.rotation.z = 0.2;
    rounded(root, accessoryColor, [0.08, 1.41, 0.6], [0.2, 0.39, 0.1], 0.045).rotation.z = -0.17;
  } else if (design.accessory === "glasses") {
    for (const side of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.023, 8, 40), dark);
      ring.position.set(side * eyeX, eyeY, eyeZ + 0.11);
      head.add(ring);
      line(
        head,
        dark,
        [
          [side * (eyeX + 0.18), eyeY, eyeZ + 0.11],
          [side * 0.68, eyeY + 0.02, 0.18],
        ],
        0.018,
      );
    }
    line(
      head,
      dark,
      [
        [-eyeX + 0.18, eyeY, eyeZ + 0.11],
        [0, eyeY + 0.035, eyeZ + 0.15],
        [eyeX - 0.18, eyeY, eyeZ + 0.11],
      ],
      0.02,
    );
  } else if (design.accessory === "leaf") {
    const green = material("#7EAA6F");
    const stem = material("#547B43");
    for (const side of [-1, 1]) {
      const leaf = ellipsoid(head, green, [side * 0.12, 0.72, 0], [0.12, 0.26, 0.025]);
      leaf.rotation.z = side * -0.76;
    }
    line(
      head,
      stem,
      [
        [0, 0.56, 0],
        [0, 0.83, 0.01],
      ],
      0.015,
    );
  } else if (design.accessory === "headphones") {
    line(
      head,
      accessoryColor,
      [
        [-0.79, -0.02, 0],
        [-0.73, 0.56, -0.01],
        [0, 0.73, -0.06],
        [0.73, 0.56, -0.01],
        [0.79, -0.02, 0],
      ],
      0.065,
    );
    for (const side of [-1, 1]) {
      rounded(head, dark, [side * 0.78, 0.015, 0.04], [0.18, 0.43, 0.37], 0.075);
      rounded(head, accessoryColor, [side * 0.89, 0.015, 0.04], [0.08, 0.32, 0.27], 0.035);
    }
  }
  const thought = new THREE.Group();
  for (let n = 0; n < 3; n++)
    ellipsoid(thought, accessoryColor, [(n - 1) * 0.21, 3.42, 0], [0.05, 0.05, 0.05]);
  thought.visible = false;
  root.add(thought);
  return { root, head, eyes, pupils, mouth, tail, ears, thought };
}

export function disposeAvatarObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      geometries.add(child.geometry);
      for (const mat of Array.isArray(child.material) ? child.material : [child.material])
        materials.add(mat);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const mat of materials) mat.dispose();
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
  renderer.toneMappingExposure = 1.12;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:pan-y;";
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 30);
  camera.position.set(0.65, 2.72, 7);
  camera.lookAt(0, 1.62, 0);
  scene.add(new THREE.HemisphereLight("#FFFBF3", "#80769A", 2.7));
  const key = new THREE.DirectionalLight("#fff4df", 3.1);
  key.position.set(-3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#b7dcff", 1.7);
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
    const halfHeight = 1.97;
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
    model.head.position.y = 2.02 + breathing * 0.009;
    model.head.rotation.y = Math.sin(elapsed * 0.63) * 0.045 + pointer.x * 0.13;
    model.head.rotation.z = thinking
      ? Math.sin(elapsed * 0.8) * 0.06 - 0.06
      : Math.sin(elapsed * 0.8) * 0.012;
    model.head.rotation.x = pointer.y * 0.035 + (talking ? Math.sin(elapsed * 6) * 0.022 : 0);
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
    model.thought.visible = thinking;
    model.thought.children.forEach((dot, n) => {
      const scale = 1 + Math.sin(elapsed * 3 - n * 0.8) * 0.25;
      dot.scale.setScalar(0.05 * scale);
      dot.position.y = 3.39 + Math.sin(elapsed * 3 - n * 0.8) * 0.025;
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
    shadowTexture.dispose();
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
      syncAnimation();
    },
    dispose,
  };
}
