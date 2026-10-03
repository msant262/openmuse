import { CheckCircle2, ChevronDown, ChevronRight, CircleHelp } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import {
  type InteractionRequest,
  type QuestionAnswer,
  questionSchema,
} from "../../../packages/domain/src/runtime";
import { questionReceiptAnswers } from "./artifact-presentation";
import { CredentialRequestCard } from "./credential-request";
import { useI18n } from "./i18n";
import { QuestionSubmission, questionAnswerError, questionOptionSpace } from "./interaction-state";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function InteractionCard({
  request,
  onAnswered,
}: {
  request: InteractionRequest;
  onAnswered?: () => void;
}) {
  const { t } = useI18n();
  const { api, open } = useWorkspace();
  const [current, setCurrent] = useState(request);
  const [values, setValues] = useState<QuestionAnswer>(() =>
    request.kind === "question" ? (request.answer ?? {}) : {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receiptExpanded, setReceiptExpanded] = useState(false);
  const submission = useMemo(
    () =>
      new QuestionSubmission(
        request,
        `answer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ),
    [request.id, request.revision],
  );
  useEffect(() => {
    setCurrent(request);
    if (request.kind === "question" && request.answer) setValues(request.answer);
  }, [request]);
  const disabled = busy || current.status !== "waiting";
  async function stopTask() {
    if (disabled) return;
    setBusy(true);
    setError("");
    try {
      await api.request(`/api/agent/tasks/${current.taskId}/control`, { action: "cancel" });
      setCurrent({ ...current, status: "superseded" });
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setError("");
    setBusy(true);
    try {
      setCurrent(
        await submission.submit(values, (body) =>
          api.request<InteractionRequest>(`/api/agent/interactions/${request.id}/answer`, body),
        ),
      );
      onAnswered?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const latest = await api
        .request<InteractionRequest>(`/api/agent/interactions/${request.id}`)
        .catch(() => undefined);
      if (latest) {
        setCurrent(latest);
        if (latest.kind === "question" && latest.answer) setValues(latest.answer);
      }
    } finally {
      setBusy(false);
    }
  }
  if (current.kind === "credential")
    return <CredentialRequestCard request={current} onSaved={onAnswered} />;
  if (current.kind !== "question") return null;
  if (!questionSchema.safeParse(current.schema).success)
    return (
      <Card>
        <ErrorNotice error={t("Use the trusted connection form for this request.")} />
      </Card>
    );
  if (current.status !== "waiting") {
    const answers = questionReceiptAnswers(current);
    const answered = current.status === "answered";
    return (
      <Card
        style={{ padding: 14, borderRadius: 18, borderWidth: 1, borderColor: colors.line, gap: 10 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(answered ? "Answer saved" : "Question closed")}
          accessibilityState={{ expanded: receiptExpanded }}
          aria-expanded={receiptExpanded}
          onPress={() => setReceiptExpanded(!receiptExpanded)}
          style={[s.row, { gap: 10, minHeight: 44 }]}
        >
          {answered ? (
            <CheckCircle2 size={20} color="#47896C" />
          ) : (
            <CircleHelp size={20} color={colors.muted} />
          )}
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>{t(answered ? "Answer saved" : "Question closed")}</Text>
            <Text numberOfLines={receiptExpanded ? undefined : 2} style={s.muted}>
              {answers.length
                ? answers.map((answer) => answer.value).join(" · ")
                : current.schema.title}
            </Text>
          </View>
          {receiptExpanded ? (
            <ChevronDown size={18} color={colors.muted} />
          ) : (
            <ChevronRight size={18} color={colors.muted} />
          )}
        </Pressable>
        {receiptExpanded && (
          <View style={{ gap: 10, paddingLeft: 30 }}>
            {answers.length > 0 && (
              <Text selectable style={s.text}>
                {current.schema.title}
              </Text>
            )}
            {answers.map((answer) => (
              <View key={answer.label} style={{ gap: 3 }}>
                <Text style={s.small}>{answer.label}</Text>
                <Text selectable style={s.text}>
                  {answer.value}
                </Text>
              </View>
            ))}
            {!answered &&
              current.schema.fields.map((field) => (
                <View key={field.id} style={{ gap: 4 }}>
                  <Text selectable style={s.text}>
                    {t(field.label)}
                    {field.required ? " *" : ""}
                  </Text>
                  {field.type !== "text" &&
                    field.options.map((option) => (
                      <Text key={option.id} selectable style={s.muted}>
                        • {option.label}
                      </Text>
                    ))}
                </View>
              ))}
            <Button small onPress={() => open({ type: "task", taskId: current.taskId })}>
              {t("View task")}
            </Button>
          </View>
        )}
      </Card>
    );
  }
  return (
    <Card style={{ gap: 15, borderWidth: 1, borderColor: colors.line }}>
      <Text accessibilityRole="header" style={s.heading}>
        {current.schema.title}
      </Text>
      {current.schema.fields.map((field) => (
        <View key={field.id} style={{ gap: 8 }}>
          <Text style={s.text}>
            {t(field.label)}
            {field.required ? " *" : ""}
          </Text>
          {field.type === "text" ? (
            <TextInput
              accessibilityLabel={t(field.label)}
              accessibilityState={{ disabled }}
              aria-disabled={disabled}
              aria-required={field.required}
              editable={!disabled}
              value={typeof values[field.id] === "string" ? (values[field.id] as string) : ""}
              onChangeText={(value) =>
                setValues((previous) => ({ ...previous, [field.id]: value }))
              }
              multiline={field.multiline}
              returnKeyType={field.multiline ? "default" : "send"}
              onSubmitEditing={
                field.multiline
                  ? undefined
                  : () => {
                      if (!questionAnswerError(current, values)) void submit();
                    }
              }
              style={[
                s.text,
                {
                  borderWidth: 1,
                  borderColor: colors.line,
                  borderRadius: 12,
                  padding: 12,
                  minHeight: field.multiline ? 80 : 44,
                },
              ]}
            />
          ) : (
            field.options.map((option) => {
              const selected =
                field.type === "single"
                  ? values[field.id] === option.id
                  : Array.isArray(values[field.id]) &&
                    (values[field.id] as string[]).includes(option.id);
              const select = () =>
                setValues((previous) => ({
                  ...previous,
                  [field.id]:
                    field.type === "single"
                      ? option.id
                      : Array.isArray(previous[field.id]) &&
                          (previous[field.id] as string[]).includes(option.id)
                        ? (previous[field.id] as string[]).filter((id) => id !== option.id)
                        : [
                            ...(Array.isArray(previous[field.id])
                              ? (previous[field.id] as string[])
                              : []),
                            option.id,
                          ],
                }));
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole={field.type === "single" ? "radio" : "checkbox"}
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: selected, disabled }}
                  aria-checked={selected}
                  aria-disabled={disabled}
                  disabled={disabled}
                  onPress={select}
                  {...(Platform.OS === "web"
                    ? {
                        onKeyDown: (event: {
                          key: string;
                          repeat?: boolean;
                          preventDefault(): void;
                        }) => questionOptionSpace(event, disabled, select),
                      }
                    : {})}
                  style={{
                    padding: 13,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: selected ? colors.blueDark : colors.line,
                    backgroundColor: selected ? colors.sky : colors.canvas,
                  }}
                >
                  <Text style={s.text}>
                    {selected ? "● " : "○ "}
                    {option.label}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={disabled || !!questionAnswerError(current, values)}
        onPress={() => void submit()}
      >
        {t("Send answer")}
      </Button>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Button small onPress={() => open({ type: "task", taskId: current.taskId })}>
          {t("View task")}
        </Button>
        <Button small disabled={disabled} onPress={stopTask}>
          {t("Stop task")}
        </Button>
      </View>
    </Card>
  );
}
