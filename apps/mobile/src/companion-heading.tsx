import { Pressable, Text, View } from "react-native";
import { useAvatarPresentation } from "./avatar-presentation";
import { useI18n } from "./i18n";
import { Mascot, useUI } from "./ui";
export function CompanionHeading({
  name,
  status,
  variant,
  onPress,
}: {
  name: string;
  status: string;
  variant?: "sky" | "sand" | "lilac";
  onPress: () => void;
}) {
  const { colors } = useUI();

  const { t } = useI18n();
  const { state } = useAvatarPresentation();
  const showStatus = state !== "idle" || status !== t("Here when you need me");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Open {name} activity and approvals", { name })}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        maxWidth: "70%",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Mascot size={54} variant={variant} />
      <View
        style={{
          paddingHorizontal: 14,
          paddingVertical: showStatus ? 7 : 8,
          marginTop: -4,
          borderRadius: showStatus ? 20 : 24,
          backgroundColor: colors.card,
          shadowColor: colors.shadow,
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.06,
          shadowRadius: 14,
          alignItems: "center",
          maxWidth: "100%",
        }}
      >
        <Text
          numberOfLines={1}
          style={{ fontSize: 15, fontWeight: "600", color: colors.text, letterSpacing: -0.4 }}
        >
          {name}
        </Text>
        {showStatus && (
          <Text numberOfLines={1} style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
            {state === "talking"
              ? t("Writing to you…")
              : state === "thinking" && status === t("Here when you need me")
                ? t("Thinking it through…")
                : status}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
