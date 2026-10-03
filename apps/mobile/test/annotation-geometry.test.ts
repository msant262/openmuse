import assert from "node:assert/strict";
import { test } from "node:test";
import { mapPreviewPointToImage, normalizedRegion } from "../src/annotation-geometry.ts";

test("region mapping reverses preview zoom and quarter-turn rotation into artifact coordinates", () => {
  const viewport = { width: 300, height: 300 };
  const image = { width: 1200, height: 600 };
  // Source point (0.2, 0.3) first maps to the contain-fit image, then zoom/rotation.
  // The result proves selection stays anchored to the source through preview transforms.
  const source = { x: 0.2, y: 0.3 };
  const fit = { x: 0.2 * 300, y: 75 + 0.3 * 150 };
  const rotatedZoomed = { x: 150 - (fit.y - 150) * 1.5, y: 150 + (fit.x - 150) * 1.5 };
  const mapped = mapPreviewPointToImage(rotatedZoomed, viewport, image, {
    zoom: 1.5,
    rotation: 90,
  });
  assert.ok(mapped);
  assert.ok(Math.abs(mapped.x - source.x) < 1e-9);
  assert.ok(Math.abs(mapped.y - source.y) < 1e-9);
});

test("normalized annotation regions order drag endpoints and reject empty marks", () => {
  assert.deepEqual(normalizedRegion({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.3 }), {
    x: 0.2,
    y: 0.3,
    width: 0.6,
    height: 0.4,
  });
  assert.equal(normalizedRegion({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), undefined);
});

test("source resolution does not change normalized coordinates", () => {
  const viewport = { width: 320, height: 240 };
  const point = { x: 128, y: 120 };
  const regular = mapPreviewPointToImage(
    point,
    viewport,
    { width: 1600, height: 900 },
    { zoom: 1, rotation: 0 },
  );
  const highResolution = mapPreviewPointToImage(
    point,
    viewport,
    { width: 3840, height: 2160 },
    { zoom: 1, rotation: 0 },
  );
  assert.ok(regular && highResolution);
  assert.ok(Math.abs(regular.x - highResolution.x) < 1e-9);
  assert.ok(Math.abs(regular.y - highResolution.y) < 1e-9);
});
