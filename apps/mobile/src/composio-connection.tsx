import { ExternalLink, Link2 } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Linking, Platform, Text, View } from "react-native";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime";
import { connectionRequestStatus, safeConnectionAuthorizationUrl } from "./connections-state";
import { credentialRequestPath } from "./credential-prompts-state";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

/** The hosted form owns authentication; this view only receives connection metadata. */
export function ComposioConnectionContent({
  request,
  onSettled,
  onBusy,
  onSetup,
}: {
  request: CredentialInteractionRequest;
  onSettled: (request: CredentialInteractionRequest) => void;
  onBusy: (busy: boolean) => void;
  onSetup: () => void;
}) {
  const { s } = useUI();

  const { api } = useWorkspace();
  const { t } = useI18n();
  const [current, setCurrent] = useState(request);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCurrent(request), [request]);
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    let active = true;
    let loading = false;
    const poll = async () => {
      if (
        loading ||
        AppState.currentState === "background" ||
        (Platform.OS === "web" && typeof document !== "undefined" && document.hidden)
      )
        return;
      loading = true;
      try {
        const next = await api.request<CredentialInteractionRequest>(
          credentialRequestPath(request),
        );
        if (!active) return;
        setCurrent(next);
        setError("");
        if (connectionRequestStatus(next.status)) onSettled(next);
      } catch {
        if (active) setError(t("Could not check the connection. We will try again."));
      } finally {
        loading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void poll();
    });
    // A callback is a refresh hint, never proof that an account connected.
    const link = Linking.addEventListener("url", () => void poll());
    const visible = () => void poll();
    if (Platform.OS === "web" && typeof document !== "undefined")
      document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(timer);
      foreground.remove();
      link.remove();
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", visible);
    };
  }, [api, request.id, t, onSettled]);

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      onSettled(
        await api.request<CredentialInteractionRequest>(
          `${credentialRequestPath(current)}/cancel`,
          {},
        ),
      );
    } catch {
      setError(t("The connection request could not be cancelled. Try again."));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      setCurrent(
        await api.request<CredentialInteractionRequest>(
          `${credentialRequestPath(current)}/retry`,
          {},
        ),
      );
    } catch {
      setError(t("Could not start this connection. Try again."));
    } finally {
      setBusy(false);
    }
  }
  const url = safeConnectionAuthorizationUrl(current.schema.composio?.authorizationUrl);
  const setup = current.schema.composio?.setupRequired;
  const failed =
    current.status === "error" ||
    current.status === "invalid_credentials" ||
    current.status === "expired";
  return (
    <View style={{ gap: 16 }}>
      {!!current.schema.purpose && <Text style={s.text}>{current.schema.purpose}</Text>}
      <Text style={s.muted}>
        {t(
          failed
            ? current.status === "expired"
              ? "This authorization link expired. Start again to continue."
              : "The account could not be connected. Start again to continue."
            : setup
              ? "Activate the app catalog in Connections, then return to finish this connection."
              : "Authorize your account in the secure connection window. This screen updates automatically when you return.",
        )}
      </Text>
      {failed ? (
        <Button primary busy={busy} disabled={busy} onPress={() => void retry()}>
          {t("Try again")}
        </Button>
      ) : setup ? (
        <Button primary icon={Link2} onPress={onSetup}>
          {t("Open connections")}
        </Button>
      ) : url ? (
        <Button
          primary
          icon={ExternalLink}
          disabled={busy}
          onPress={() =>
            void Linking.openURL(url).catch(() =>
              setError(t("Could not open authorization. Try again.")),
            )
          }
        >
          {t("Authorize {service}", { service: current.schema.serviceName })}
        </Button>
      ) : (
        <Text style={s.small}>{t("Preparing your secure connection…")}</Text>
      )}
      {!setup && !failed && <Text style={s.small}>{t("Waiting for authorization")}</Text>}
      <ErrorNotice error={error} />
      <Button small disabled={busy} busy={busy} onPress={() => void cancel()}>
        {t("Cancel connection request")}
      </Button>
    </View>
  );
}
