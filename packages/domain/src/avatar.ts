import { z } from "zod";

export const avatarSpecies = ["capybara", "wolf", "fox", "cat", "robot"] as const;
export const avatarAccessories = ["none", "scarf", "glasses", "leaf", "headphones"] as const;
export const avatarBodyShapes = ["round", "balanced", "slender"] as const;
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");

/** Appearance is data only. A saved design never carries executable scripts or asset URLs. */
export const avatarDesignSchema = z
  .object({
    version: z.literal(1),
    preset: z.enum([...avatarSpecies, "custom"]),
    species: z.enum(avatarSpecies),
    bodyShape: z.enum(avatarBodyShapes),
    bodyColor: colorSchema,
    accentColor: colorSchema,
    eyeColor: colorSchema,
    accessory: z.enum(avatarAccessories),
  })
  .strict()
  .refine((design) => design.preset === "custom" || design.preset === design.species, {
    message: "The preset must match its species",
    path: ["preset"],
  });
export type AvatarDesign = z.infer<typeof avatarDesignSchema>;
export type AvatarSpecies = AvatarDesign["species"];
export type AvatarAccessory = AvatarDesign["accessory"];
export type AvatarMotionState = "idle" | "thinking" | "talking";

export const AVATAR_PRESETS: readonly AvatarDesign[] = [
  {
    version: 1,
    preset: "capybara",
    species: "capybara",
    bodyShape: "round",
    bodyColor: "#B88A62",
    accentColor: "#F1D9B8",
    eyeColor: "#4D362C",
    accessory: "leaf",
  },
  {
    version: 1,
    preset: "wolf",
    species: "wolf",
    bodyShape: "balanced",
    bodyColor: "#8299AC",
    accentColor: "#EDF4F5",
    eyeColor: "#69CAD8",
    accessory: "scarf",
  },
  {
    version: 1,
    preset: "fox",
    species: "fox",
    bodyShape: "slender",
    bodyColor: "#E58A4F",
    accentColor: "#FFF0D6",
    eyeColor: "#78533A",
    accessory: "none",
  },
  {
    version: 1,
    preset: "cat",
    species: "cat",
    bodyShape: "round",
    bodyColor: "#A29ACB",
    accentColor: "#F0EAFB",
    eyeColor: "#779B76",
    accessory: "glasses",
  },
  {
    version: 1,
    preset: "robot",
    species: "robot",
    bodyShape: "balanced",
    bodyColor: "#AACBC8",
    accentColor: "#F0FAF4",
    eyeColor: "#77E4DD",
    accessory: "headphones",
  },
];
export const DEFAULT_AVATAR_DESIGN: AvatarDesign = AVATAR_PRESETS[0];

/** Older identities only had a background tint; keep them usable with the default 3D character. */
export function resolveAvatarDesign(value: unknown): AvatarDesign {
  const parsed = avatarDesignSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_AVATAR_DESIGN };
}
