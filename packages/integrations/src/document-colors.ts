export function documentColorContrast(first: string, second: string): number {
  const luminance = (value: string) => {
    const hex = value.replace(/^#/, "");
    const channels = [0, 2, 4].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function documentAccentText(
  accent: string,
  backgrounds: string[],
  ink: string,
  large = false,
): string {
  return backgrounds.every(
    (background) => documentColorContrast(accent, background) >= (large ? 3 : 4.5),
  )
    ? accent
    : ink;
}
