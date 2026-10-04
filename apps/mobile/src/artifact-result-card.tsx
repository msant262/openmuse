import { Columns3, FileText, ListChecks } from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { AgentArtifact } from "../../../packages/domain/src/agent";
import { artifactPresentation, presentationRecord, type ResultItem } from "./artifact-presentation";
import { AssistantResponse } from "./assistant-response";
import { useI18n } from "./i18n";
import { ResultCardFooter, ResultCardFrame } from "./result-card-frame";
import { Button, ErrorNotice, useUI } from "./ui";

/** The complete saved value remains accessible without a JSON dump in the conversation. */
function ResultDetails({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index + 1), entry] as const)
    : Object.entries(presentationRecord(value) ?? {});
  if (!entries.length)
    return (
      <Text selectable style={s.text}>
        {typeof value === "string" || typeof value === "number"
          ? String(value)
          : typeof value === "boolean"
            ? t(value ? "Yes" : "No")
            : "—"}
      </Text>
    );
  if (depth >= 4 && !expanded)
    return (
      <Button small expanded={expanded} onPress={() => setExpanded(true)}>
        {t("Show details")}
      </Button>
    );
  return (
    <View style={{ gap: 12 }}>
      {entries.map(([key, entry]) => (
        <View
          key={key}
          style={{
            gap: 4,
            paddingLeft: depth ? 12 : 0,
            borderLeftWidth: depth ? 1 : 0,
            borderLeftColor: colors.line,
          }}
        >
          <Text style={[s.small, { fontWeight: "600" }]}>{key.replace(/_/g, " ")}</Text>
          <ResultDetails value={entry} depth={depth + 1} />
        </View>
      ))}
    </View>
  );
}

function Option({ item }: { item: ResultItem }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [error, setError] = useState("");
  return (
    <View
      style={{ gap: 7, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      <View style={[s.row, { alignItems: "flex-start", gap: 12 }]}>
        <Text style={[s.heading, { flex: 1, lineHeight: 22 }]}>{item.title}</Text>
        {item.price && <Text style={[s.text, { fontWeight: "600" }]}>{item.price}</Text>}
      </View>
      {item.detail && <AssistantResponse content={item.detail} />}
      {item.pros.length > 0 && (
        <View style={{ gap: 3 }}>
          <Text style={s.small}>{t("Strengths")}</Text>
          {[...new Set(item.pros)].map((line) => (
            <Text key={line} selectable style={s.text}>
              + {line}
            </Text>
          ))}
        </View>
      )}
      {item.cons.length > 0 && (
        <View style={{ gap: 3 }}>
          <Text style={s.small}>{t("Considerations")}</Text>
          {[...new Set(item.cons)].map((line) => (
            <Text key={line} selectable style={s.text}>
              − {line}
            </Text>
          ))}
        </View>
      )}
      {item.url && (
        <Button
          small
          onPress={() => {
            if (item.url) void Linking.openURL(item.url).catch((cause) => setError(String(cause)));
          }}
        >
          {t("View source")}
        </Button>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}

export function ArtifactResultCard({ artifact }: { artifact: AgentArtifact }) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const presentation = artifactPresentation(artifact);
  const kind =
    artifact.kind === "plan"
      ? t("Plan")
      : artifact.kind === "comparison"
        ? t("Comparison")
        : t("Report");
  const action = expanded
    ? t("Show summary")
    : artifact.kind === "plan"
      ? t("Open plan")
      : artifact.kind === "comparison"
        ? t("Open comparison")
        : t("Open report");
  const Icon =
    artifact.kind === "plan" ? ListChecks : artifact.kind === "comparison" ? Columns3 : FileText;
  const tint =
    artifact.kind === "plan"
      ? colors.green
      : artifact.kind === "comparison"
        ? colors.sky
        : colors.orange;
  const excerpt = presentation.previewExcerpt;
  return (
    <ResultCardFrame>
      {!expanded && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${artifact.title}`}
          aria-expanded={expanded}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(true)}
          style={{ backgroundColor: tint, padding: 22, gap: 12 }}
        >
          <Text style={[s.small, { letterSpacing: 1.1, fontWeight: "600" }]}>
            {kind.toUpperCase()}
          </Text>
          <Text
            numberOfLines={3}
            style={[s.title, { fontSize: 23, lineHeight: 29, letterSpacing: -0.6 }]}
          >
            {artifact.title}
          </Text>
          {!!excerpt && (
            <Text numberOfLines={3} style={[s.muted, { lineHeight: 21 }]}>
              {excerpt}
            </Text>
          )}
          {presentation.items.slice(0, 3).map((item, index) => (
            <View
              key={`${item.title}:${item.detail ?? ""}`}
              style={[s.row, { alignItems: "flex-start", gap: 9 }]}
            >
              {artifact.kind === "plan" && (
                <Text style={[s.small, { color: colors.blueDark, width: 18, paddingTop: 2 }]}>
                  {index + 1}.
                </Text>
              )}
              <Text numberOfLines={2} style={[s.text, { flex: 1, fontSize: 14, lineHeight: 20 }]}>
                {item.title}
              </Text>
              {item.price && <Text style={s.small}>{item.price}</Text>}
            </View>
          ))}
        </Pressable>
      )}
      <ResultCardFooter
        title={artifact.title}
        subtitle={kind}
        action={action}
        icon={Icon}
        expanded={expanded}
        tint={tint}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded && (
        <View style={{ padding: 20, paddingTop: 4, gap: 16 }}>
          {presentation.showSummary && <AssistantResponse content={artifact.summary} />}
          {!!presentation.body && <AssistantResponse content={presentation.body} />}
          {presentation.showItems &&
            presentation.items.map((item, index) =>
              artifact.kind === "comparison" ? (
                <Option key={`${item.title}:${item.detail ?? ""}`} item={item} />
              ) : (
                <View
                  key={`${item.title}:${item.detail ?? ""}`}
                  style={{ flexDirection: "row", gap: 12 }}
                >
                  <View
                    style={{
                      width: 27,
                      height: 27,
                      borderRadius: 14,
                      backgroundColor: tint,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Text style={[s.small, { color: colors.text }]}>{index + 1}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 5 }}>
                    <AssistantResponse content={item.title} />
                    {item.detail && <AssistantResponse content={item.detail} />}
                  </View>
                </View>
              ),
            )}
          {presentation.sections.map((section) => (
            <View key={`${section.title}:${section.detail ?? ""}`} style={{ gap: 7 }}>
              <Text style={s.heading}>{section.title}</Text>
              {section.detail && <AssistantResponse content={section.detail} />}
            </View>
          ))}
          {Object.keys(artifact.data).length > 0 && (
            <>
              <Button small expanded={details} onPress={() => setDetails(!details)}>
                {t(details ? "Hide details" : "Show details")}
              </Button>
              {details && <ResultDetails value={artifact.data} />}
            </>
          )}
        </View>
      )}
    </ResultCardFrame>
  );
}
