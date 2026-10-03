import {
  ArrowLeft,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Play,
  Power,
  RefreshCw,
  Save,
  Terminal,
  Upload,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Text, View } from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../packages/domain/src/computer";
import { useComputerDraft } from "./computer-drafts";
import { useI18n } from "./i18n";
import { Button, Card, colors, Empty, ErrorNotice, Field, LinkRow, s, timeLabel } from "./ui";
import { useWorkspace } from "./workspace";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function LinuxWorkspace({ tab }: { tab: "Terminal" | "Files" }) {
  const { t } = useI18n();
  const { api } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ComputerSnapshot>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useComputerDraft("command");
  const [cwd, setCwd] = useComputerDraft("cwd");
  const [executing, setExecuting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingCommand, setEditingCommand] = useState(false);
  const version = useRef(0);
  const polling = useRef(false);
  const mutations = useRef(0);
  const refresh = useCallback(async () => {
    if (polling.current || mutations.current) return;
    polling.current = true;
    const request = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>("/api/computer");
      if (request === version.current) {
        setSnapshot(next);
        setConnectionError("");
      }
    } catch (e) {
      if (request === version.current) setConnectionError(message(e));
    } finally {
      polling.current = false;
    }
  }, [api]);
  useEffect(() => {
    const poll = () => {
      if (AppState.currentState !== "active") return;
      void refresh();
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      version.current++;
      clearInterval(interval);
    };
  }, [refresh]);

  async function control(action: "start" | "stop") {
    if (busy) return;
    setBusy(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>(`/api/computer/${action}`, {});
      if (operation === version.current) setSnapshot(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      mutations.current--;
      void refresh();
    }
  }
  async function run() {
    if (!command.trim() || executing || busy) return;
    const sent = command;
    setExecuting(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const result = await api.request<ComputerCommand>("/api/computer/commands", {
        command: sent,
        cwd,
        ...(snapshot?.provider === "rpc" && { background: true }),
      });
      if (operation === version.current)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                commands: [result, ...current.commands.filter((item) => item.id !== result.id)],
              }
            : current,
        );
      setCommand((current) => (current === sent ? "" : current));
      setEditingCommand(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setExecuting(false);
      mutations.current--;
      void refresh();
    }
  }
  const running = snapshot?.status === "running";
  const commandRunning = executing || snapshot?.commands.some((item) => item.status === "running");
  return (
    <View style={{ gap: 16 }}>
      <Card style={{ backgroundColor: colors.sky, gap: 12 }}>
        <View style={[s.row, { gap: 12 }]}>
          <Terminal size={24} color={colors.blueDark} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>{t("Your Linux workspace")}</Text>
            <Text style={s.muted}>
              {running
                ? t("Running · files persist when stopped")
                : snapshot?.status === "stopped"
                  ? t("Stopped · your files are saved")
                  : snapshot?.status === "unconfigured"
                    ? t("Set up the computer to get started")
                    : snapshot?.status === "error"
                      ? t("Connection needs attention")
                      : t("Connecting…")}
            </Text>
          </View>
          {!snapshot && !error && <ActivityIndicator color={colors.blueDark} />}
        </View>
        {!!snapshot?.message && <Text style={s.small}>{snapshot.message}</Text>}
        {snapshot?.enabled && (
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {running ? (
              <Button icon={Power} busy={busy} onPress={() => void control("stop")}>
                {t("Stop computer")}
              </Button>
            ) : (
              <Button primary icon={Play} busy={busy} onPress={() => void control("start")}>
                {t("Start computer")}
              </Button>
            )}
            <Button
              icon={RefreshCw}
              disabled={busy}
              onPress={() =>
                void refresh()
                  .then(() => setError(""))
                  .catch((e) => setError(message(e)))
              }
            >
              {t("Refresh")}
            </Button>
          </View>
        )}
      </Card>
      <ErrorNotice error={error || connectionError} />
      {!snapshot && (error || connectionError) && (
        <Button
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(message(e)))
          }
        >
          {t("Retry connection")}
        </Button>
      )}
      {snapshot?.enabled && (
        <>
          <View style={{ display: tab === "Terminal" ? "flex" : "none", gap: 16 }}>
            {editingCommand || command.length > 0 || snapshot.commands.length === 0 ? (
              <View style={{ borderRadius: 22, backgroundColor: "#F1F3F4", padding: 18, gap: 8 }}>
                <Text style={{ color: colors.muted, fontSize: 12, fontFamily: mono }}>
                  {t("Terminal").toUpperCase()}
                </Text>
                <Field
                  label={t("Working directory")}
                  value={cwd}
                  onChangeText={setCwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ fontFamily: mono }}
                />
                <Field
                  label={t("Command")}
                  value={command}
                  onChangeText={setCommand}
                  placeholder={t("Type a command, such as pwd")}
                  multiline
                  maxLength={16000}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  smartInsertDelete={false}
                  keyboardType="ascii-capable"
                  style={{ fontFamily: mono, minHeight: 80 }}
                />
                {/[‘’“”]/.test(command) && (
                  <Button
                    small
                    onPress={() =>
                      setCommand((text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))
                    }
                  >
                    {t("Use straight quotes")}
                  </Button>
                )}
                <Button
                  primary
                  icon={Play}
                  busy={!!commandRunning}
                  disabled={!running || !command.trim() || busy}
                  onPress={() => void run()}
                >
                  {t("Run command")}
                </Button>
                <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                  {snapshot.network === "public-only"
                    ? t("Public internet enabled. Your files and background jobs stay here.")
                    : t("Offline computer. Use Browser for the web.")}
                </Text>
              </View>
            ) : (
              <Button
                primary
                icon={Terminal}
                disabled={!running || busy || !!commandRunning}
                onPress={() => setEditingCommand(true)}
              >
                {t("New command")}
              </Button>
            )}
            {!!commandRunning && (
              <Text style={s.muted}>
                {t(
                  "Working… The result will appear here. Stop the computer to end running commands.",
                )}
              </Text>
            )}
            {snapshot.commands.length === 0 ? (
              <Empty
                icon={Terminal}
                title={t("Ready for your first command")}
                detail={t(
                  "Run scripts, work with files, or ask your agent to create something here.",
                )}
              />
            ) : (
              [...snapshot.commands]
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                .slice(0, showHistory ? undefined : 5)
                .map((run) => <CommandReceipt key={run.id} run={run} />)
            )}
            {snapshot.commands.length > 5 && (
              <Button small onPress={() => setShowHistory(!showHistory)}>
                {showHistory ? t("Show recent commands") : t("Earlier commands")}
              </Button>
            )}
          </View>
          <View style={{ display: tab === "Files" ? "flex" : "none" }}>
            <ComputerFiles running={!!running} active={tab === "Files"} />
          </View>
        </>
      )}
    </View>
  );
}

function CommandReceipt({ run }: { run: ComputerCommand }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  return (
    <Card style={{ gap: 10 }}>
      <View style={[s.between, { gap: 10 }]}>
        <Text
          style={[
            s.small,
            {
              color:
                run.status === "succeeded"
                  ? "#248258"
                  : run.status === "running"
                    ? colors.blueDark
                    : colors.danger,
            },
          ]}
        >
          {t(run.status.replace("_", " "))}
          {run.exitCode !== undefined ? ` · ${t("exit {code}", { code: run.exitCode })}` : ""}
        </Text>
        <Text style={s.small}>{timeLabel(run.startedAt)}</Text>
      </View>
      <Text
        selectable
        style={[s.text, { fontFamily: mono, fontSize: 13 }]}
      >{`$ ${run.command}`}</Text>
      <Text style={[s.small, { fontFamily: mono }]}>{run.cwd}</Text>
      {expanded && (
        <>
          {!!run.stdout && (
            <Text selectable style={[s.text, { fontFamily: mono, fontSize: 12, lineHeight: 19 }]}>
              {run.stdout}
            </Text>
          )}
          {!!run.stderr && (
            <Text
              selectable
              style={[
                s.text,
                { fontFamily: mono, fontSize: 12, lineHeight: 19, color: colors.danger },
              ]}
            >
              {run.stderr}
            </Text>
          )}
          {!run.stdout && !run.stderr && run.status !== "running" && (
            <Text style={s.small}>{t("No output")}</Text>
          )}
          {run.truncated && (
            <Text style={s.small}>
              {t("Output reached the display limit. Write large results to a file.")}
            </Text>
          )}
        </>
      )}
      {!!(run.stdout || run.stderr) && (
        <Button small onPress={() => setExpanded(!expanded)}>
          {expanded ? t("Hide output") : t("Show output")}
        </Button>
      )}
    </Card>
  );
}

function ComputerFiles({ running, active }: { running: boolean; active: boolean }) {
  const { t } = useI18n();
  const { api, workspace, open, refresh } = useWorkspace();
  const [path, setPath] = useComputerDraft("path");
  const [directory, setDirectory] = useState<ComputerDirectory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useComputerDraft("editor");
  const [folder, setFolder] = useState<string>();
  const [importing, setImporting] = useState(false);
  const dirty = !!editor && (editor.text !== editor.saved || editor.path !== editor.savedPath);
  useEffect(() => {
    if (!active || !running) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    void api
      .request<ComputerDirectory>(`/api/computer/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        if (alive) setDirectory(value);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, active, running, path, retry]);

  async function read(file: string) {
    if (busy || loading || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const content = await api.request<{ path: string; text: string }>(
        "/api/computer/files/read",
        { path: file },
      );
      if (mounted.current) setEditor({ ...content, saved: content.text, savedPath: content.path });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function importDocument(file: Artifact) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/import", {
        fileId: file.id,
        path: `${path}/${file.name.replace(/[\\/]/g, "_")}`,
      });
      setImporting(false);
      setNotice(t("File copied to your computer."));
      setRetry((value) => value + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function openPdf(path: string) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>("/api/computer/files/export", { path });
      await refresh();
      if (mounted.current) open({ type: "file", file });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!editor || busy) return;
    const sent = editor;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/write", { path: sent.path, text: sent.text });
      if (mounted.current)
        setEditor((current) =>
          current?.path === sent.path
            ? { ...current, saved: sent.text, savedPath: sent.path }
            : current,
        );
      setNotice(t("File saved to your computer."));
      setRetry((value) => value + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function mkdir() {
    if (!folder?.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request("/api/computer/files/mkdir", { path: `${path}/${folder.trim()}` });
      setFolder(undefined);
      setRetry((value) => value + 1);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={s.heading}>{t("Workspace files")}</Text>
        {(busy || loading) && <ActivityIndicator color={colors.blueDark} />}
      </View>
      <Text selectable style={[s.small, { fontFamily: mono }]}>
        {editor?.path || path}
      </Text>
      <ErrorNotice error={error} />
      {!!notice && <Text style={[s.small, { color: "#248258" }]}>{notice}</Text>}
      {!running && (
        <Text style={s.muted}>{t("Start the computer to browse or edit its saved files.")}</Text>
      )}
      {editor ? (
        <>
          <Field
            label={t("File path")}
            value={editor.path}
            onChangeText={(value) => setEditor({ ...editor, path: value })}
            autoCorrect={false}
            autoCapitalize="none"
            style={{ fontFamily: mono }}
          />
          <Field
            label={t("File contents")}
            value={editor.text}
            onChangeText={(value) => setEditor({ ...editor, text: value })}
            multiline
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            keyboardType="ascii-capable"
            autoCapitalize="none"
            style={{ fontFamily: mono, minHeight: 240, fontSize: 13 }}
          />
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            <Button
              primary
              icon={Save}
              busy={busy}
              disabled={!running || !editor.path.trim()}
              onPress={() => void save()}
            >
              {t("Save file")}
            </Button>
            <Button
              disabled={busy}
              icon={ArrowLeft}
              onPress={() => {
                setEditor(undefined);
                setNotice("");
              }}
            >
              {dirty ? t("Discard edits") : t("Back to files")}
            </Button>
          </View>
        </>
      ) : (
        <>
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {path !== "/workspace" && (
              <Button
                small
                disabled={busy}
                icon={ArrowLeft}
                onPress={() => setPath(path.slice(0, path.lastIndexOf("/")) || "/workspace")}
              >
                {t("Up")}
              </Button>
            )}
            <Button
              small
              disabled={!running || busy}
              icon={FilePlus2}
              onPress={() => {
                setNotice("");
                setEditor({
                  path: `${path}/note-${Date.now()}.txt`,
                  text: "",
                  saved: "",
                  savedPath: "",
                });
              }}
            >
              {t("New file")}
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={FolderPlus}
              onPress={() => setFolder("")}
            >
              {t("New folder")}
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={RefreshCw}
              onPress={() => setRetry(retry + 1)}
            >
              {t("Refresh files")}
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={Upload}
              onPress={() => setImporting(!importing)}
            >
              {importing ? t("Hide documents") : t("Copy a document here")}
            </Button>
          </View>
          {importing && (
            <Card>
              <Text style={s.heading}>{t("Choose a saved file")}</Text>
              <Text style={[s.small, { marginTop: 6 }]}>
                {t("Copies into this folder. A file with the same name will be replaced.")}
              </Text>
              {workspace.files.map((file) => (
                <LinkRow
                  key={file.id}
                  icon={FileText}
                  title={file.name}
                  onPress={() => void importDocument(file)}
                />
              ))}
              {!workspace.files.length && (
                <Text style={s.muted}>{t("Add a document from mail or Files first.")}</Text>
              )}
            </Card>
          )}
          {folder !== undefined && (
            <Card style={{ gap: 8 }}>
              <Field
                label={t("Folder name")}
                value={folder}
                onChangeText={setFolder}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  primary
                  disabled={!running || !folder.trim()}
                  busy={busy}
                  onPress={() => void mkdir()}
                >
                  {t("Create folder")}
                </Button>
                <Button disabled={busy} onPress={() => setFolder(undefined)}>
                  {t("Cancel")}
                </Button>
              </View>
            </Card>
          )}
          {running &&
            directory?.path === path &&
            directory.entries.map((entry) => (
              <LinkRow
                key={entry.path}
                icon={entry.type === "directory" ? Folder : FileText}
                title={entry.name}
                detail={
                  entry.type === "directory"
                    ? t("Folder")
                    : entry.type === "symlink"
                      ? t("Symbolic link")
                      : `${Math.max(1, Math.ceil(entry.size / 1024))} KB`
                }
                onPress={() => {
                  if (busy || loading || !running) return;
                  if (entry.type === "directory") {
                    setNotice("");
                    setPath(entry.path);
                  } else if (
                    /\.(pdf|pptx|docx|xlsx|png|jpg|jpeg|webp|mp3|wav|m4a|mp4|webm|flac|srt)$/i.test(
                      entry.name,
                    )
                  )
                    void openPdf(entry.path);
                  else void read(entry.path);
                }}
              />
            ))}
          {running &&
            !busy &&
            !loading &&
            !error &&
            directory?.path === path &&
            directory.entries.length === 0 && (
              <Empty
                icon={Folder}
                title={t("A little space to create")}
                detail={t("Add a file here, or ask your agent to make one in its workspace.")}
              />
            )}
        </>
      )}
    </View>
  );
}
