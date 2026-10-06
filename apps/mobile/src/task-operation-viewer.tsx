import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe2,
  XCircle,
} from "lucide-react-native";
import { useState } from "react";
import { Image, Linking, Platform, ScrollView, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import type { AgentArtifact, Evidence } from "../../../packages/domain/src/agent";
import type { CompletionCriterion } from "../../../packages/domain/src/runtime";
import { ArtifactResultCard } from "./artifact-result-card";
import { AssistantResponse } from "./assistant-response";
import { localizedAttachmentLabel } from "./attachment-ui-copy";
import { useI18n } from "./i18n";
import {
  completionPresentation,
  type OperationNode,
  operationPresentation,
  type TaskOperationDetail,
  taskOperationValue,
  taskSourcesPresentation,
} from "./task-operation-details";
import { Button, Card, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

function OperationContent({
  node,
  files,
  artifacts,
}: {
  node: OperationNode;
  files: Artifact[];
  artifacts: AgentArtifact[];
}) {
  const { colors, s } = useUI();
  const { t, locale } = useI18n();
  const { open, api } = useWorkspace();
  const [error, setError] = useState("");
  if (node.kind === "source") {
    return (
      <Card
        style={{ gap: 9, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}
      >
        <View style={[s.row, { gap: 8 }]}>
          <Globe2 size={15} color={colors.muted} />
          <Text style={[s.small, { flex: 1 }]}>
            {new URL(node.url).hostname.replace(/^www\./, "")}
          </Text>
        </View>
        {node.consulted && (
          <Text style={[s.small, { color: colors.success }]}>{t("Consulted by the agent")}</Text>
        )}
        <Text selectable style={[s.heading, { fontSize: 16, lineHeight: 23 }]}>
          {node.title}
        </Text>
        {!!node.excerpt && <AssistantResponse content={node.excerpt} />}
        <Button
          small
          style={{ alignSelf: "flex-start" }}
          onPress={() => {
            setError("");
            void Linking.openURL(node.url).catch((cause) => setError(String(cause)));
          }}
        >
          {t("View source")}
        </Button>
        <ErrorNotice error={error} />
      </Card>
    );
  }
  if (node.kind === "file") {
    const file = files.find((file) => file.id === node.fileId);
    const artifact = artifacts.find((artifact) => artifact.id === node.fileId);
    if (!file && artifact) return <ArtifactResultCard artifact={artifact} />;
    return (
      <Card
        style={{ gap: 12, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.line }}
      >
        {file?.mimeType.startsWith("image/") && (
          <Image
            source={{ uri: api.url(file.url) }}
            accessibilityLabel={file.name}
            style={{ width: "100%", height: 220, borderRadius: 10, backgroundColor: colors.subtle }}
            resizeMode="contain"
          />
        )}
        <View style={[s.row, { gap: 10 }]}>
          <FileText size={18} color={colors.blueDark} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text selectable style={[s.text, { fontWeight: "600" }]}>
              {file?.name ?? (node.name === "Attachment" ? t("Attachment") : node.name)}
            </Text>
            {file && <Text style={s.small}>{localizedAttachmentLabel(file, t)}</Text>}
          </View>
        </View>
        {file ? (
          <Button
            small
            style={{ alignSelf: "flex-start" }}
            onPress={() => open({ type: "file", file })}
          >
            {t(file.mimeType.startsWith("image/") ? "View image" : "Open attachment")}
          </Button>
        ) : (
          <Text style={s.small}>{t("Attachment unavailable in this task.")}</Text>
        )}
      </Card>
    );
  }
  if (node.kind === "check") {
    const Icon = node.passed ? CheckCircle2 : XCircle;
    return (
      <View style={[s.row, { gap: 9, alignItems: "flex-start" }]}>
        <Icon size={18} color={node.passed ? colors.success : colors.danger} />
        <Text selectable style={[s.text, { flex: 1 }]}>
          {t(node.label)}
        </Text>
      </View>
    );
  }
  if (node.kind === "group") {
    return (
      <View style={{ gap: 10 }}>
        {!!node.label && <Text style={[s.small, { fontWeight: "600" }]}>{t(node.label)}</Text>}
        <OperationContentList nodes={node.children} files={files} artifacts={artifacts} />
      </View>
    );
  }
  let value =
    typeof node.value === "boolean"
      ? t(node.value ? "Yes" : "No")
      : typeof node.value === "number"
        ? node.value.toLocaleString(locale)
        : node.localized
          ? t(node.value)
          : node.value;
  if (
    (node.label === "Checked at" || node.label === "Created at") &&
    typeof node.value === "string" &&
    Number.isFinite(Date.parse(node.value))
  )
    value = new Date(node.value).toLocaleString(locale === "pt-BR" ? "pt-BR" : "en");
  return (
    <View style={{ gap: 5 }}>
      {!!node.label && <Text style={[s.small, { fontWeight: "600" }]}>{t(node.label)}</Text>}
      <AssistantResponse content={value} />
    </View>
  );
}

/** The completed tab uses the same cards as steps, including complete source receipts. */
export function TaskResultViewer({
  files,
  artifacts,
  evidence,
  operations,
  completion,
  criteria,
  showChecks = true,
}: {
  files: Artifact[];
  artifacts: AgentArtifact[];
  evidence: Evidence[];
  operations: TaskOperationDetail[];
  completion?: unknown;
  criteria?: readonly Pick<CompletionCriterion, "id" | "description">[];
  showChecks?: boolean;
}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const [technical, setTechnical] = useState(false);
  const sources = taskSourcesPresentation(evidence, operations);
  const checks = completionPresentation(completion, criteria);
  return (
    <View style={{ gap: 24 }}>
      {!!files.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.heading}>{t("Files")}</Text>
          <OperationContentList
            nodes={files.map((file) => ({ kind: "file", fileId: file.id, name: file.name }))}
            files={files}
            artifacts={artifacts}
          />
        </View>
      )}
      {artifacts.map((artifact) => (
        <ArtifactResultCard key={artifact.id} artifact={artifact} />
      ))}
      {showChecks && !!checks.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.heading}>{t("Delivery checks")}</Text>
          <OperationContentList nodes={checks} files={files} artifacts={artifacts} />
        </View>
      )}
      {!!sources.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.heading}>{t("Sources")}</Text>
          <OperationContentList nodes={sources} files={files} artifacts={artifacts} />
        </View>
      )}
      <View style={{ gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line }}>
        <Button
          small
          expanded={technical}
          icon={technical ? ChevronDown : ChevronRight}
          style={{ alignSelf: "flex-start" }}
          onPress={() => setTechnical(!technical)}
        >
          {t("Technical details (JSON)")}
        </Button>
        {technical && (
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 360, backgroundColor: colors.subtle, borderRadius: 12 }}
            contentContainerStyle={{ padding: 14 }}
          >
            <Text
              selectable
              style={[
                s.small,
                { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", lineHeight: 19 },
              ]}
            >
              {taskOperationValue({ completion, evidence })}
            </Text>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

function OperationContentList({
  nodes,
  files,
  artifacts,
}: {
  nodes: OperationNode[];
  files: Artifact[];
  artifacts: AgentArtifact[];
}) {
  const occurrences = new Map<string, number>();
  return (
    <>
      {nodes.map((node) => {
        const identity =
          node.kind === "source"
            ? node.url
            : node.kind === "file"
              ? node.fileId
              : (node.label ??
                (node.kind === "text" ? String(node.value).slice(0, 120) : node.kind));
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        return (
          <OperationContent
            key={`${node.kind}:${identity}:${occurrence}`}
            node={node}
            files={files}
            artifacts={artifacts}
          />
        );
      })}
    </>
  );
}

/** Human-readable receipts are primary; the original JSON is an explicit optional view. */
export function TaskOperationViewer({
  operation,
  files = [],
  artifacts = [],
  criteria = [],
}: {
  operation: TaskOperationDetail;
  files?: Artifact[];
  artifacts?: AgentArtifact[];
  criteria?: readonly Pick<CompletionCriterion, "id" | "description">[];
}) {
  const { colors, s } = useUI();
  const { t } = useI18n();
  const [technical, setTechnical] = useState(false);
  const presentation = operationPresentation(operation, criteria);
  return (
    <View style={{ gap: 22 }}>
      {!!presentation.input.length && (
        <View style={{ gap: 12 }}>
          <Text style={s.heading}>{t("What was requested")}</Text>
          <OperationContentList nodes={presentation.input} files={files} artifacts={artifacts} />
        </View>
      )}
      <View style={{ gap: 12 }}>
        <Text style={s.heading}>{t("Result of this step")}</Text>
        {presentation.output.length ? (
          <OperationContentList nodes={presentation.output} files={files} artifacts={artifacts} />
        ) : (
          <Text style={s.muted}>
            {t(
              operation.status === "succeeded"
                ? "No additional result was recorded for this step."
                : "The result has not been recorded yet.",
            )}
          </Text>
        )}
      </View>
      <View style={{ gap: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line }}>
        <Button
          small
          expanded={technical}
          icon={technical ? ChevronDown : ChevronRight}
          style={{ alignSelf: "flex-start" }}
          onPress={() => setTechnical(!technical)}
        >
          {t("Technical details (JSON)")}
        </Button>
        {technical && (
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 360, backgroundColor: colors.subtle, borderRadius: 12 }}
            contentContainerStyle={{ padding: 14, gap: 10 }}
          >
            <Text
              selectable
              style={[
                s.small,
                { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", lineHeight: 19 },
              ]}
            >
              {taskOperationValue({
                tool: operation.toolName,
                status: operation.status,
                input: operation.args,
                result: operation.receipt,
                ...(operation.error ? { error: operation.error } : {}),
              })}
            </Text>
          </ScrollView>
        )}
      </View>
    </View>
  );
}
