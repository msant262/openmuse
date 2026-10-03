import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type {
  AgentProfileFields,
  AgentProfilePatch,
  EffectiveAgentProfile,
  ProfileScope,
  RevisionEntry,
} from "../../../packages/domain/src/agent";
import { DEFAULT_AGENT_PROFILE } from "../../../packages/domain/src/brand";
import { useAgentWorkspace } from "./agent-workspace";
import { useMuseThread } from "./threads";
import { Button, Card, CheckRow, ErrorNotice, Field, s } from "./ui";
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

export function ProfileSettings() {
  const { api } = useWorkspace();
  const { selection, enabled } = useMuseThread();
  const { data, refresh } = useAgentWorkspace();
  const [scope, setScope] = useState<"global" | "conversation">("global");
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
      <Text style={s.heading}>How we talk</Text>
      {enabled && (
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
              {item === "global" ? "Every conversation" : "Current conversation"}
            </Button>
          ))}
        </View>
      )}
      <Field
        label="Assistant name"
        value={fields.assistantName}
        onChangeText={(value) => edit("assistantName", value)}
      />
      <Field
        label="What should I call you?"
        value={fields.preferredUserName}
        onChangeText={(value) => edit("preferredUserName", value)}
      />
      <Field
        label="Language / locale"
        value={fields.language}
        onChangeText={(value) => edit("language", value)}
        placeholder="pt-BR"
      />
      <Text style={s.text}>Tone</Text>
      <View style={[s.row, { gap: 8 }]}>
        {(["warm", "concise", "thoughtful"] as const).map((value) => (
          <Button
            key={value}
            small
            primary={fields.tone === value}
            onPress={() => edit("tone", value)}
          >
            {value}
          </Button>
        ))}
      </View>
      <Text style={s.text}>Formality</Text>
      <View style={[s.row, { gap: 8 }]}>
        {(["casual", "neutral", "formal"] as const).map((value) => (
          <Button
            key={value}
            small
            primary={fields.formality === value}
            onPress={() => edit("formality", value)}
          >
            {value}
          </Button>
        ))}
      </View>
      <Text style={s.text}>Reply length</Text>
      <View style={[s.row, { gap: 8 }]}>
        {(["concise", "balanced", "detailed"] as const).map((value) => (
          <Button
            key={value}
            small
            primary={fields.responseLength === value}
            onPress={() => edit("responseLength", value)}
          >
            {value}
          </Button>
        ))}
      </View>
      <CheckRow
        label="Light humor"
        checked={fields.humor === "light"}
        onPress={() => edit("humor", fields.humor === "light" ? "none" : "light")}
      />
      <CheckRow
        label="Use emojis"
        checked={fields.emojis}
        onPress={() => edit("emojis", !fields.emojis)}
      />
      <CheckRow
        label="Structured replies"
        checked={fields.textStyle === "structured"}
        onPress={() =>
          edit("textStyle", fields.textStyle === "structured" ? "plain" : "structured")
        }
      />
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={!profile || !Object.keys(patch).length}
        onPress={() => void save()}
      >
        Save conversation preferences
      </Button>
      <Button disabled={busy || !profile} onPress={() => void save(true)}>
        {scope === "global" ? "Restore product defaults" : "Remove this conversation override"}
      </Button>
      <Text style={s.small}>
        Saved from {profile?.origin?.kind ?? "product defaults"} · revision{" "}
        {profile?.revisions[scope] ?? 0}
      </Text>
      <Button small disabled={!profile || busy} onPress={() => void loadHistory()}>
        Preference history
      </Button>
      {history?.entries.map((entry) => (
        <View key={entry.id} style={{ gap: 4 }}>
          <Text style={s.small}>
            Revision {entry.revision} · {entry.action} · {entry.value.origin?.kind ?? "migration"} ·{" "}
            {entry.changedAt}
          </Text>
          <Text style={s.small}>{JSON.stringify(entry.value.fields)}</Text>
          {entry.revision !== profile?.revisions[scope] && (
            <Button
              small
              disabled={busy || !profile}
              onPress={() => history && void restore(entry, history)}
            >
              Restore revision {entry.revision}
            </Button>
          )}
        </View>
      ))}
      {!!history?.nextCursor && (
        <Button small onPress={() => void loadHistory(history.nextCursor)}>
          Older preferences
        </Button>
      )}
      {!!error && (
        <Button
          small
          onPress={() => {
            dirty.current = false;
            void loadProfile(currentTarget);
          }}
        >
          Reload saved preferences
        </Button>
      )}
    </Card>
  );
}
