import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { AvatarDesign } from "../../../../packages/domain/src/avatar";

type Point = [number, number, number];
export type AvatarModel = {
  root: THREE.Group;
  head: THREE.Group;
  headY: number;
  eyes: THREE.Group[];
  pupils: THREE.Group[];
  mouth: THREE.Mesh;
  tail?: THREE.Group;
  ears: THREE.Group[];
  arms: THREE.Group[];
  desk: THREE.Group;
  thought: THREE.Group;
};

/** Seeded fibers make identical saved designs reproducible, including the offline WebView. */
function randomSequence(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Short curved tufts share one geometry per surface, rather than thousands of draw calls. */
function plushFibers(geometry: THREE.BufferGeometry, color: string, count: number, seed: number) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const points = source.getAttribute("position");
  const sourceNormals = source.getAttribute("normal");
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const random = randomSequence(seed);
  const base = new THREE.Color(color);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const n = new THREE.Vector3(),
    p = new THREE.Vector3(),
    tangent = new THREE.Vector3();
  const side = new THREE.Vector3(),
    tip = new THREE.Vector3(),
    middle = new THREE.Vector3();
  const fiberNormal = new THREE.Vector3();
  const weights: number[] = [];
  let area = 0;
  for (let i = 0; i < points.count; i += 3) {
    a.fromBufferAttribute(points, i);
    b.fromBufferAttribute(points, i + 1);
    c.fromBufferAttribute(points, i + 2);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
    weights.push(area);
  }
  function vertex(point: THREE.Vector3, offset: number, light: number) {
    positions.push(point.x + side.x * offset, point.y + side.y * offset, point.z + side.z * offset);
    normals.push(fiberNormal.x, fiberNormal.y, fiberNormal.z);
    colors.push(base.r * light, base.g * light, base.b * light);
  }
  for (let hair = 0; hair < count; hair++) {
    const target = random() * area;
    let lo = 0,
      hi = weights.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weights[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const index = lo * 3;
    const u = Math.sqrt(random()),
      v = random();
    a.fromBufferAttribute(points, index);
    b.fromBufferAttribute(points, index + 1);
    c.fromBufferAttribute(points, index + 2);
    p.copy(a)
      .multiplyScalar(1 - u)
      .addScaledVector(b, u * (1 - v))
      .addScaledVector(c, u * v);
    a.fromBufferAttribute(sourceNormals, index);
    b.fromBufferAttribute(sourceNormals, index + 1);
    c.fromBufferAttribute(sourceNormals, index + 2);
    n.copy(a)
      .multiplyScalar(1 - u)
      .addScaledVector(b, u * (1 - v))
      .addScaledVector(c, u * v)
      .normalize();
    tangent
      .set(random() - 0.5, random() - 0.7, random() - 0.5)
      .addScaledVector(n, -tangent.dot(n))
      .normalize();
    side.crossVectors(n, tangent).normalize();
    fiberNormal.copy(n).addScaledVector(tangent, 0.6).normalize();
    const length = 0.022 + random() * 0.026;
    const width = 0.003 + random() * 0.002;
    const shade = 0.88 + random() * 0.25;
    p.addScaledVector(n, -0.003);
    middle
      .copy(p)
      .addScaledVector(n, length * 0.6)
      .addScaledVector(tangent, length * 0.18);
    tip
      .copy(p)
      .addScaledVector(n, length)
      .addScaledVector(tangent, length * 0.55);
    vertex(p, -width, shade * 0.96);
    vertex(p, width, shade * 0.96);
    vertex(middle, width * 0.6, shade);
    vertex(p, -width, shade * 0.96);
    vertex(middle, width * 0.6, shade);
    vertex(middle, -width * 0.6, shade);
    vertex(middle, -width * 0.6, shade);
    vertex(middle, width * 0.6, shade);
    vertex(tip, 0, shade * 1.08);
  }
  source.dispose();
  const fibers = new THREE.BufferGeometry();
  fibers.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  fibers.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  fibers.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return fibers;
}

/** Original plush companions. No remote models, texture downloads, or copied character assets. */
export function createAvatarModel(design: AvatarDesign): AvatarModel {
  const root = new THREE.Group(),
    head = new THREE.Group();
  const eyes: THREE.Group[] = [],
    pupils: THREE.Group[] = [],
    ears: THREE.Group[] = [],
    arms: THREE.Group[] = [];
  const robot = design.species === "robot";
  const body = new THREE.MeshPhysicalMaterial({
    color: design.bodyColor,
    roughness: robot ? 0.32 : 0.96,
    clearcoat: robot ? 0.42 : 0,
    sheen: robot ? 0 : 0.45,
    sheenRoughness: 1,
    sheenColor: "#FFF5E6",
  });
  const accent = new THREE.MeshPhysicalMaterial({
    color: design.accentColor,
    roughness: 0.96,
    sheen: 0.45,
    sheenRoughness: 1,
    sheenColor: "#FFFFFF",
  });
  const ink = new THREE.MeshPhysicalMaterial({
    color: "#16151C",
    roughness: 0.19,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const stitch = new THREE.MeshStandardMaterial({ color: "#473339", roughness: 0.9 });
  const noseMaterial = new THREE.MeshPhysicalMaterial({
    color: robot ? design.eyeColor : "#423038",
    roughness: 0.36,
    clearcoat: 0.4,
  });
  const rose = new THREE.MeshStandardMaterial({ color: "#E7A198", roughness: 1 });
  const light = new THREE.MeshBasicMaterial({ color: "#FFFCF4" });
  const iris = new THREE.MeshPhysicalMaterial({
    color: design.eyeColor,
    roughness: 0.2,
    clearcoat: 1,
  });
  const fiberMaterial = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 1,
    side: THREE.FrontSide,
    sheen: 0.45,
    sheenRoughness: 1,
    sheenColor: "#FFF5E6",
  });
  fiberMaterial.side = THREE.DoubleSide;
  // Hair ribbons are lit using the groom's outward normal on both faces. Flipping it on the
  // reverse face produces black speckles instead of the soft reflected light of short plush.
  fiberMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <normal_fragment_begin>",
      THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""),
    );
  };
  fiberMaterial.customProgramCacheKey = () => "okami-plush-outward-normal-v1";
  const noise = randomSequence(42);
  const textile = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < 128 * 128; i++) {
    const value = Math.round(105 + noise() * 65);
    textile.set([value, value, value, 255], i * 4);
  }
  const textileTexture = new THREE.DataTexture(textile, 128, 128);
  textileTexture.wrapS = textileTexture.wrapT = THREE.RepeatWrapping;
  textileTexture.repeat.set(2, 2);
  textileTexture.magFilter = THREE.LinearFilter;
  textileTexture.minFilter = THREE.LinearMipmapLinearFilter;
  textileTexture.generateMipmaps = true;
  textileTexture.needsUpdate = true;
  if (!robot) {
    body.bumpMap = textileTexture;
    body.bumpScale = 0.035;
  }
  accent.bumpMap = textileTexture;
  accent.bumpScale = 0.025;
  let seed = 10;
  function shape(
    parent: THREE.Object3D,
    mat: THREE.Material,
    at: Point,
    geometry: THREE.BufferGeometry,
    fibers = 0,
    color = design.bodyColor,
  ) {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(...at);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (fibers) {
      const fuzz = new THREE.Mesh(plushFibers(geometry, color, fibers, seed++), fiberMaterial);
      fuzz.name = "plush-fibers";
      mesh.add(fuzz);
    }
    parent.add(mesh);
    return mesh;
  }
  function oval(
    parent: THREE.Object3D,
    mat: THREE.Material,
    at: Point,
    size: Point,
    fibers = 0,
    color = design.bodyColor,
  ) {
    const geometry = new THREE.SphereGeometry(1, 36, 28);
    geometry.scale(...size);
    return shape(parent, mat, at, geometry, fibers, color);
  }
  function box(
    parent: THREE.Object3D,
    mat: THREE.Material,
    at: Point,
    size: Point,
    radius: number,
    fibers = 0,
    color = design.bodyColor,
  ) {
    return shape(parent, mat, at, new RoundedBoxGeometry(...size, 5, radius), fibers, color);
  }
  function thread(parent: THREE.Object3D, mat: THREE.Material, points: Point[], radius = 0.012) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    return shape(parent, mat, [0, 0, 0], new THREE.TubeGeometry(curve, 24, radius, 6, false));
  }
  const width = design.bodyShape === "round" ? 1.08 : design.bodyShape === "slender" ? 0.88 : 1;
  const headY = 1.81;
  head.position.set(0, headY, 0);
  root.add(head);
  if (robot) {
    box(root, body, [0, 0.84, 0], [1.02 * width, 1.09, 0.77], 0.25);
    box(root, accent, [0, 0.89, 0.393], [0.57, 0.59, 0.045], 0.12);
    oval(root, iris, [0, 0.94, 0.43], [0.083, 0.083, 0.027]);
  } else {
    oval(root, body, [0, 0.86, 0], [0.62 * width, 0.77, 0.51], 5200);
    oval(root, accent, [0, 0.88, 0.388], [0.38 * width, 0.52, 0.16], 2200, design.accentColor);
  }
  for (const side of [-1, 1]) {
    const foot = oval(
      root,
      body,
      [side * 0.41 * width, 0.23, 0.25],
      [0.31, 0.22, 0.39],
      robot ? 0 : 1000,
    );
    foot.rotation.y = side * 0.16;
    const arm = new THREE.Group();
    arm.position.set(side * 0.48 * width, 1.18, 0.06);
    arm.rotation.z = side * 0.16;
    oval(arm, body, [side * 0.07, -0.29, 0.05], [0.22, 0.4, 0.24], robot ? 0 : 1500);
    oval(
      arm,
      accent,
      [side * 0.07, -0.55, 0.13],
      [0.155, 0.135, 0.17],
      robot ? 0 : 450,
      design.accentColor,
    );
    arms.push(arm);
    root.add(arm);
  }
  let eyeX = 0.33,
    eyeY = 0.065,
    eyeZ = 0.57,
    mouthY = -0.22,
    mouthZ = 0.695;
  let tail: THREE.Group | undefined;
  function ear(side: number, pointed: boolean, tall = 0.46) {
    const group = new THREE.Group();
    group.position.set(side * (pointed ? 0.47 : 0.54), pointed ? 0.43 : 0.45, -0.055);
    group.rotation.z = side * -0.27;
    if (pointed) {
      const geometry = new THREE.SphereGeometry(1, 28, 24);
      const position = geometry.getAttribute("position");
      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        const taper = 0.7 - y * 0.26;
        position.setXYZ(
          i,
          position.getX(i) * 0.3 * taper,
          y * tall,
          position.getZ(i) * 0.17 * taper,
        );
      }
      geometry.computeVertexNormals();
      shape(group, body, [0, tall * 0.32, 0], geometry, 1100);
      oval(
        group,
        accent,
        [0, tall * 0.3, 0.1],
        [0.093, tall * 0.62, 0.045],
        450,
        design.accentColor,
      );
    } else {
      oval(group, body, [0, 0, 0], [0.18, 0.2, 0.125], 600);
      oval(group, accent, [0, 0, 0.105], [0.092, 0.115, 0.04], 240, design.accentColor);
    }
    ears.push(group);
    head.add(group);
  }
  if (design.species === "capybara") {
    box(head, body, [0, 0, 0], [1.46, 1.14, 1.08], 0.46, 8800);
    box(head, body, [0, -0.175, 0.435], [1.19, 0.63, 0.69], 0.275, 5100);
    ear(-1, false);
    ear(1, false);
    eyeX = 0.47;
    eyeY = 0.14;
    eyeZ = 0.51;
    mouthY = -0.345;
    mouthZ = 0.796;
    for (const side of [-1, 1])
      oval(head, noseMaterial, [side * 0.2, -0.105, 0.781], [0.033, 0.022, 0.017]);
  } else if (robot) {
    box(head, body, [0, 0.04, 0], [1.46, 1.16, 0.99], 0.34);
    const screen = new THREE.MeshPhysicalMaterial({
      color: "#203C41",
      roughness: 0.23,
      clearcoat: 1,
    });
    box(head, screen, [0, 0.035, 0.47], [1.15, 0.83, 0.105], 0.25);
    eyeZ = 0.553;
    mouthZ = 0.544;
    for (const side of [-1, 1]) oval(head, accent, [side * 0.76, 0.02, 0], [0.11, 0.2, 0.19]);
    thread(
      head,
      body,
      [
        [0, 0.56, 0],
        [0.02, 0.77, 0],
      ],
      0.035,
    );
    oval(head, iris, [0.02, 0.81, 0], [0.075, 0.075, 0.075]);
  } else {
    const fox = design.species === "fox",
      cat = design.species === "cat";
    oval(head, body, [0, 0, 0], [0.76, 0.66, 0.59], 10500);
    ear(-1, true, cat ? 0.29 : fox ? 0.45 : 0.37);
    ear(1, true, cat ? 0.29 : fox ? 0.45 : 0.37);
    for (const side of [-1, 1]) {
      const cheek = oval(
        head,
        accent,
        [side * 0.3, -0.235, 0.405],
        [0.345, 0.28, 0.23],
        1600,
        design.accentColor,
      );
      cheek.rotation.z = side * 0.2;
    }
    oval(
      head,
      accent,
      [0, -0.235, 0.566],
      [0.275, 0.205, cat ? 0.16 : 0.23],
      1300,
      design.accentColor,
    );
    oval(
      head,
      cat ? rose : noseMaterial,
      [0, -0.155, cat ? 0.727 : 0.801],
      [cat ? 0.06 : 0.096, 0.052, 0.047],
    );
    eyeX = cat ? 0.345 : 0.34;
    eyeY = 0.09;
    eyeZ = 0.56;
    mouthY = -0.31;
    mouthZ = cat ? 0.731 : 0.798;
    tail = new THREE.Group();
    tail.position.set(0.44 * width, 0.32, -0.25);
    const tailShape = oval(
      tail,
      body,
      [0.4, 0.17, -0.02],
      cat ? [0.14, 0.62, 0.15] : [0.3, 0.54, 0.3],
      cat ? 1800 : 2600,
    );
    tailShape.rotation.z = -0.7;
    if (!cat) oval(tail, accent, [0.68, 0.47, -0.02], [0.2, 0.22, 0.23], 950, design.accentColor);
    root.add(tail);
  }
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * eyeX, eyeY, eyeZ);
    // Inset button eyes: dark silhouette, small color crescent, a single broad studio reflection.
    oval(eye, robot ? iris : ink, [0, 0, 0], [0.118, robot ? 0.135 : 0.144, 0.075]);
    const pupil = new THREE.Group();
    if (!robot) oval(pupil, iris, [0.012, -0.043, 0.061], [0.057, 0.034, 0.014]);
    oval(pupil, ink, [0, 0.002, 0.059], [0.08, 0.096, 0.02]);
    oval(pupil, light, [-0.029, 0.042, 0.078], [0.033, 0.034, 0.009]);
    oval(pupil, light, [0.037, -0.052, 0.073], [0.012, 0.013, 0.006]);
    eye.add(pupil);
    head.add(eye);
    eyes.push(eye);
    pupils.push(pupil);
    if (!robot)
      oval(head, rose, [side * (eyeX + 0.075), eyeY - 0.19, eyeZ - 0.012], [0.085, 0.043, 0.017]);
  }
  thread(
    head,
    robot ? iris : stitch,
    [
      [-0.095, mouthY + 0.024, mouthZ],
      [-0.04, mouthY - 0.008, mouthZ + 0.014],
      [0.025, mouthY - 0.011, mouthZ + 0.014],
      [0.095, mouthY + 0.024, mouthZ],
    ],
    0.01,
  );
  const mouth = oval(
    head,
    robot ? iris : stitch,
    [0, mouthY - 0.004, mouthZ + 0.014],
    [0.039, 1, 0.011],
  );
  mouth.scale.y = 0.009;
  const accessoryColor = design.preset === "wolf" ? "#C58B76" : design.accentColor;
  const accessory = new THREE.MeshStandardMaterial({
    color: accessoryColor,
    roughness: 0.92,
  });
  if (design.accessory === "scarf") {
    const geometry = new THREE.TorusGeometry(0.405, 0.125, 14, 56);
    geometry.rotateX(Math.PI / 2);
    shape(root, accessory, [0, 1.35, 0.05], geometry, 1700, accessoryColor);
    const end = box(
      root,
      accessory,
      [0.22, 1.08, 0.5],
      [0.24, 0.49, 0.105],
      0.047,
      850,
      accessoryColor,
    );
    end.rotation.z = -0.17;
    for (let i = 0; i < 5; i++)
      thread(
        root,
        accent,
        [
          [0.12 + i * 0.041, 0.87, 0.553],
          [0.14 + i * 0.041, 1.27, 0.553],
        ],
        0.006,
      );
  } else if (design.accessory === "glasses") {
    const frame = new THREE.MeshStandardMaterial({
      color: "#766353",
      roughness: 0.3,
      metalness: 0.65,
    });
    for (const side of [-1, 1]) {
      shape(
        head,
        frame,
        [side * eyeX, eyeY, eyeZ + 0.11],
        new THREE.TorusGeometry(0.191, 0.015, 8, 48),
      );
      thread(
        head,
        frame,
        [
          [side * (eyeX + 0.19), eyeY, eyeZ + 0.11],
          [side * 0.71, eyeY + 0.04, 0.08],
        ],
        0.013,
      );
    }
    thread(
      head,
      frame,
      [
        [-eyeX + 0.19, eyeY, eyeZ + 0.11],
        [0, eyeY + 0.04, eyeZ + 0.15],
        [eyeX - 0.19, eyeY, eyeZ + 0.11],
      ],
      0.014,
    );
  } else if (design.accessory === "leaf") {
    const green = new THREE.MeshStandardMaterial({ color: "#7D9767", roughness: 0.91 });
    for (const side of [-1, 1]) {
      const leaf = oval(head, green, [side * 0.095, 0.64, 0.04], [0.075, 0.19, 0.03]);
      leaf.rotation.z = side * -0.85;
      thread(
        head,
        accent,
        [
          [side * 0.045, 0.585, 0.07],
          [side * 0.18, 0.71, 0.07],
        ],
        0.004,
      );
    }
  } else if (design.accessory === "headphones") {
    thread(
      head,
      accessory,
      [
        [-0.76, 0, 0],
        [-0.73, 0.52, 0],
        [0, 0.76, -0.03],
        [0.73, 0.52, 0],
        [0.76, 0, 0],
      ],
      0.052,
    );
    for (const side of [-1, 1]) {
      box(head, ink, [side * 0.76, 0.01, 0.01], [0.15, 0.38, 0.34], 0.07);
      box(head, accessory, [side * 0.855, 0.01, 0.01], [0.06, 0.29, 0.26], 0.025);
    }
  }
  const desk = new THREE.Group();
  const aluminum = new THREE.MeshStandardMaterial({
    color: "#D9D9D3",
    roughness: 0.48,
    metalness: 0.35,
  });
  const laptop = box(desk, aluminum, [0, 0.7, 0.94], [1.27, 0.81, 0.06], 0.065);
  laptop.rotation.x = -0.18;
  box(desk, aluminum, [0, 0.31, 0.67], [1.28, 0.052, 0.7], 0.02);
  oval(desk, accent, [0, 0.72, 0.978], [0.055, 0.065, 0.005]);
  desk.visible = false;
  root.add(desk);
  const thought = new THREE.Group();
  for (let i = 0; i < 3; i++)
    oval(thought, accessory, [(i - 1) * 0.16, 3.13, 0], [0.035, 0.035, 0.035]);
  thought.visible = false;
  root.add(thought);
  return { root, head, headY, eyes, pupils, mouth, ears, arms, tail, desk, thought };
}
