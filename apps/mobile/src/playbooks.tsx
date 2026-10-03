import * as Crypto from "expo-crypto";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ProcedureVersion } from "../../../packages/domain/src/playbooks";
import { messageStorage } from "./message-storage";
import { Button, Card, ErrorNotice, Field, s } from "./ui";
import { useWorkspace } from "./workspace";

export function PlaybooksPanel() {
  const { api, ask } = useWorkspace();
  const [values, setValues] = useState<ProcedureVersion[]>([]);
  const [selected, setSelected] = useState<ProcedureVersion>();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
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
    };
  }, [api]);
  async function run() {
    if (!selected || busy) return;
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
      setStatus(
        `${result.status === "queued" ? "Na fila" : result.status}: ${result.id}. Acompanhe em Tarefas.`,
      );
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.heading}>Procedimentos salvos</Text>
      <Text style={s.muted}>
        Depois de uma tarefa concluída, peça no chat: “guarde esse jeito de fazer como
        procedimento”.
      </Text>
      <Button
        small
        onPress={() => ask("Mostre meus procedimentos salvos e me ajude a escolher um.")}
      >
        Ver no chat
      </Button>
      {values.map((value) => (
        <Button
          key={value.id}
          small
          onPress={() => {
            setSelected(value);
            setInputs({});
            setStatus("");
          }}
        >
          {value.title} · v{value.version}
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
          <Button busy={busy} onPress={() => void run()}>
            Executar ou consultar pedido pendente
          </Button>
        </View>
      )}
      {!!status && <Text style={s.small}>{status}</Text>}
      <ErrorNotice error={error} />
    </Card>
  );
}
