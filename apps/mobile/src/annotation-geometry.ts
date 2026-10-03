export type NormalizedRegion = { x: number; y: number; width: number; height: number };
export type PreviewTransform = { zoom: number; rotation: 0 | 90 | 180 | 270 };

/** Maps a point on a transformed contain-fit preview back to the original image. */
export function mapPreviewPointToImage(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  image: { width: number; height: number },
  transform: PreviewTransform,
): { x: number; y: number } | undefined {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0 ||
    transform.zoom < 1 ||
    transform.zoom > 4
  )
    return undefined;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const scaledX = (point.x - centerX) / transform.zoom;
  const scaledY = (point.y - centerY) / transform.zoom;
  const radians = (-transform.rotation * Math.PI) / 180;
  const baseX = centerX + Math.cos(radians) * scaledX - Math.sin(radians) * scaledY;
  const baseY = centerY + Math.sin(radians) * scaledX + Math.cos(radians) * scaledY;
  const fitScale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const fitWidth = image.width * fitScale;
  const fitHeight = image.height * fitScale;
  const left = (viewport.width - fitWidth) / 2;
  const top = (viewport.height - fitHeight) / 2;
  const x = (baseX - left) / fitWidth;
  const y = (baseY - top) / fitHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x: clean(x), y: clean(y) };
}

export function normalizedRegion(
  first: { x: number; y: number },
  second: { x: number; y: number },
): NormalizedRegion | undefined {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x, second.x);
  const bottom = Math.max(first.y, second.y);
  const width = right - x;
  const height = bottom - y;
  if (width < 0.005 || height < 0.005) return undefined;
  return {
    x: clean(x),
    y: clean(y),
    width: clean(width),
    height: clean(height),
  };
}

const clean = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 1e9) / 1e9;
