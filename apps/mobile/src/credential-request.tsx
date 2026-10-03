import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime";
import { useI18n } from "./i18n";
import {
  CredentialSubmission,
  type CredentialValues,
  credentialFormError,
} from "./credential-state";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

function responseId(requestId: string) {
  return `credential-${requestId}`;
}

export function CredentialRequestCard({
  request,
  onSaved,
}: {
  request: CredentialInteractionRequest;
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const [current, setCurrent] = useState(request);
  const [values, setValues] = useState<CredentialValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [challengeValue, setChallengeValue] = useState("");
  const [challengeBusy, setChallengeBusy] = useState(false);
  const submission = useMemo(
    () => new CredentialSubmission(request, responseId(request.id)),
    [request.id, request.revision],
  );
  useEffect(() => {
    setCurrent(request);
    setValues({});
    setError("");
    setChallengeValue("");
  }, [request]);
  const disabled = busy || current.status !== "waiting";
  const validation = credentialFormError(current, values);

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const saved = await submission.submit(values, (body) =>
        api.request<CredentialInteractionRequest>(
          `/api/credential-requests/${request.id}/submit`,
          body,
        ),
      );
      setCurrent(saved);
      if (saved.status === "saved") {
        setValues({});
        onSaved?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The credential could not be saved."));
      const latest = await api
        .request<CredentialInteractionRequest>(`/api/credential-requests/${request.id}`)
        .catch(() => undefined);
      if (latest) {
        setCurrent(latest);
        if (latest.status !== "waiting" && latest.status !== "outcome_unknown") setValues({});
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitChallenge() {
    if (!current.challengeId || !challengeValue.trim()) return;
    setError("");
    setChallengeBusy(true);
    try {
      await api.request(`/api/credential-challenges/${current.challengeId}/submit`, {
        clientResponseId: `credential-challenge-${current.challengeId}-${Crypto.randomUUID()}`,
        value: challengeValue,
      });
      setChallengeValue("");
      setCurrent((previous) => ({ ...previous, status: "connecting" }));
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("The verification code could not be sent."));
      setChallengeValue("");
    } finally {
      setChallengeBusy(false);
    }
  }

  const statusLabel =
    current.status === "saved"
      ? t("Credential saved. Login still needs confirmation.")
      : current.status === "connected"
        ? t("Account connected.")
        : current.status === "needs_challenge"
          ? current.challengeKind === "otp" || current.challengeKind === "totp"
            ? t("Enter the verification code from the site in this secure card.")
            : t("The bot will try to complete verification. If it needs help, it will ask you to take control of the browser.")
          : current.status === "invalid_credentials"
            ? t("The site rejected these credentials. Reopen the request to try again.")
            : current.status === "expired"
              ? t("This request expired. The task can request a fresh form.")
              : current.status === "superseded"
                ? t("This task changed. Reopen the latest connection request.")
                : current.status === "outcome_unknown"
                  ? t("The vault could not confirm the save. The request needs reconciliation.")
                  : current.status === "saving"
                    ? t("Saving securely to the credential vault…")
                    : t("Your values go directly to the credential vault; the conversation stores only connection status.");

  return (
    <Card style={{ gap: 14 }}>
      <Text accessibilityRole="header" style={s.heading}>
        {current.schema.title}
      </Text>
      <View style={{ gap: 3 }}>
        <Text style={s.small}>{t("Destination: {origin}", { origin: current.schema.origin })}</Text>
        <Text style={s.muted}>{current.schema.purpose}</Text>
      </View>
      {(current.status === "waiting" || current.status === "outcome_unknown") &&
        current.schema.fields.map((field) => (
          <View key={field.id} style={{ gap: 7 }}>
            <Text style={s.text}>
              {field.label}
              {field.required ? " *" : ""}
            </Text>
            <TextInput
              accessibilityLabel={field.label}
              accessibilityState={{ disabled }}
              aria-disabled={disabled}
              aria-required={field.required}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!disabled}
              secureTextEntry={field.type === "password"}
              value={values[field.id] ?? ""}
              onChangeText={(value) =>
                setValues((previous) => ({ ...previous, [field.id]: value }))
              }
              returnKeyType="next"
              style={{
                ...s.input,
                borderColor: colors.line,
                fontFamily: field.type === "password" ? "System" : undefined,
              }}
            />
          </View>
        ))}
      {current.status === "needs_challenge" &&
        current.challengeId &&
        (current.challengeKind === "otp" || current.challengeKind === "totp") && (
          <View style={{ gap: 7 }}>
            <Text style={s.text}>{t("Verification code")}</Text>
            <TextInput
              accessibilityLabel={t("Verification code")}
              accessibilityState={{ disabled: challengeBusy }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!challengeBusy}
              secureTextEntry
              value={challengeValue}
              onChangeText={setChallengeValue}
              keyboardType="number-pad"
              style={{ ...s.input, borderColor: colors.line }}
            />
          </View>
        )}
      {current.status === "waiting" || current.status === "outcome_unknown" ? (
        <>
          <ErrorNotice error={error} />
          <Button
            primary
            busy={busy}
            disabled={disabled || !!validation}
            onPress={() => void submit()}
          >
            {current.status === "outcome_unknown" ? t("Retry secure save") : t("Save and continue")}
          </Button>
        </>
      ) : (
        <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={s.muted}>
          {statusLabel}
        </Text>
      )}
      {current.status === "needs_challenge" &&
        current.challengeId &&
        (current.challengeKind === "otp" || current.challengeKind === "totp") && (
          <>
            <ErrorNotice error={error} />
            <Button
              primary
              busy={challengeBusy}
              disabled={challengeBusy || !challengeValue.trim()}
              onPress={() => void submitChallenge()}
            >
              {t("Submit verification code")}
            </Button>
          </>
        )}
      {current.status === "needs_challenge" &&
        !["otp", "totp"].includes(current.challengeKind ?? "") && (
          <Text style={s.small}>
            {t("If the bot asks for help, take control in the browser and finish verification. When you hand control back, the task resumes and checks the result.")}
          </Text>
        )}
      <Text style={s.small}>{t("Task {taskId} · Chat and other tasks remain available.", { taskId: current.taskId })}</Text>
    </Card>
  );
}
