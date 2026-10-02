import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type {
  AgentProfileFields,
  AgentProfilePatch,
  EffectiveAgentProfile,
} from "../../../packages/domain/src/agent";
import { DEFAULT_AGENT_PROFILE } from "../../../packages/domain/src/brand";
import { useAgentWorkspace } from "./agent-workspace";
import { useMuseThread } from "./threads";
import { Button, Card, CheckRow, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ProfileSettings() {
  const { api } = useWorkspace();
  const { selection, enabled } = useMuseThread();
  const { data, refresh } = useAgentWorkspace();
  const [scope, setScope] = useState<"global" | "conversation">("global");
  const [profile, setProfile] = useState<EffectiveAgentProfile>();
  const [fields, setFields] = useState<AgentProfileFields>({ ...DEFAULT_AGENT_PROFILE });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = useRef(false);
  const receipt = useRef<{ binding: string; id: string } | undefined>(undefined);
  useEffect(() => {
    if (dirty.current) return;
    let current = true;
    void api
      .request<EffectiveAgentProfile>(
        `/api/agent/profile${scope === "conversation" ? `?threadId=${selection.id}` : ""}`,
      )
      .then((value) => {
        if (current) {
          setProfile(value);
          setFields(value.fields);
          setError("");
        }
      })
      .catch((cause) => {
        if (current) setError(String(cause));
      });
    return () => {
      current = false;
    };
  }, [api, scope, selection.id, data?.identity.profile?.revisions.global]);
  const patch = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => profile?.fields[key as keyof AgentProfileFields] !== value,
    ),
  ) as AgentProfilePatch;
  function edit<K extends keyof AgentProfileFields>(key: K, value: AgentProfileFields[K]) {
    dirty.current = true;
    setFields((previous) => ({ ...previous, [key]: value }));
  }
  async function save(reset = false) {
    if (!profile) return;
    const body = {
      scope:
        scope === "global" ? { kind: "global" } : { kind: "conversation", threadId: selection.id },
      expectedRevision: profile.revisions[scope],
      ...(reset ? {} : { patch }),
    };
    const binding = JSON.stringify(body);
    if (receipt.current?.binding !== binding)
      receipt.current = {
        binding,
        id: `settings-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };
    setBusy(true);
    setError("");
    try {
      const saved = await api.request<EffectiveAgentProfile>(
        `/api/agent/profile${reset ? "/reset" : ""}`,
        { ...body, requestId: receipt.current!.id },
      );
      dirty.current = false;
      receipt.current = undefined;
      setProfile(saved);
      setFields(saved.fields);
      await refresh().catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
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
                dirty.current = false;
                setScope(item);
                setProfile(undefined);
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
      {!!error && (
        <Button
          small
          onPress={() => {
            dirty.current = false;
            void api
              .request<EffectiveAgentProfile>(
                `/api/agent/profile${scope === "conversation" ? `?threadId=${selection.id}` : ""}`,
              )
              .then((value) => {
                setProfile(value);
                setFields(value.fields);
                setError("");
              })
              .catch((cause) => setError(String(cause)));
          }}
        >
          Reload saved preferences
        </Button>
      )}
    </Card>
  );
}
