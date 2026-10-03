import { Image } from "react-native";
import { subjectIllustration } from "./muse-surfaces-model";

// Bundled Fluent Emoji 3D assets also render on systems without an emoji font.
const illustrations = {
  "🌍": require("./muse-surfaces-globe.png"),
  "🏡": require("./muse-surfaces-home.png"),
  "🌙": require("./muse-surfaces-moon.png"),
  "🍽️": require("./muse-surfaces-dinner.png"),
  "💰": require("./muse-surfaces-money.png"),
  "📋": require("./muse-surfaces-clipboard.png"),
  "💻": require("./muse-surfaces-laptop.png"),
  "✉️": require("./muse-surfaces-envelope.png"),
  "🔎": require("./muse-surfaces-search.png"),
  "🗓️": require("./muse-surfaces-calendar.png"),
  "✨": require("./muse-surfaces-sparkles.png"),
};

export function SubjectIllustration({
  title,
  kind,
  size = 40,
}: {
  title: string;
  kind?: string;
  size?: number;
}) {
  return (
    <Image
      accessible={false}
      source={illustrations[subjectIllustration(title, kind)]}
      style={{ width: size, height: size, resizeMode: "contain", marginTop: 2 }}
    />
  );
}
