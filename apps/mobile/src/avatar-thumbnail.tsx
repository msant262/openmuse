import { Image, type ImageSourcePropType } from "react-native";
import type { AvatarSpecies } from "../../../packages/domain/src/avatar";

const images: Record<AvatarSpecies, ImageSourcePropType> = {
  capybara: require("../assets/avatars/capybara.png"),
  wolf: require("../assets/avatars/wolf.png"),
  fox: require("../assets/avatars/fox.png"),
  cat: require("../assets/avatars/cat.png"),
  robot: require("../assets/avatars/robot.png"),
};

/** Locally captured 3D preset images keep the selector from opening five more GPU contexts. */
export function AvatarThumbnail({
  species,
  size = 100,
}: {
  species: AvatarSpecies;
  size?: number;
}) {
  return (
    <Image
      source={images[species]}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessible={false}
    />
  );
}
