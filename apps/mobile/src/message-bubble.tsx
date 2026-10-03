import { Quote } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useI18n } from "./i18n";
import { colors } from "./ui";

/** Quote stays beside the text, without adding a toolbar below every message. */
export function MessageBubble({
  children,
  user,
  contextual,
  onQuote,
}: {
  children: ReactNode;
  user: boolean;
  contextual: boolean;
  onQuote?: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visible = !contextual || hovered || focused;
  return (
    <View
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        paddingLeft: 15,
        paddingRight: onQuote && !contextual ? 38 : 15,
        paddingVertical: 11,
        borderRadius: 23,
        borderBottomRightRadius: user ? 17 : 23,
        borderBottomLeftRadius: user ? 17 : 23,
        backgroundColor: user ? colors.blue : "#EDEDEF",
      }}
    >
      {children}
      {onQuote && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Quote text")}
          {...(Platform.OS === "web" ? { title: t("Quote text") } : {})}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPress={onQuote}
          style={({ pressed }) => ({
            position: "absolute",
            right: contextual ? -36 : 0,
            top: 2,
            width: contextual ? 32 : 38,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            opacity: visible ? (contextual || focused || pressed ? 1 : 0.55) : 0,
            backgroundColor: focused || pressed ? "#FFFFFF" : "transparent",
            borderWidth: focused ? 2 : 0,
            borderColor: "#7D9EBA",
          })}
        >
          <Quote size={14} strokeWidth={1.7} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
