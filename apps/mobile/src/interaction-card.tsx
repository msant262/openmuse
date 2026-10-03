import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import {
  type InteractionRequest,
  type QuestionAnswer,
  questionSchema,
} from "../../../packages/domain/src/runtime";
import { QuestionSubmission, questionAnswerError, questionOptionSpace } from "./interaction-state";
import { CredentialRequestCard } from "./credential-request";
import { useI18n } from "./i18n";
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
  const { api } = useWorkspace();
  const [current, setCurrent] = useState(request);
  const [values, setValues] = useState<QuestionAnswer>(() =>
    request.kind === "question" ? (request.answer ?? {}) : {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
  return (
    <Card style={{ gap: 15 }}>
      <Text accessibilityRole="header" style={s.heading}>
        {current.schema.title}
      </Text>
      {current.schema.fields.map((field) => (
        <View key={field.id} style={{ gap: 8 }}>
          <Text style={s.text}>
            {field.label}
            {field.required ? " *" : ""}
          </Text>
          {field.type === "text" ? (
            <TextInput
              accessibilityLabel={field.label}
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
        {current.status === "answered"
          ? t("Answer saved")
          : current.status === "superseded"
            ? t("Question closed")
            : t("Send answer")}
      </Button>
      <Text style={s.small}>{t("Task {taskId} · Other tasks and chat remain available.", { taskId: current.taskId })}</Text>
    </Card>
  );
}
