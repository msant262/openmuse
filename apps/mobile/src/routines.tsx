import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { Routine } from "../../../packages/domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { useI18n } from "./i18n";
import { cronDayTime, dayTimeCron } from "./routine-schedule";
import { Button, Card, ErrorNotice, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function RoutinesPanel() {
  const { s } = useUI();

  const { t, locale } = useI18n();
  const { api, ask } = useWorkspace(),
    { mutate } = useAgentWorkspace();
  const [routines, setRoutines] = useState<Routine[]>([]),
    [timezone, setTimezone] = useState("UTC"),
    [editing, setEditing] = useState<Routine | "new">();
  const [error, setError] = useState("");
  async function load() {
    const data = await api.request<{ routines: Routine[]; timezone: string }>(
      "/api/agent/routines",
    );
    setRoutines(data.routines);
    if (!editing) setTimezone(data.timezone);
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, [api]);
  async function control(value: Routine, remove = false) {
    try {
      await mutate(
        `/routines/${value.id}${remove ? "/delete" : ""}`,
        remove
          ? { expectedRevision: value.revision }
          : { enabled: !value.enabled, expectedRevision: value.revision },
      );
      await load();
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <Text style={s.heading}>{t("Routines")}</Text>
      <Text style={s.muted}>
        {t("Regular help, even when the app is closed. Results arrive in your main chat.")}
      </Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button small onPress={() => setEditing("new")}>
          {t("Add routine")}
        </Button>
        <Button
          small
          onPress={() =>
            ask(t("Help me create a recurring routine. Ask what I want and when it should run."))
          }
        >
          {t("Plan in chat")}
        </Button>
      </View>
      {routines.map((value) => (
        <View key={value.id} style={{ gap: 6 }}>
          <Text style={s.heading}>{value.title}</Text>
          <Text style={s.small}>
            {value.enabled
              ? t("Next: {date}", {
                  date: new Date(value.nextRunAt).toLocaleString(
                    locale === "pt-BR" ? "pt-BR" : "en-US",
                    { timeZone: value.timezone },
                  ),
                })
              : t("Paused")}{" "}
            · {value.timezone}
          </Text>
          <Text style={s.muted}>{value.prompt}</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button small onPress={() => setEditing(value)}>
              {t("Edit")}
            </Button>
            <Button small onPress={() => void control(value)}>
              {value.enabled ? t("Pause") : t("Resume")}
            </Button>
            <Button small onPress={() => void control(value, true)}>
              {t("Delete")}
            </Button>
          </View>
        </View>
      ))}
      {editing && (
        <RoutineEditor
          key={editing === "new" ? "new" : editing.id}
          value={editing === "new" ? undefined : editing}
          defaultTimezone={timezone}
          saved={() => {
            setEditing(undefined);
            void load().catch((e) => setError(String(e)));
          }}
          cancel={() => setEditing(undefined)}
        />
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
function RoutineEditor({
  value,
  defaultTimezone,
  saved,
  cancel,
}: {
  value?: Routine;
  defaultTimezone: string;
  saved: () => void;
  cancel: () => void;
}) {
  const { s } = useUI();

  const { t } = useI18n();
  const { mutate } = useAgentWorkspace(),
    parsed = value ? cronDayTime(value.cron) : undefined;
  const [title, setTitle] = useState(value?.title ?? ""),
    [prompt, setPrompt] = useState(value?.prompt ?? ""),
    [days, setDays] = useState(parsed?.days ?? [1, 2, 3, 4, 5]),
    [time, setTime] = useState(parsed?.time ?? "08:00"),
    [timezone, setTimezone] = useState(value?.timezone ?? defaultTimezone);
  const [advanced, setAdvanced] = useState(Boolean(value && !parsed)),
    [cron, setCron] = useState(value?.cron ?? "0 8 * * 1-5"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [key] = useState(() => `routine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  async function save() {
    setBusy(true);
    try {
      await mutate(`/routines${value ? `/${value.id}` : ""}`, {
        title,
        prompt,
        timezone,
        cron: advanced ? cron : dayTimeCron(days, time),
        ...(!value ? { idempotencyKey: key } : {}),
        ...(value ? { expectedRevision: value.revision } : {}),
      });
      saved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 10 }}>
      <Field label={t("Name")} value={title} onChangeText={setTitle} />
      <Field
        label={t("What should I do?")}
        value={prompt}
        onChangeText={setPrompt}
        placeholder={t("Read my calendar and send today's agenda here")}
      />
      {!advanced && (
        <>
          <View style={[s.row, { gap: 4, flexWrap: "wrap" }]}>
            {labels.map((label, day) => (
              <Button
                key={label}
                small
                primary={days.includes(day)}
                onPress={() =>
                  setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day])
                }
              >
                {t(label)}
              </Button>
            ))}
          </View>
          <Field
            label={t("Time (24-hour)")}
            value={time}
            onChangeText={setTime}
            placeholder="08:00"
          />
        </>
      )}
      <Field
        label={t("Timezone")}
        value={timezone}
        onChangeText={setTimezone}
        placeholder="Europe/Berlin"
      />
      <Button small onPress={() => setAdvanced(!advanced)}>
        {advanced ? t("Day and time") : t("Advanced schedule")}
      </Button>
      {advanced && <Field label={t("Cron schedule")} value={cron} onChangeText={setCron} />}
      <View style={[s.row, { gap: 8 }]}>
        <Button disabled={!title.trim() || !prompt.trim()} busy={busy} onPress={() => void save()}>
          {t("Save routine")}
        </Button>
        <Button onPress={cancel}>{t("Cancel")}</Button>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
