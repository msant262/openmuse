import { ArrowUpRight, Brain, Heart, Pencil } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { useUI } from "./ui";

export function AgentIdentityPanel({
  name,
  onCustomize,
  onOpen,
}: {
  name: string;
  onCustomize: () => void;
  onOpen: (type: "agent-soul" | "agent-memory") => void;
}) {
  const { t } = useI18n();
  const { colors, s } = useUI();
  return (
    <View style={{ gap: 20 }}>
      <View style={{ backgroundColor: colors.subtle, borderRadius: 22, padding: 18, gap: 14 }}>
        <Text style={[s.heading, { fontSize: 19 }]}>{name}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Edit companion")}
          onPress={onCustomize}
          style={{
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 8,
            minHeight: 42,
            borderRadius: 22,
            backgroundColor: colors.card,
          }}
        >
          <Pencil size={15} color={colors.text} />
          <Text style={[s.text, { fontWeight: "600", fontSize: 14 }]}>{t("Edit companion")}</Text>
        </Pressable>
      </View>
      <View style={{ gap: 7 }}>
        <Text style={[s.label, { fontSize: 10 }]}>{t("Inside your assistant")}</Text>
        <Text style={s.muted}>{t("Shape how I respond and what I remember.")}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 12 }}>
        {(
          [
            {
              type: "agent-soul",
              title: "SOUL",
              subtitle: "Personality",
              action: "Edit SOUL",
              color: colors.soul,
              Icon: Heart,
            },
            {
              type: "agent-memory",
              title: "MEMORY",
              subtitle: "Memory",
              action: "Edit memory",
              color: colors.memory,
              Icon: Brain,
            },
          ] as const
        ).map(({ type, title, subtitle, action, color, Icon }) => (
          <Pressable
            key={type}
            accessibilityRole="button"
            accessibilityLabel={t(action)}
            onPress={() => onOpen(type)}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              minHeight: 180,
              borderRadius: 22,
              padding: 16,
              backgroundColor: color,
              overflow: "hidden",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                width: 145,
                height: 145,
                borderRadius: 73,
                right: -60,
                bottom: -45,
                backgroundColor: "rgba(255,255,255,0.08)",
              }}
            />
            <Text
              style={{
                color: colors.onFeature,
                fontSize: 19,
                fontWeight: "700",
                letterSpacing: -0.5,
              }}
            >
              {title}
            </Text>
            <Text
              style={{
                color: colors.onFeature,
                opacity: 0.88,
                fontSize: 12,
                lineHeight: 18,
                marginTop: 5,
              }}
            >
              {t(subtitle)}
            </Text>
            <View style={{ flex: 1, minHeight: 30 }} />
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <Icon size={21} color={colors.onFeature} strokeWidth={1.6} />
              <ArrowUpRight size={19} color={colors.onFeature} />
            </View>
          </Pressable>
        ))}
      </View>
      <Text style={s.small}>{t("Open to read, edit or review previous changes.")}</Text>
    </View>
  );
}
