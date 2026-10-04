import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ProcedureVersion } from "../../../packages/domain/src/playbooks";
import { useI18n } from "./i18n";
import { messageStorage } from "./message-storage";
import { Button, Card, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function PlaybooksPanel() {
  const { s } = useUI();

  const { t } = useI18n();
  const { api, ask } = useWorkspace();
  const [values, setValues] = useState<ProcedureVersion[]>([]);
  const [selected, setSelected] = useState<ProcedureVersion>();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ProcedureVersion[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const generation = useRef(0);
  const scope = useRef({ api, identity: api.identityKey });
  scope.current = { api, identity: api.identityKey };
  const receipts = useRef(new Map<string, string>());
  function requestContext() {
    const captured = { ...scope.current, generation: generation.current };
    const sameOwner = () =>
      scope.current.api === captured.api && scope.current.identity === captured.identity;
    return {
      sameOwner,
      current: () => sameOwner() && generation.current === captured.generation,
    };
  }
  useEffect(() => {
    let live = true;
    generation.current++;
    receipts.current.clear();
    setValues([]);
    setSelected(undefined);
    setHistory([]);
    setHistoryCursor(undefined);
    setInputs({});
    setError("");
    setStatus("");
    setBusy(false);
    void api
      .request<ProcedureVersion[]>("/api/agent/playbooks")
      .then((value) => {
        if (live) setValues(value);
      })
      .catch((error) => {
        if (live) setError(String(error));
      });
    return () => {
      live = false;
      generation.current++;
    };
  }, [api, api.identityKey]);
  async function manage(
    action: "archive" | "restore" | "pin" | "unpin" | "rollback",
    version?: number,
  ) {
    if (!selected || busy) return;
    const context = requestContext();
    setBusy(true);
    setError("");
    const body = {
      action,
      version,
      expectedVersion: selected.version,
      reason: "Changed in procedure settings",
    };
    const binding = JSON.stringify({ owner: api.identityKey, id: selected.id, ...body });
    let requestId = receipts.current.get(binding);
    if (!requestId) {
      requestId = Crypto.randomUUID();
      receipts.current.set(binding, requestId);
    }
    try {
      const value = await api.request<ProcedureVersion>(
        `/api/agent/playbooks/${selected.id}/manage`,
        { ...body, requestId },
      );
      if (!context.sameOwner()) return;
      receipts.current.delete(binding);
      setValues((items) => items.map((item) => (item.id === value.id ? value : item)));
      if (!context.current()) return;
      setSelected(value);
      setHistory([]);
      setHistoryCursor(undefined);
      setStatus(t("Saved"));
    } catch (error) {
      if (context.current()) setError(String(error));
    } finally {
      if (context.current()) setBusy(false);
    }
  }
  async function loadHistory(cursor?: string) {
    if (!selected || busy) return;
    const context = requestContext();
    setBusy(true);
    setError("");
    try {
      const page = await api.request<{
        entries: { value: ProcedureVersion }[];
        nextCursor?: string;
      }>(
        `/api/agent/playbooks/${selected.id}/history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!context.current()) return;
      setHistory((old) =>
        cursor
          ? [...old, ...page.entries.map((entry) => entry.value)]
          : page.entries.map((entry) => entry.value),
      );
      setHistoryCursor(page.nextCursor);
    } catch (error) {
      if (context.current()) setError(String(error));
    } finally {
      if (context.current()) setBusy(false);
    }
  }
  async function run() {
    if (!selected || busy) return;
    const context = requestContext();
    setBusy(true);
    setError("");
    const key = `${api.identityKey}:procedure-run:${selected.id}`;
    try {
      const raw = await messageStorage.update(key, (saved) => {
        const previous = saved ? JSON.parse(saved) : null;
        return JSON.stringify(
          previous ?? { version: selected.version, inputs, requestId: Crypto.randomUUID() },
        );
      });
      const result = await api.request<{ id: string; status: string }>(
        `/api/agent/playbooks/${selected.id}/run`,
        JSON.parse(raw),
      );
      await messageStorage.write(key, "null");
      if (!context.current()) return;
      setStatus(
        t("{status}: {id}. Follow it in Tasks.", {
          status: t(result.status),
          id: result.id,
        }),
      );
    } catch (error) {
      if (context.current()) setError(String(error));
    } finally {
      if (context.current()) setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.heading}>{t("Saved procedures")}</Text>
      <Text style={s.muted}>
        {t('After a task is done, ask in chat: "save this way of doing it as a procedure."')}
      </Text>
      <Button small onPress={() => ask(t("Show my saved procedures and help me choose one."))}>
        {t("Open in chat")}
      </Button>
      {values.map((value) => (
        <Button
          key={value.id}
          small
          onPress={() => {
            generation.current++;
            setBusy(false);
            setError("");
            setSelected(value);
            setInputs({});
            setStatus("");
            setHistory([]);
            setHistoryCursor(undefined);
          }}
        >
          {value.title} · v{value.version}
          {value.lifecycle === "archived" ? ` · ${t("Archived")}` : ""}
          {value.pinned ? ` · ${t("Pinned")}` : ""}
        </Button>
      ))}
      {selected && (
        <View style={{ gap: 8 }}>
          <Text style={s.heading}>
            {selected.title} · v{selected.version}
          </Text>
          {selected.steps.map((step, index) => (
            <Text key={String(index)} style={s.small}>
              {index + 1}. {step}
            </Text>
          ))}
          {selected.inputs.map((input) => (
            <Field
              key={input.name}
              label={`${input.label}${input.required ? " *" : ""}`}
              value={inputs[input.name] ?? ""}
              onChangeText={(value) => setInputs((old) => ({ ...old, [input.name]: value }))}
            />
          ))}
          {selected.lifecycle !== "archived" && (
            <Button busy={busy} onPress={() => void run()}>
              {t("Run or check pending request")}
            </Button>
          )}
          <Button
            small
            busy={busy}
            onPress={() => void manage(selected.lifecycle === "archived" ? "restore" : "archive")}
          >
            {t(selected.lifecycle === "archived" ? "Restore" : "Archive")}
          </Button>
          <Button small busy={busy} onPress={() => void manage(selected.pinned ? "unpin" : "pin")}>
            {t(selected.pinned ? "Unpin procedure" : "Pin procedure")}
          </Button>
          <Button small busy={busy} onPress={() => void loadHistory()}>
            {t("Version history")}
          </Button>
          {history
            .filter((version) => version.version !== selected.version)
            .map((version) => (
              <View key={version.version} style={{ gap: 4 }}>
                <Text style={s.small}>
                  v{version.version} · {version.savedAt}
                </Text>
                <Text style={s.small}>{version.steps.join("\n")}</Text>
                <Button small busy={busy} onPress={() => void manage("rollback", version.version)}>
                  {t("Restore this version")}
                </Button>
              </View>
            ))}
          {historyCursor && (
            <Button small busy={busy} onPress={() => void loadHistory(historyCursor)}>
              {t("Load more versions")}
            </Button>
          )}
        </View>
      )}
      {!!status && <Text style={s.small}>{status}</Text>}
      <ErrorNotice error={error} />
    </Card>
  );
}
