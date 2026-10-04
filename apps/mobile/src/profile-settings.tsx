import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type {
  AgentProfileFields,
  AgentProfilePatch,
  EffectiveAgentProfile,
  ProfileScope,
  RevisionEntry,
} from "../../../packages/domain/src/agent";
import { DEFAULT_AGENT_PROFILE } from "../../../packages/domain/src/brand";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { useMuseThread } from "./threads";
import { Button, Card, CheckRow, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Target = {
  api: ReturnType<typeof useWorkspace>["api"];
  identityKey: string;
  scope: ProfileScope;
  threadId: string;
  entityId: string;
};
type HistoryEntry = RevisionEntry<{ fields: AgentProfilePatch; origin?: { kind: string } }>;
type HistoryPage = { entries: HistoryEntry[]; nextCursor?: string };
type ScopedHistory = HistoryPage & { target: Target; profile: EffectiveAgentProfile };

export function ProfileSettings({ document = false }: { document?: boolean } = {}) {
  const { s } = useUI();

  const { t, locale } = useI18n();
  const { api } = useWorkspace();
  const { selection, enabled } = useMuseThread();
  const { data, refresh } = useAgentWorkspace();
  const [scope, setScope] = useState<"global" | "conversation">("global");
  const [advanced, setAdvanced] = useState(false);
  const [savedTarget, setSavedTarget] = useState<Target>();
  const [savedProfile, setProfile] = useState<{ target: Target; value: EffectiveAgentProfile }>();
  const [draft, setDraft] = useState<{ target: Target; value: AgentProfileFields }>();
  const [pending, setPending] = useState<{ target: Target }>();
  const [errorState, setErrorState] = useState<{ target: Target; message: string }>();
  const [savedHistory, setHistory] = useState<ScopedHistory>();
  const target = useRef<Target | undefined>(undefined);
  const loaded = useRef<{ target: Target; value: EffectiveAgentProfile } | undefined>(undefined);
  const operation = useRef<{ target: Target } | undefined>(undefined);
  const mounted = useRef(true);
  const dirty = useRef(false);
  const profileRequest = useRef(0);
  const historyRequest = useRef(0);
  const receipt = useRef<{ binding: string; id: string } | undefined>(undefined);
  if (
    !target.current ||
    target.current.api !== api ||
    target.current.identityKey !== api.identityKey ||
    target.current.scope.kind !== scope ||
    target.current.threadId !== selection.id
  ) {
    target.current = {
      api,
      identityKey: api.identityKey,
      threadId: selection.id,
      scope:
        scope === "global" ? { kind: "global" } : { kind: "conversation", threadId: selection.id },
      entityId: scope === "global" ? "global" : `conversation:${selection.id}`,
    };
    dirty.current = false;
    receipt.current = undefined;
    operation.current = undefined;
  }
  const currentTarget = target.current;
  const profile = savedProfile?.target === currentTarget ? savedProfile.value : undefined;
  const fields = draft?.target === currentTarget ? draft.value : { ...DEFAULT_AGENT_PROFILE };
  const busy = pending?.target === currentTarget;
  const error = errorState?.target === currentTarget ? errorState.message : "";
  const history =
    savedHistory?.target === currentTarget && savedHistory.profile === profile
      ? savedHistory
      : undefined;
  function isCurrent(requestTarget: Target) {
    return (
      mounted.current &&
      target.current === requestTarget &&
      requestTarget.identityKey === requestTarget.api.identityKey &&
      requestTarget.threadId === selection.id
    );
  }
  function setError(message: string, requestTarget = currentTarget) {
    if (isCurrent(requestTarget)) setErrorState({ target: requestTarget, message });
  }
  function apply(value: EffectiveAgentProfile, requestTarget: Target) {
    loaded.current = { target: requestTarget, value };
    setProfile(loaded.current);
    setDraft({ target: requestTarget, value: value.fields });
  }
  async function loadProfile(requestTarget: Target) {
    const version = ++profileRequest.current;
    try {
      const value = await requestTarget.api.request<EffectiveAgentProfile>(
        `/api/agent/profile${requestTarget.scope.kind === "conversation" ? `?threadId=${encodeURIComponent(requestTarget.scope.threadId)}` : ""}`,
      );
      if (isCurrent(requestTarget) && version === profileRequest.current && !dirty.current) {
        apply(value, requestTarget);
        setError("", requestTarget);
      }
    } catch (cause) {
      if (version === profileRequest.current) setError(String(cause), requestTarget);
    }
  }
  useEffect(() => {
    if (!dirty.current) void loadProfile(currentTarget);
    return () => {
      profileRequest.current++;
    };
  }, [currentTarget, data?.identity.profile?.revisions.global]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = undefined;
    };
  }, []);
  const patch = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => profile?.fields[key as keyof AgentProfileFields] !== value,
    ),
  ) as AgentProfilePatch;
  function edit<K extends keyof AgentProfileFields>(key: K, value: AgentProfileFields[K]) {
    if (!profile || !isCurrent(currentTarget)) return;
    dirty.current = true;
    setSavedTarget(undefined);
    setDraft((previous) => ({
      target: currentTarget,
      value: { ...(previous?.target === currentTarget ? previous.value : fields), [key]: value },
    }));
  }
  async function loadHistory(
    cursor?: string,
    requestTarget = currentTarget,
    expectedProfile = loaded.current?.value,
  ) {
    if (!isCurrent(requestTarget) || loaded.current?.target !== requestTarget || !expectedProfile)
      return;
    const version = ++historyRequest.current;
    try {
      const page = await requestTarget.api.request<HistoryPage>(
        `/api/agent/profile/history?limit=10${requestTarget.scope.kind === "conversation" ? `&threadId=${encodeURIComponent(requestTarget.scope.threadId)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (
        !isCurrent(requestTarget) ||
        version !== historyRequest.current ||
        loaded.current?.value !== expectedProfile
      )
        return;
      if (page.entries.some((entry) => entry.entityId !== requestTarget.entityId))
        throw new Error("Preference history belongs to a different scope. Reload it.");
      setHistory((previous) => ({
        ...page,
        target: requestTarget,
        profile: expectedProfile,
        entries:
          cursor && previous?.target === requestTarget && previous.profile === expectedProfile
            ? [...previous.entries, ...page.entries]
            : page.entries,
      }));
    } catch (cause) {
      if (version === historyRequest.current && loaded.current?.value === expectedProfile)
        setError(String(cause), requestTarget);
    }
  }
  async function changeProfile(
    path: string,
    body: Record<string, unknown>,
    requestTarget: Target,
    expectedProfile: EffectiveAgentProfile,
    reloadHistory = false,
  ) {
    if (
      !isCurrent(requestTarget) ||
      loaded.current?.target !== requestTarget ||
      loaded.current.value !== expectedProfile ||
      operation.current
    )
      return;
    const binding = JSON.stringify(body);
    if (receipt.current?.binding !== binding)
      receipt.current = {
        binding,
        id: `profile-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    const active = { target: requestTarget };
    operation.current = active;
    setPending(active);
    setError("", requestTarget);
    try {
      const saved = await requestTarget.api.request<EffectiveAgentProfile>(path, {
        ...body,
        requestId: receipt.current.id,
      });
      if (!isCurrent(requestTarget) || loaded.current?.value !== expectedProfile) return;
      dirty.current = false;
      receipt.current = undefined;
      apply(saved, requestTarget);
      setSavedTarget(requestTarget);
      if (reloadHistory) await loadHistory(undefined, requestTarget, saved);
      if (isCurrent(requestTarget)) await refresh().catch(() => {});
    } catch (cause) {
      if (loaded.current?.value === expectedProfile)
        setError(cause instanceof Error ? cause.message : String(cause), requestTarget);
    } finally {
      if (operation.current === active) operation.current = undefined;
      setPending((previous) => (previous === active ? undefined : previous));
    }
  }
  async function save(reset = false) {
    if (!profile) return;
    await changeProfile(
      `/api/agent/profile${reset ? "/reset" : ""}`,
      {
        scope: currentTarget.scope,
        expectedRevision: profile.revisions[scope],
        ...(reset ? {} : { patch }),
      },
      currentTarget,
      profile,
    );
  }
  async function restore(entry: HistoryEntry, renderedHistory: ScopedHistory) {
    if (entry.entityId !== renderedHistory.target.entityId) return;
    await changeProfile(
      "/api/agent/profile/restore",
      {
        scope: renderedHistory.target.scope,
        revision: entry.revision,
        expectedRevision: renderedHistory.profile.revisions[renderedHistory.target.scope.kind],
      },
      renderedHistory.target,
      renderedHistory.profile,
      true,
    );
  }
  return (
    <Card style={{ gap: 12 }}>
      {!document && <Text style={s.heading}>{t("How we talk")}</Text>}
      {!document && (
        <Text style={s.muted}>{t("A name and a personality that feel right for you.")}</Text>
      )}
      {enabled && advanced && (
        <View style={[s.row, { gap: 8 }]}>
          {(["global", "conversation"] as const).map((item) => (
            <Button
              key={item}
              small
              primary={scope === item}
              onPress={() => {
                if (scope === item) return;
                target.current = undefined;
                dirty.current = false;
                setScope(item);
                setProfile(undefined);
                setHistory(undefined);
              }}
            >
              {item === "global" ? t("Every conversation") : t("Current conversation")}
            </Button>
          ))}
        </View>
      )}
      <Field
        label={t("Assistant name")}
        editable={!!profile && !busy}
        value={fields.assistantName}
        onChangeText={(value) => edit("assistantName", value)}
      />
      <Field
        label={t("What should I call you?")}
        editable={!!profile && !busy}
        value={fields.preferredUserName}
        onChangeText={(value) => edit("preferredUserName", value)}
      />
      <Field
        label={t("Personality and preferences")}
        editable={!!profile && !busy}
        value={fields.personality}
        onChangeText={(value) => edit("personality", value)}
        placeholder={t(
          "For example: warm, direct, curious; explain things with everyday examples.",
        )}
        maxLength={1500}
        multiline
        style={document ? { minHeight: 300, lineHeight: 25, fontSize: 16 } : undefined}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: advanced }}
        aria-expanded={advanced}
        onPress={() => setAdvanced((value) => !value)}
        style={[s.button, s.secondary, { alignSelf: "flex-start", minHeight: 44 }]}
      >
        <Text style={s.buttonText}>
          {advanced ? t("Fewer preferences") : t("More preferences")}
        </Text>
      </Pressable>
      {advanced && (
        <View style={{ gap: 12 }}>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {(
              [
                ["en-US", "English"],
                ["pt-BR", "Portuguese (Brazil)"],
                ["de-DE", "German"],
              ] as const
            ).map(([language, label]) => (
              <Button
                key={language}
                small
                primary={fields.language === language}
                onPress={() => edit("language", language)}
              >
                {t(label)}
              </Button>
            ))}
          </View>
          <Field
            label={t("Reply language")}
            editable={!!profile && !busy}
            value={fields.language}
            onChangeText={(value) => edit("language", value)}
            placeholder={t("en-US or pt-BR")}
          />
          <Text style={s.text}>{t("Tone")}</Text>
          <View style={[s.row, { gap: 8 }]}>
            {(["warm", "concise", "thoughtful"] as const).map((value) => (
              <Button
                key={value}
                small
                primary={fields.tone === value}
                onPress={() => edit("tone", value)}
              >
                {t(value)}
              </Button>
            ))}
          </View>
          <Text style={s.text}>{t("Formality")}</Text>
          <View style={[s.row, { gap: 8 }]}>
            {(["casual", "neutral", "formal"] as const).map((value) => (
              <Button
                key={value}
                small
                primary={fields.formality === value}
                onPress={() => edit("formality", value)}
              >
                {t(value)}
              </Button>
            ))}
          </View>
          <Text style={s.text}>{t("Reply length")}</Text>
          <View style={[s.row, { gap: 8 }]}>
            {(["concise", "balanced", "detailed"] as const).map((value) => (
              <Button
                key={value}
                small
                primary={fields.responseLength === value}
                onPress={() => edit("responseLength", value)}
              >
                {t(value)}
              </Button>
            ))}
          </View>
          <CheckRow
            label={t("Light humor")}
            checked={fields.humor === "light"}
            onPress={() => edit("humor", fields.humor === "light" ? "none" : "light")}
          />
          <CheckRow
            label={t("Use emojis")}
            checked={fields.emojis}
            onPress={() => edit("emojis", !fields.emojis)}
          />
          <CheckRow
            label={t("Structured replies")}
            checked={fields.textStyle === "structured"}
            onPress={() =>
              edit("textStyle", fields.textStyle === "structured" ? "plain" : "structured")
            }
          />
        </View>
      )}
      <ErrorNotice error={error} />
      {enabled && (
        <Text style={s.small}>
          {scope === "global" ? t("Every conversation") : t("Current conversation")}
        </Text>
      )}
      <Button
        primary
        busy={busy}
        disabled={!profile || !Object.keys(patch).length}
        onPress={() => void save()}
      >
        {t("Save conversation preferences")}
      </Button>
      {savedTarget === currentTarget && !Object.keys(patch).length && (
        <Text style={s.small}>{t("Conversation preferences saved")}</Text>
      )}
      {(advanced || document) && (
        <>
          <Button disabled={busy || !profile} onPress={() => void save(true)}>
            {scope === "global"
              ? t("Restore product defaults")
              : t("Remove this conversation override")}
          </Button>
          <Text style={s.small}>
            {t("Saved from {origin} · revision {revision}", {
              origin: t(profile?.origin?.kind ?? "product defaults"),
              revision: profile?.revisions[scope] ?? 0,
            })}
          </Text>
          <Button small disabled={!profile || busy} onPress={() => void loadHistory()}>
            {t("Preference history")}
          </Button>
          {history?.entries.map((entry) => (
            <View key={entry.id} style={{ gap: 4 }}>
              <Text style={s.small}>
                {t("Revision {revision} · {action} · {origin} · {date}", {
                  revision: entry.revision,
                  action: t(entry.action),
                  origin: t(entry.value.origin?.kind ?? "migration"),
                  date: new Date(entry.changedAt).toLocaleString(
                    locale === "pt-BR" ? "pt-BR" : "en-US",
                  ),
                })}
              </Text>
              {Object.entries(entry.value.fields).map(([key, value]) => (
                <Text key={key} style={s.small}>
                  {t(
                    (
                      {
                        assistantName: "Assistant name",
                        preferredUserName: "What should I call you?",
                        personality: "Personality and preferences",
                        language: "Reply language",
                        tone: "Tone",
                        formality: "Formality",
                        responseLength: "Reply length",
                        humor: "Light humor",
                        emojis: "Use emojis",
                        textStyle: "Structured replies",
                      } as Record<string, string>
                    )[key] ?? key,
                  )}
                  : {typeof value === "boolean" ? t(value ? "On" : "Off") : t(String(value))}
                </Text>
              ))}
              {entry.revision !== profile?.revisions[scope] && (
                <Button
                  small
                  disabled={busy || !profile}
                  onPress={() => history && void restore(entry, history)}
                >
                  {t("Restore revision {revision}", { revision: entry.revision })}
                </Button>
              )}
            </View>
          ))}
          {!!history?.nextCursor && (
            <Button small onPress={() => void loadHistory(history.nextCursor)}>
              {t("Older preferences")}
            </Button>
          )}
        </>
      )}
      {!!error && (
        <Button
          small
          onPress={() => {
            dirty.current = false;
            void loadProfile(currentTarget);
          }}
        >
          {t("Reload saved preferences")}
        </Button>
      )}
    </Card>
  );
}
