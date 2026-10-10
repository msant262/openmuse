import { KeyRound, ShieldCheck, X } from "lucide-react-native";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Platform, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime";
import { useAgentWorkspace } from "./agent-workspace";
import { ComposioConnectionContent } from "./composio-connection";
import {
  credentialNeedsInput,
  credentialPromptKey,
  credentialRequestPath,
  nextCredentialPrompt,
  pendingCredentialPrompts,
} from "./credential-prompts-state";
import { CredentialRequestCard } from "./credential-request";
import { useI18n } from "./i18n";
import { Button, IconButton, ModalSurface, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type CredentialPrompts = {
  show: (request: CredentialInteractionRequest) => void;
  refresh: () => Promise<void>;
};
const CredentialPromptsContext = createContext<CredentialPrompts | null>(null);

export function useCredentialPrompts() {
  return useContext(CredentialPromptsContext);
}

/** One owner-scoped modal for every credential request, regardless of the visible screen. */
export function CredentialPromptsProvider({ children }: { children: ReactNode }) {
  const { colors, s } = useUI();

  const { api, notify, navigate } = useWorkspace();
  const { refresh: refreshAgent } = useAgentWorkspace();
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [requests, setRequests] = useState<CredentialInteractionRequest[]>([]);
  const [active, setActive] = useState<CredentialInteractionRequest>();
  const [busy, setBusy] = useState(false);
  const dismissed = useRef(new Set<string>());
  const activeId = useRef<string | undefined>(undefined);
  const polling = useRef(false);
  const identity = useRef(api.identityKey);

  const receive = useCallback((next: CredentialInteractionRequest[]) => {
    setRequests(next);
    setActive((previous) => {
      // Keep the hosted form mounted until it verifies its own terminal response.
      // The aggregate queue may already omit a finished or expired request.
      const keep =
        previous?.schema.credentialKind === "composio" && previous.id === activeId.current;
      const candidates =
        keep && !next.some((item) => item.id === previous.id) ? [...next, previous] : next;
      const selected = nextCredentialPrompt(candidates, dismissed.current, activeId.current);
      activeId.current = selected?.id;
      return selected;
    });
  }, []);

  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    const requestedIdentity = api.identityKey;
    try {
      const next = await api.request<{ requests: CredentialInteractionRequest[] }>(
        "/api/credential-prompts",
      );
      if (identity.current === requestedIdentity) receive(next.requests);
    } finally {
      polling.current = false;
    }
  }, [api, receive]);

  useEffect(() => {
    identity.current = api.identityKey;
    dismissed.current.clear();
    activeId.current = undefined;
    setRequests([]);
    setActive(undefined);
    const visible = () =>
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive" &&
      (Platform.OS !== "web" || typeof document === "undefined" || !document.hidden);
    const poll = () => {
      if (visible()) void refresh().catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 2000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });
    if (Platform.OS === "web" && typeof document !== "undefined")
      document.addEventListener("visibilitychange", poll);
    return () => {
      identity.current = "";
      clearInterval(timer);
      subscription.remove();
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", poll);
    };
  }, [api.identityKey, refresh]);

  const show = useCallback((request: CredentialInteractionRequest) => {
    dismissed.current.delete(credentialPromptKey(request));
    activeId.current = request.id;
    setActive(request);
    setRequests((previous) => [...previous.filter((item) => item.id !== request.id), request]);
  }, []);

  function hide() {
    if (busy) return;
    // Hiding is deliberate. Polling and already queued prompts must not interrupt again.
    for (const request of requests) dismissed.current.add(credentialPromptKey(request));
    if (active) dismissed.current.add(credentialPromptKey(active));
    activeId.current = undefined;
    setActive(undefined);
  }

  const settled = useCallback(
    (request: CredentialInteractionRequest) => {
      dismissed.current.add(credentialPromptKey(request));
      activeId.current = undefined;
      setActive(undefined);
      setBusy(false);
      setRequests((previous) => previous.filter((item) => item.id !== request.id));
      void refreshAgent().catch(() => {});
      void refresh().catch(() => {});
      if (request.status === "saved" || request.status === "connected")
        notify(
          t(
            request.schema.credentialKind === "composio"
              ? "Account connected."
              : "Credential saved. Your task will continue.",
          ),
        );
    },
    [notify, refresh, refreshAgent, t],
  );

  const pending = pendingCredentialPrompts(requests);
  const controller = useMemo(() => ({ show, refresh }), [show, refresh]);
  return (
    <CredentialPromptsContext.Provider value={controller}>
      {children}
      {!active && pending.length > 0 && (
        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: insets.top + (width < 700 ? 108 : 66),
            right: 20,
            maxWidth: width - 40,
            alignItems: "flex-end",
          }}
        >
          <Button icon={KeyRound} onPress={() => show(pending[0])}>
            {t("Connection needed ({count})", { count: pending.length })}
          </Button>
        </View>
      )}
      {active && (
        <ModalSurface label={t("Secure connection")} onClose={hide} width={500}>
          <View style={[s.row, { paddingHorizontal: 22, paddingTop: 18, gap: 12 }]}>
            <View style={[s.iconBox, { backgroundColor: colors.subtle }]}>
              <ShieldCheck size={23} color={colors.success} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.small}>{t("Secure connection")}</Text>
              <Text accessibilityRole="header" style={s.heading}>
                {active.schema.serviceName}
              </Text>
            </View>
            <IconButton icon={X} label={t("Close secure connection")} onPress={hide} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 24, paddingTop: 20 }}
          >
            {active.schema.credentialKind === "composio" ? (
              <ComposioConnectionContent
                key={active.id}
                request={active}
                onBusy={setBusy}
                onSettled={settled}
                onSetup={() => {
                  hide();
                  navigate("connections");
                }}
              />
            ) : (
              <CredentialRequestCard
                key={`${active.id}:${active.revision}`}
                request={active}
                embedded
                onBusy={setBusy}
                onSaved={settled}
                onCancelled={settled}
              />
            )}
            <View style={{ marginTop: 10 }}>
              <Button small disabled={busy} onPress={hide}>
                {t("Do this later")}
              </Button>
            </View>
          </ScrollView>
        </ModalSurface>
      )}
    </CredentialPromptsContext.Provider>
  );
}

/** Conversation and task history only contain receipts; values live in the modal. */
export function CredentialRequestReceipt({ request }: { request: CredentialInteractionRequest }) {
  const { colors, s } = useUI();

  const prompts = useContext(CredentialPromptsContext);
  const { api } = useWorkspace();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(request);
  useEffect(() => setCurrent(request), [request]);
  async function reopen() {
    setBusy(true);
    try {
      const latest = await api.request<CredentialInteractionRequest>(
        credentialRequestPath(current),
      );
      setCurrent(latest);
      if (credentialNeedsInput(latest)) prompts?.show(latest);
      else void prompts?.refresh().catch(() => {});
    } catch {
      // The existing metadata still opens a safe form; the submit endpoint checks freshness.
      prompts?.show(current);
    } finally {
      setBusy(false);
    }
  }
  const needed = credentialNeedsInput(current);
  return (
    <View
      style={{ borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 12 }}
    >
      <View style={[s.row, { gap: 12 }]}>
        <KeyRound size={20} color={colors.muted} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={s.heading}>{current.schema.serviceName}</Text>
          <Text style={s.muted}>
            {t(
              needed
                ? "A credential is needed to continue."
                : ["saved", "connected"].includes(current.status)
                  ? "Credential saved securely."
                  : current.status === "cancelled"
                    ? "Connection request cancelled."
                    : current.status === "connecting" || current.status === "saving"
                      ? "Connecting…"
                      : "Connection request closed.",
            )}
          </Text>
        </View>
      </View>
      {needed && (
        <Button small busy={busy} onPress={() => void reopen()}>
          {t(current.schema.credentialKind === "composio" ? "Connect account" : "Enter securely")}
        </Button>
      )}
    </View>
  );
}
