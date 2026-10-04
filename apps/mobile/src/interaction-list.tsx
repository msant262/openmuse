import { ChevronDown, ChevronRight, History } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { InteractionRequest } from "../../../packages/domain/src/runtime";
import { useI18n } from "./i18n";
import { InteractionCard } from "./interaction-card";
import { partitionInteractions } from "./interaction-state";
import { useUI } from "./ui";

export function InteractionList({
  requests,
  onAnswered,
}: {
  requests: InteractionRequest[];
  onAnswered?: () => void;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { pending, history } = partitionInteractions(requests);
  if (!pending.length && !history.length) return null;
  return (
    <View style={{ gap: 12 }}>
      {pending.map((request) => (
        <InteractionCard key={request.id} request={request} onAnswered={onAnswered} />
      ))}
      {history.length > 0 && (
        <View style={{ gap: 10 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Previous questions and answers ({count})", {
              count: history.length,
            })}
            accessibilityState={{ expanded }}
            aria-expanded={expanded}
            onPress={() => setExpanded(!expanded)}
            style={[
              s.row,
              { gap: 8, minHeight: 44, alignSelf: "flex-start", paddingHorizontal: 8 },
            ]}
          >
            <History size={16} color={colors.muted} />
            <Text style={s.small}>
              {t("Previous questions and answers ({count})", { count: history.length })}
            </Text>
            {expanded ? (
              <ChevronDown size={16} color={colors.muted} />
            ) : (
              <ChevronRight size={16} color={colors.muted} />
            )}
          </Pressable>
          {expanded &&
            history.map((request) => <InteractionCard key={request.id} request={request} />)}
        </View>
      )}
    </View>
  );
}
