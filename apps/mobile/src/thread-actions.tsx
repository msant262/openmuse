import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { useMuseThread } from "./threads";
import { Button, ErrorNotice, Field, ModalSurface, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function ThreadActions({
  id,
  name,
  archived = false,
  existing = true,
  main = false,
}: {
  id: string;
  name: string;
  archived?: boolean;
  existing?: boolean;
  main?: boolean;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { api } = useWorkspace();
  const { changed, forget, select, selection, mainId } = useMuseThread();
  const [mode, setMode] = useState<"menu" | "rename" | "delete">();
  const [title, setTitle] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: "rename" | "archive" | "delete") {
    setBusy(true);
    setError("");
    try {
      if (action === "delete") {
        const result = existing
          ? await api.request<{ mainThreadId?: string }>(
              `/api/copilotkit/threads/${encodeURIComponent(id)}?stopActive=true`,
              undefined,
              "DELETE",
            )
          : {};
        forget(id, result.mainThreadId);
      } else {
        await api.request(
          `/api/copilotkit/threads/${encodeURIComponent(id)}`,
          {
            agentId: "default",
            ...(action === "rename" ? { name: title.trim() } : { archived: !archived }),
          },
          "PATCH",
        );
        if (action === "archive" && !archived && selection.id === id)
          select({ id: mainId, existing: true });
        changed();
      }
      setMode(undefined);
    } catch (cause) {
      setError(t(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Conversation actions: {name}", { name })}
        onPress={() => {
          setTitle(name);
          setError("");
          setMode("menu");
        }}
        style={{
          width: 30,
          height: 38,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
        }}
      >
        <MoreHorizontal size={17} color={colors.muted} />
      </Pressable>
      {mode && (
        <ModalSurface
          label={t(mode === "delete" ? "Delete conversation?" : "Conversation actions")}
          onClose={() => {
            if (!busy) setMode(undefined);
          }}
          width={460}
        >
          <ScrollView contentContainerStyle={{ padding: 24, gap: 18 }}>
            <Text style={s.heading}>
              {t(
                mode === "delete"
                  ? "Delete conversation?"
                  : mode === "rename"
                    ? "Rename conversation"
                    : "Conversation actions",
              )}
            </Text>
            <Text numberOfLines={2} style={s.muted}>
              {name}
            </Text>
            {mode === "menu" && (
              <View style={{ gap: 8 }}>
                {existing && (
                  <Button small icon={Pencil} onPress={() => setMode("rename")}>
                    {t("Rename")}
                  </Button>
                )}
                {existing && !main && (
                  <Button
                    small
                    icon={archived ? ArchiveRestore : Archive}
                    busy={busy}
                    onPress={() => void run("archive")}
                  >
                    {t(archived ? "Restore" : "Archive")}
                  </Button>
                )}
                <Button
                  small
                  danger
                  icon={Trash2}
                  disabled={busy}
                  onPress={() => setMode("delete")}
                >
                  {t("Delete conversation")}
                </Button>
              </View>
            )}
            {mode === "rename" && (
              <Field label={t("Conversation name")} value={title} onChangeText={setTitle} />
            )}
            {mode === "delete" && (
              <Text style={s.text}>
                {t(
                  "The conversation and draft will be deleted. Any reply and unfinished tasks in this conversation will stop. Saved files and memories remain available. This cannot be undone.",
                )}
              </Text>
            )}
            <ErrorNotice error={error} />
            <View style={[s.row, { justifyContent: "flex-end", flexWrap: "wrap", gap: 10 }]}>
              <Button small disabled={busy} onPress={() => setMode(undefined)}>
                {t("Cancel")}
              </Button>
              {mode === "rename" && (
                <Button
                  small
                  primary
                  busy={busy}
                  disabled={!title.trim()}
                  onPress={() => void run("rename")}
                >
                  {t("Save name")}
                </Button>
              )}
              {mode === "delete" && (
                <Button small danger busy={busy} onPress={() => void run("delete")}>
                  {t("Delete conversation")}
                </Button>
              )}
            </View>
          </ScrollView>
        </ModalSurface>
      )}
    </>
  );
}
