import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import type { AvatarMotionState } from "../../../packages/domain/src/avatar";
import type {
  AvatarAsset,
  AvatarGeneration,
  AvatarStudioState,
} from "../../../packages/domain/src/avatar-character";
import { useAgentWorkspace } from "./agent-workspace";
import { AvatarRenderer } from "./avatar-renderer";
import { avatarStudioStyles as styles } from "./avatar-studio-styles";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, Field } from "./ui";
import { useWorkspace } from "./workspace";

type Target = { api: ReturnType<typeof useWorkspace>["api"]; identityKey: string };
type Scoped<T> = { target: Target; value: T };
type Action = {
  target: Target;
  path: string;
  body: Record<string, unknown>;
  kind: "generate" | "select" | "saved" | "retry" | "default";
};
type StudioError = { message: string; retry: "load" | "action" | "poll" };
const inProgress = (job?: AvatarGeneration) =>
  job?.status === "queued" || job?.status === "running";
const mergeAssets = (before: AvatarAsset[], next: AvatarAsset[]) => {
  const byId = new Map(before.map((asset) => [asset.id, asset]));
  for (const asset of next) byId.set(asset.id, asset);
  return [...byId.values()];
};

export function AvatarStudio({
  onPreviewActiveChange,
}: {
  onPreviewActiveChange?: (active: boolean) => void;
} = {}) {
  const { api, notify } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const columns = Platform.OS === "web" && width >= 1180;
  const [studio, setStudio] = useState<Scoped<AvatarStudioState>>();
  const [draft, setDraft] = useState<Scoped<string>>();
  const [focused, setFocused] = useState<Scoped<AvatarGeneration>>();
  const [choice, setChoice] = useState<Scoped<{ generationId: string; assetId: string }>>();
  const [pending, setPending] = useState<Scoped<Action["kind"]>>();
  const [loading, setLoading] = useState<Target>();
  const [failure, setFailure] = useState<Scoped<StudioError>>();
  const [confirmation, setConfirmation] = useState<Scoped<string>>();
  const [motion, setMotion] = useState<AvatarMotionState>("idle");
  const [pollVersion, setPollVersion] = useState(0);
  const target = useRef<Target | undefined>(undefined);
  const mounted = useRef(true);
  const operation = useRef<Action | undefined>(undefined);
  const retryAction = useRef<Action | undefined>(undefined);
  const readVersion = useRef(0);
  const mutationVersion = useRef(0);
  if (
    !target.current ||
    target.current.api !== api ||
    target.current.identityKey !== api.identityKey
  ) {
    target.current = { api, identityKey: api.identityKey };
    operation.current = undefined;
    retryAction.current = undefined;
    mutationVersion.current++;
  }
  const owner = target.current;
  const current = (expected: Target) =>
    mounted.current &&
    target.current === expected &&
    expected.api.identityKey === expected.identityKey;
  const data = studio?.target === owner ? studio.value : undefined;
  const prompt = draft?.target === owner ? draft.value : "";
  const job = focused?.target === owner ? focused.value : undefined;
  const selectedId =
    choice?.target === owner && choice.value.generationId === job?.id
      ? choice.value.assetId
      : job?.selectedAssetId;
  const selected = job?.candidates.find((asset) => asset.id === selectedId);
  const active = data?.assets.find((asset) => asset.id === data.activeAssetId);
  const preview = selected ?? active;
  const busy = pending?.target === owner;
  const error = failure?.target === owner ? failure.value : undefined;
  const working = inProgress(job);
  const confirming = confirmation?.target === owner && confirmation.value === job?.id;
  const selectedAssets = new Set(
    data?.generations.map((generation) => generation.selectedAssetId).filter(Boolean),
  );
  const gallery =
    data?.assets.filter(
      (asset) =>
        asset.source === "upload" ||
        asset.status !== "still" ||
        asset.id === data.activeAssetId ||
        selectedAssets.has(asset.id),
    ) ?? [];

  function updateJob(expected: Target, next: AvatarGeneration, apply = false) {
    if (!current(expected)) return;
    setFocused({ target: expected, value: next });
    setStudio((before) =>
      before?.target === expected
        ? {
            target: expected,
            value: {
              ...before.value,
              assets: mergeAssets(before.value.assets, next.candidates),
              generations: [
                next,
                ...before.value.generations.filter((item) => item.id !== next.id),
              ],
              activeAssetId: apply ? next.selectedAssetId : before.value.activeAssetId,
            },
          }
        : before,
    );
  }
  async function load(expected = owner) {
    if (!current(expected)) return;
    const version = ++readVersion.current;
    setLoading(expected);
    try {
      const next = await expected.api.request<AvatarStudioState>("/api/agent/avatars");
      if (!current(expected) || version !== readVersion.current) return;
      setStudio({ target: expected, value: next });
      setFocused((before) => {
        if (before?.target === expected) {
          const updated = next.generations.find((item) => item.id === before.value.id);
          return updated ? { target: expected, value: updated } : before;
        }
        const latest = next.generations.find((item) => item.status !== "succeeded");
        return latest ? { target: expected, value: latest } : undefined;
      });
      setFailure(undefined);
    } catch (cause) {
      if (current(expected) && version === readVersion.current)
        setFailure({
          target: expected,
          value: {
            message: cause instanceof Error ? cause.message : t("Could not load your companions."),
            retry: "load",
          },
        });
    } finally {
      if (current(expected) && version === readVersion.current) setLoading(undefined);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = undefined;
      readVersion.current++;
      mutationVersion.current++;
    };
  }, []);
  useEffect(() => {
    void load(owner);
    return () => {
      readVersion.current++;
    };
  }, [owner]);
  useEffect(() => {
    onPreviewActiveChange?.(true);
    return () => onPreviewActiveChange?.(false);
  }, [onPreviewActiveChange]);
  useEffect(() => {
    if (!job || !working || busy || error?.retry === "poll") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const expected = owner;
    const generationId = job.id;
    const version = mutationVersion.current;
    async function poll() {
      try {
        const next = await expected.api.request<AvatarGeneration>(
          `/api/agent/avatars/generations/${encodeURIComponent(generationId)}`,
        );
        if (!live || !current(expected) || version !== mutationVersion.current) return;
        updateJob(expected, next);
        if (inProgress(next)) timer = setTimeout(() => void poll(), 2500);
        else if (next.selectedAssetId === data?.activeAssetId) void refresh().catch(() => {});
      } catch (cause) {
        if (live && current(expected) && version === mutationVersion.current)
          setFailure({
            target: expected,
            value: {
              message:
                cause instanceof Error ? cause.message : t("Could not check generation progress."),
              retry: "poll",
            },
          });
      }
    }
    timer = setTimeout(() => void poll(), 1800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [owner, job?.id, job?.status, working, busy, error?.retry, pollVersion]);

  async function run(action: Action) {
    const expected = action.target;
    if (!current(expected) || operation.current?.target === expected) return;
    operation.current = action;
    retryAction.current = action;
    readVersion.current++;
    mutationVersion.current++;
    setPending({ target: expected, value: action.kind });
    setLoading(undefined);
    setFailure(undefined);
    setConfirmation(undefined);
    try {
      if (action.kind === "default") {
        await expected.api.request<{ selected: true }>(action.path, action.body);
        if (!current(expected)) return;
        setStudio((before) =>
          before?.target === expected
            ? { target: expected, value: { ...before.value, activeAssetId: undefined } }
            : before,
        );
        setFocused(undefined);
        setChoice(undefined);
      } else if (action.kind === "saved") {
        const asset = await expected.api.request<AvatarAsset>(action.path, action.body);
        if (!current(expected)) return;
        setStudio((before) =>
          before?.target === expected
            ? {
                target: expected,
                value: {
                  ...before.value,
                  assets: mergeAssets(before.value.assets, [asset]),
                  activeAssetId: asset.id,
                },
              }
            : before,
        );
        setFocused(undefined);
        setChoice(undefined);
      } else {
        const next = await expected.api.request<AvatarGeneration>(action.path, action.body);
        if (!current(expected)) return;
        updateJob(expected, next, action.kind === "select");
        if (action.kind === "generate") setChoice(undefined);
      }
      retryAction.current = undefined;
      if (action.kind === "select" || action.kind === "saved" || action.kind === "default") {
        notify(t("Companion saved"));
        void refresh().catch(() => {});
      }
    } catch (cause) {
      if (current(expected))
        setFailure({
          target: expected,
          value: {
            message:
              cause instanceof Error
                ? cause.message
                : t("Could not update your companion. Your description is still here."),
            retry: "action",
          },
        });
    } finally {
      if (operation.current === action) operation.current = undefined;
      if (current(expected)) setPending(undefined);
    }
  }
  function generate() {
    if (!current(owner) || !data?.capabilities.images || !prompt.trim() || busy || working) return;
    void run({
      target: owner,
      path: "/api/agent/avatars/generations",
      body: { requestId: Crypto.randomUUID(), prompt: prompt.trim() },
      kind: "generate",
    });
  }
  function selectCandidate() {
    if (!current(owner) || !job || !selected || job.status !== "awaiting_selection" || busy) return;
    void run({
      target: owner,
      path: `/api/agent/avatars/generations/${encodeURIComponent(job.id)}/select`,
      body: { requestId: Crypto.randomUUID(), assetId: selected.id },
      kind: "select",
    });
  }
  function retryGeneration(acknowledgeUncertain = false) {
    if (!current(owner) || !job?.retryable || busy) return;
    if (job.status === "uncertain" && !acknowledgeUncertain) {
      setConfirmation({ target: owner, value: job.id });
      return;
    }
    void run({
      target: owner,
      path: `/api/agent/avatars/generations/${encodeURIComponent(job.id)}/retry`,
      body: {
        requestId: Crypto.randomUUID(),
        ...(acknowledgeUncertain ? { acknowledgeUncertain: true } : {}),
      },
      kind: "retry",
    });
  }
  function retryFailure() {
    if (!current(owner) || busy) return;
    if (error?.retry === "action" && retryAction.current?.target === owner)
      void run(retryAction.current);
    else if (error?.retry === "poll") {
      setFailure(undefined);
      setPollVersion((value) => value + 1);
    } else void load(owner);
  }
  const phaseLabel = job?.phase === "videos" ? "Creating animations…" : "Creating four companions…";
  return (
    <View style={styles.studio}>
      <View style={styles.introduction}>
        <Text style={styles.title}>{t("Your companion")}</Text>
        <Text style={styles.description}>
          {t("Imagine a companion that feels like you. Describe it, then choose your favorite.")}
        </Text>
      </View>
      <View style={[styles.layout, { flexDirection: columns ? "row" : "column" }]}>
        <View style={[styles.portraitColumn, columns && { width: 280 }]}>
          <View style={styles.preview}>
            <AvatarRenderer
              key={`${owner.identityKey}:${preview?.id ?? "default"}`}
              asset={preview}
              state={motion}
              framing="full"
              size={Math.min(242, width - 100)}
              accessibilityLabel={t("Companion preview")}
            />
            <Text style={styles.characterName}>{preview?.label ?? t("Your companion")}</Text>
            <Text style={styles.hint}>
              {t(
                preview?.id === data?.activeAssetId && preview
                  ? "Your saved companion"
                  : selected
                    ? "Preview your choice"
                    : "A familiar face, made for you",
              )}
            </Text>
          </View>
          <View style={styles.motionRow}>
            {(
              [
                ["idle", "Idle"],
                ["thinking", "Working"],
                ["talking", "Responding"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityState={{ selected: motion === value }}
                onPress={() => setMotion(value)}
                style={[styles.motionButton, motion === value && styles.motionSelected]}
              >
                <Text style={styles.motionText}>{t(label)}</Text>
              </Pressable>
            ))}
          </View>
          {preview?.status === "animating" && (
            <Text style={styles.hint}>
              {t(
                "Your companion is applied. Its portrait stays visible while animations are created.",
              )}
            </Text>
          )}
          <Text style={styles.hint}>
            {t("Motion follows your device’s accessibility settings.")}
          </Text>
        </View>
        <View style={[styles.creationColumn, { flex: columns ? 1 : undefined }]}>
          <Field
            label={t("Describe your companion")}
            value={prompt}
            placeholder={t(
              "A little cream-colored forest spirit with a soft hood and a gentle smile…",
            )}
            multiline
            maxLength={2000}
            editable={!busy}
            onChangeText={(value) => {
              if (current(owner)) setDraft({ target: owner, value });
            }}
          />
          <Text style={styles.description}>
            {t(
              "Any creature, character, color or personality. We’ll create four directions for you.",
            )}
          </Text>
          {loading === owner && <Text style={styles.hint}>{t("Loading your companions…")}</Text>}
          {data && !data.capabilities.images && (
            <View style={styles.notice}>
              <Text style={styles.description}>
                {data.capabilities.reason ??
                  t("Image generation is unavailable. Your description will stay here.")}
              </Text>
              <Button small onPress={() => void load(owner)} disabled={busy}>
                {t("Check availability")}
              </Button>
            </View>
          )}
          {data?.capabilities.images && !data.capabilities.videos && (
            <Text style={styles.hint}>
              {data.capabilities.reason ??
                t("You can create a portrait now. Animation generation is currently unavailable.")}
            </Text>
          )}
          <Button
            primary
            busy={busy && pending.value === "generate"}
            disabled={!data?.capabilities.images || !prompt.trim() || busy || working}
            onPress={generate}
          >
            {t("Generate companions")}
          </Button>
          {error && (
            <View style={styles.notice}>
              <ErrorNotice error={error.message} />
              <Button disabled={busy || loading === owner} onPress={retryFailure}>
                {t("Try again")}
              </Button>
            </View>
          )}
          {job && (
            <View style={styles.generation}>
              {working && (
                <View
                  style={styles.progress}
                  accessibilityRole="text"
                  accessibilityLiveRegion="polite"
                >
                  <ActivityIndicator size="small" color="#697176" />
                  <Text style={styles.description}>{t(phaseLabel)}</Text>
                </View>
              )}
              {job.status === "awaiting_selection" && (
                <Text style={styles.sectionTitle}>{t("Which one feels like your companion?")}</Text>
              )}
              {job.candidates.length > 0 && (
                <View style={styles.candidates}>
                  {[job.candidates.slice(0, 2), job.candidates.slice(2, 4)]
                    .filter((row) => row.length > 0)
                    .map((row) => (
                      <View style={styles.candidateRow} key={row[0].id}>
                        {row.map((asset) => {
                          const index = job.candidates.findIndex((item) => item.id === asset.id);
                          const checked = asset.id === selectedId;
                          return (
                            <Pressable
                              key={asset.id}
                              accessibilityRole="radio"
                              accessibilityLabel={t("Choose option {number}", {
                                number: index + 1,
                              })}
                              accessibilityState={{
                                checked,
                                disabled: busy || job.status !== "awaiting_selection",
                              }}
                              aria-checked={checked}
                              disabled={busy || job.status !== "awaiting_selection"}
                              onPress={() => {
                                if (current(owner))
                                  setChoice({
                                    target: owner,
                                    value: { generationId: job.id, assetId: asset.id },
                                  });
                              }}
                              style={[
                                styles.candidate,
                                checked && styles.candidateSelected,
                                !!selectedId && !checked && styles.candidateDimmed,
                              ]}
                            >
                              <AvatarRenderer
                                asset={asset}
                                active={false}
                                reducedMotion
                                framing="full"
                                size={columns ? 134 : Math.min(134, (width - 116) / 2)}
                                accessibilityLabel={t("Option {number}", { number: index + 1 })}
                              />
                              <Text style={styles.optionText}>
                                {t("Option {number}", { number: index + 1 })}
                              </Text>
                              {checked && (
                                <View style={styles.check}>
                                  <Text style={styles.checkText}>✓</Text>
                                </View>
                              )}
                            </Pressable>
                          );
                        })}
                      </View>
                    ))}
                </View>
              )}
              {job.status === "awaiting_selection" && (
                <Button
                  primary
                  disabled={!selected || busy}
                  busy={busy && pending.value === "select"}
                  onPress={selectCandidate}
                >
                  {t("Select companion")}
                </Button>
              )}
              {job.selectedAssetId && (
                <Text style={styles.hint}>
                  {t(
                    job.phase === "videos" && working
                      ? "Your companion is applied. Its portrait stays visible while animations are created."
                      : "Your companion is saved in your gallery.",
                  )}
                </Text>
              )}
              {job.error && <ErrorNotice error={job.error} />}
              {job.retryable && !confirming && (
                <Button disabled={busy} onPress={() => retryGeneration()}>
                  {t("Retry generation")}
                </Button>
              )}
              {confirming && (
                <View style={styles.notice}>
                  <Text style={styles.description}>
                    {t(
                      "The previous result could not be confirmed. Trying again may create another generation and use additional provider credits.",
                    )}
                  </Text>
                  <View style={styles.actions}>
                    <Button primary disabled={busy} onPress={() => retryGeneration(true)}>
                      {t("Confirm new attempt")}
                    </Button>
                    <Button onPress={() => setConfirmation(undefined)}>{t("Cancel")}</Button>
                  </View>
                </View>
              )}
            </View>
          )}
        </View>
      </View>
      <View style={styles.gallerySection}>
        <Button
          small
          disabled={busy || !data || !data.activeAssetId}
          onPress={() => {
            if (!current(owner) || !data?.activeAssetId) return;
            void run({
              target: owner,
              path: "/api/agent/avatars/default/select",
              body: { requestId: Crypto.randomUUID() },
              kind: "default",
            });
          }}
        >
          {t("Use default companion")}
        </Button>
        <View style={styles.galleryHeader}>
          <Text style={styles.sectionTitle}>{t("Your companions")}</Text>
          <Button
            small
            disabled={busy || working}
            onPress={() => {
              if (!current(owner)) return;
              setFocused(undefined);
              setChoice(undefined);
              setConfirmation(undefined);
              setFailure(undefined);
              setDraft({ target: owner, value: "" });
            }}
          >
            {t("Create another")}
          </Button>
        </View>
        {gallery.length === 0 ? (
          <Text style={styles.description}>{t("The companions you choose will live here.")}</Text>
        ) : (
          <View style={styles.gallery}>
            {gallery.map((asset) => (
              <Pressable
                key={asset.id}
                accessibilityRole="button"
                accessibilityLabel={t("Use {name}", { name: asset.label })}
                accessibilityState={{ selected: data?.activeAssetId === asset.id, disabled: busy }}
                disabled={busy}
                onPress={() => {
                  if (!current(owner)) return;
                  void run({
                    target: owner,
                    path: `/api/agent/avatars/${encodeURIComponent(asset.id)}/select`,
                    body: { requestId: Crypto.randomUUID() },
                    kind: "saved",
                  });
                }}
                style={[
                  styles.savedCard,
                  data?.activeAssetId === asset.id && styles.candidateSelected,
                ]}
              >
                <AvatarRenderer
                  asset={asset}
                  active={false}
                  reducedMotion
                  framing="portrait"
                  size={88}
                  accessibilityLabel={asset.label}
                />
                <Text style={styles.savedName} numberOfLines={2}>
                  {asset.label}
                </Text>
                {data?.activeAssetId === asset.id && (
                  <Text style={styles.activeLabel}>{t("Selected")}</Text>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
