import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { Card, useUI } from "./ui";

export function ResultCardFrame({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { colors } = useUI();

  return (
    <Card
      style={{
        padding: 0,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: colors.line,
        overflow: "hidden",
        width: "100%",
        maxWidth: 560,
        backgroundColor: colors.card,
        ...style,
      }}
    >
      {children}
    </Card>
  );
}

export function ResultCardFooter({
  title,
  subtitle,
  action,
  icon: Icon,
  onPress,
  expanded,
  tint,
}: {
  title: string;
  subtitle: string;
  action: string;
  icon: LucideIcon;
  onPress: () => void;
  expanded?: boolean;
  tint?: string;
}) {
  const { colors, s } = useUI();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${action}: ${title}`}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      aria-expanded={expanded}
      onPress={onPress}
      style={({ pressed }) => ({
        padding: 16,
        minHeight: 76,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        backgroundColor: pressed ? colors.canvas : colors.card,
      })}
    >
      <View
        style={{
          width: 42,
          height: 46,
          borderRadius: 12,
          backgroundColor: tint ?? colors.sky,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={23} color={colors.blueDark} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={2} style={[s.heading, { fontSize: 16, lineHeight: 21 }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[s.muted, { fontSize: 12, lineHeight: 18 }]}>
          {subtitle} · {action}
        </Text>
      </View>
      {expanded ? (
        <ChevronDown size={19} color={colors.muted} />
      ) : (
        <ChevronRight size={19} color={colors.muted} />
      )}
    </Pressable>
  );
}
