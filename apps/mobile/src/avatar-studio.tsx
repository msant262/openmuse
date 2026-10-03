import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentIdentity, AgentWorkspace } from "../../../packages/domain/src/agent";
import {
  AVATAR_PRESETS,
  type AvatarDesign,
  type AvatarMotionState,
  avatarDesignSchema,
  resolveAvatarDesign,
} from "../../../packages/domain/src/avatar";
import { useAgentWorkspace } from "./agent-workspace";
import { AvatarRenderer } from "./avatar-renderer";
import { AvatarThumbnail } from "./avatar-thumbnail";
import { useI18n } from "./i18n";
import { Button, ErrorNotice, Field } from "./ui";
import { useWorkspace } from "./workspace";

const speciesNames = { capybara: "Capybara", wolf: "Wolf", fox: "Fox", cat: "Cat", robot: "Robot" };
const shapeNames = { round: "Round", balanced: "Balanced", slender: "Slender" };
const accessoryNames = {
  none: "None",
  scarf: "Scarf",
  glasses: "Glasses",
  leaf: "Leaf",
  headphones: "Headphones",
};
const motionNames = { idle: "Idle", thinking: "Thinking", talking: "Talking" };
const colorChoices = [
  { color: "#B88A62", name: "Warm sand" },
  { color: "#8299AC", name: "Cloud blue" },
  { color: "#A29ACB", name: "Soft lilac" },
  { color: "#E58A4F", name: "Fox orange" },
  { color: "#AACBC8", name: "Sage green" },
  { color: "#F1D9B8", name: "Cream" },
  { color: "#E9ACA7", name: "Rose pink" },
  { color: "#302C35", name: "Charcoal" },
  { color: "#69CAD8", name: "Teal" },
  { color: "#78533A", name: "Hazel" },
];
type Target = { api: ReturnType<typeof useWorkspace>["api"]; identityKey: string };
type ScopedDesign = { target: Target; design: AvatarDesign };

export function AvatarStudio({
  onPreviewActiveChange,
}: {
  onPreviewActiveChange?: (active: boolean) => void;
} = {}) {
  const { api, notify } = useWorkspace();
  const { refresh } = useAgentWorkspace();
  const { t } = useI18n();
  const [saved, setSaved] = useState<ScopedDesign>();
  const [draft, setDraft] = useState<ScopedDesign>();
  const [pending, setPending] = useState<Target>();
  const [error, setError] = useState<{ target: Target; message: string }>();
  const [motion, setMotion] = useState<AvatarMotionState>("idle");
  const [rendererKind, setRendererKind] = useState<"webgl" | "fallback">();
  const [colorText, setColorText] = useState<{
    key: "bodyColor" | "accentColor" | "eyeColor";
    value: string;
  }>();
  const target = useRef<Target | undefined>(undefined);
  const mounted = useRef(true);
  const operation = useRef<Target | undefined>(undefined);
  const request = useRef(0);
  if (
    !target.current ||
    target.current.api !== api ||
    target.current.identityKey !== api.identityKey
  ) {
    target.current = { api, identityKey: api.identityKey };
    operation.current = undefined;
  }
  const currentTarget = target.current;
  const savedDesign = saved?.target === currentTarget ? saved.design : undefined;
  const design = draft?.target === currentTarget ? draft.design : resolveAvatarDesign(undefined);
  const busy = pending === currentTarget;
  const changed = savedDesign && JSON.stringify(savedDesign) !== JSON.stringify(design);
  const errorMessage = error?.target === currentTarget ? error.message : "";
  const current = (expected: Target) =>
    mounted.current &&
    target.current === expected &&
    expected.identityKey === expected.api.identityKey;
  function choose(value: AvatarDesign) {
    if (!savedDesign || busy || !current(currentTarget)) return;
    setDraft({ target: currentTarget, design: value });
    setColorText(undefined);
    setError(undefined);
  }
  function edit<K extends keyof AvatarDesign>(key: K, value: AvatarDesign[K]) {
    choose({ ...design, preset: "custom", [key]: value });
  }
  async function load(expected = currentTarget) {
    const version = ++request.current;
    try {
      const workspace = await expected.api.request<AgentWorkspace>("/api/agent");
      if (!current(expected) || version !== request.current) return;
      const value = {
        target: expected,
        design: resolveAvatarDesign(workspace.identity.avatarDesign),
      };
      setSaved(value);
      setDraft(value);
      setColorText(undefined);
      setError(undefined);
    } catch {
      if (current(expected) && version === request.current)
        setError({ target: expected, message: "Could not load your companion. Try again." });
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load(currentTarget);
    return () => {
      request.current++;
    };
  }, [currentTarget]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current = undefined;
    };
  }, []);
  useEffect(() => {
    onPreviewActiveChange?.(true);
    return () => {
      onPreviewActiveChange?.(false);
    };
  }, [onPreviewActiveChange]);
  async function save() {
    const expected = currentTarget;
    if (!savedDesign || !current(expected) || operation.current === expected) return;
    const parsed = avatarDesignSchema.safeParse(design);
    if (!parsed.success) return;
    operation.current = expected;
    setPending(expected);
    setError(undefined);
    try {
      const identity = await expected.api.request<AgentIdentity>("/api/agent/identity", {
        avatarDesign: parsed.data,
      });
      if (!current(expected)) return;
      const value = { target: expected, design: resolveAvatarDesign(identity.avatarDesign) };
      setSaved(value);
      setDraft(value);
      notify(t("Companion saved"));
      await refresh().catch(() => {});
    } catch {
      if (current(expected))
        setError({
          target: expected,
          message: "Could not save your companion. Your changes are still here.",
        });
    } finally {
      if (operation.current === expected) operation.current = undefined;
      if (current(expected)) setPending(undefined);
    }
  }
  function option(label: string, selected: boolean, onPress: () => void, key = label) {
    return (
      <Pressable
        key={key}
        accessibilityRole="radio"
        accessibilityLabel={t("Choose {name}", { name: t(label) })}
        accessibilityState={{ checked: selected, disabled: busy || !savedDesign }}
        disabled={busy || !savedDesign}
        onPress={onPress}
        style={[styles.option, selected && styles.selected]}
      >
        <Text style={[styles.optionText, selected && styles.selectedText]}>{t(label)}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.studio}>
      <View style={{ gap: 6 }}>
        <Text style={styles.title}>{t("Your companion")}</Text>
        <Text style={styles.description}>
          {t("Choose a 3D companion or create your own. The live preview reacts as you edit.")}
        </Text>
      </View>
      <View style={styles.preview}>
        <AvatarRenderer
          design={design}
          state={motion}
          interactive
          size={250}
          accessibilityLabel={t("3D companion preview")}
          fallbackLabel={t("Static preview · 3D unavailable on this device")}
          onReady={setRendererKind}
        />
        <Text style={styles.previewLabel}>
          {rendererKind === "fallback"
            ? t("Static preview · 3D unavailable on this device")
            : savedDesign
              ? t("Live 3D preview")
              : t("Loading your companion…")}
        </Text>
        <Text style={styles.hint}>{t("Motion follows your device’s accessibility settings.")}</Text>
      </View>
      {errorMessage && <ErrorNotice error={t(errorMessage)} />}
      {!savedDesign && errorMessage && (
        <Button onPress={() => void load()}>{t("Try again")}</Button>
      )}
      <Text style={styles.label}>{t("Ready-made companions")}</Text>
      <View style={styles.presetRow}>
        {AVATAR_PRESETS.map((preset) => (
          <Pressable
            key={preset.species}
            accessibilityRole="radio"
            accessibilityLabel={t("Choose {name}", { name: t(speciesNames[preset.species]) })}
            accessibilityState={{
              checked: design.preset === preset.preset,
              disabled: busy || !savedDesign,
            }}
            disabled={busy || !savedDesign}
            onPress={() => choose({ ...preset })}
            style={[styles.preset, design.preset === preset.preset && styles.selected]}
          >
            <AvatarThumbnail species={preset.species} size={78} />
            <Text
              style={[styles.optionText, design.preset === preset.preset && styles.selectedText]}
            >
              {t(speciesNames[preset.species])}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !savedDesign}
        onPress={() => choose({ ...design, preset: "custom" })}
        style={[styles.custom, design.preset === "custom" && styles.selected]}
      >
        <Text style={styles.customTitle}>{t("Create your own")}</Text>
        <Text style={styles.description}>
          {t("Start from the current companion and make it yours.")}
        </Text>
      </Pressable>
      {design.preset === "custom" && (
        <View style={styles.controls}>
          <Text style={styles.label}>{t("Species")}</Text>
          <View style={styles.options}>
            {Object.entries(speciesNames).map(([key, label]) =>
              option(label, design.species === key, () =>
                edit("species", key as AvatarDesign["species"]),
              ),
            )}
          </View>
          <Text style={styles.label}>{t("Body shape")}</Text>
          <View style={styles.options}>
            {Object.entries(shapeNames).map(([key, label]) =>
              option(label, design.bodyShape === key, () =>
                edit("bodyShape", key as AvatarDesign["bodyShape"]),
              ),
            )}
          </View>
          {(["bodyColor", "accentColor", "eyeColor"] as const).map((key) => {
            const label =
              key === "bodyColor"
                ? "Body color"
                : key === "accentColor"
                  ? "Accent color"
                  : "Eye color";
            const fieldLabel =
              key === "bodyColor"
                ? "Custom body color"
                : key === "accentColor"
                  ? "Custom accent color"
                  : "Custom eye color";
            const raw = colorText?.key === key ? colorText.value : design[key];
            const invalid = !/^#[0-9a-fA-F]{6}$/.test(raw);
            return (
              <View key={key} style={{ gap: 10 }}>
                <Text style={styles.label}>{t(label)}</Text>
                <View style={styles.options}>
                  {colorChoices.map((choice) => (
                    <Pressable
                      key={choice.color}
                      accessibilityRole="radio"
                      accessibilityLabel={t("Choose {name} color", { name: t(choice.name) })}
                      accessibilityState={{
                        checked: design[key].toLowerCase() === choice.color.toLowerCase(),
                        disabled: busy,
                      }}
                      disabled={busy}
                      onPress={() => edit(key, choice.color)}
                      style={[
                        styles.swatchRing,
                        design[key].toLowerCase() === choice.color.toLowerCase() && styles.selected,
                      ]}
                    >
                      <View style={[styles.swatch, { backgroundColor: choice.color }]} />
                    </Pressable>
                  ))}
                </View>
                <Field
                  label={t(fieldLabel)}
                  value={raw}
                  maxLength={7}
                  autoCapitalize="characters"
                  editable={!busy}
                  onChangeText={(value) => {
                    setColorText({ key, value });
                    if (/^#[0-9a-fA-F]{6}$/.test(value))
                      setDraft({ target: currentTarget, design: { ...design, [key]: value } });
                  }}
                />
                {invalid && (
                  <Text style={styles.hint}>
                    {t("Use a six-digit hex color, such as #8299AC.")}
                  </Text>
                )}
              </View>
            );
          })}
          <Text style={styles.label}>{t("Accessory")}</Text>
          <View style={styles.options}>
            {Object.entries(accessoryNames).map(([key, label]) =>
              option(label, design.accessory === key, () =>
                edit("accessory", key as AvatarDesign["accessory"]),
              ),
            )}
          </View>
        </View>
      )}
      <View style={{ gap: 10 }}>
        <Text style={styles.label}>{t("Preview animation")}</Text>
        <View style={styles.options}>
          {Object.entries(motionNames).map(([key, label]) =>
            option(label, motion === key, () => setMotion(key as AvatarMotionState)),
          )}
        </View>
      </View>
      <View style={styles.options}>
        <Button
          primary
          busy={busy}
          disabled={
            !savedDesign || !changed || !!(colorText && !/^#[0-9a-fA-F]{6}$/.test(colorText.value))
          }
          onPress={() => void save()}
        >
          {t("Save companion")}
        </Button>
        {changed && (
          <Button disabled={busy} onPress={() => choose({ ...savedDesign })}>
            {t("Restore saved design")}
          </Button>
        )}
      </View>
      <Text style={styles.hint}>
        {t(changed ? "Changes are not saved yet" : "Your saved companion")}
      </Text>
      <Text style={styles.hint}>
        {t("The avatar changes appearance only. Name and personality are edited below.")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  studio: { gap: 18, width: "100%" },
  title: { color: "#332E3C", fontSize: 22, fontWeight: "600" },
  description: { color: "#736C7B", fontSize: 13, lineHeight: 20 },
  label: { color: "#51495F", fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  hint: { color: "#82798B", fontSize: 11, lineHeight: 17 },
  preview: {
    backgroundColor: "#F7F3ED",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#E9E1D8",
    alignItems: "center",
    paddingBottom: 18,
    gap: 5,
  },
  previewLabel: { color: "#625570", fontSize: 12, fontWeight: "500" },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  preset: {
    width: 94,
    paddingVertical: 8,
    alignItems: "center",
    backgroundColor: "#FAF8F5",
    borderWidth: 1,
    borderColor: "#E6E0E9",
    borderRadius: 16,
    gap: 3,
  },
  selected: { borderColor: "#8D78B2", backgroundColor: "#F1ECF7" },
  selectedText: { color: "#715296" },
  optionText: { color: "#645D70", fontSize: 12 },
  options: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  option: {
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#E3DDE8",
    backgroundColor: "#FAF8FB",
  },
  custom: { padding: 16, borderWidth: 1, borderColor: "#E3DDE8", borderRadius: 16, gap: 5 },
  customTitle: { fontSize: 14, fontWeight: "600", color: "#625170" },
  controls: { gap: 14, paddingVertical: 4 },
  swatchRing: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 21,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatch: { width: 31, height: 31, borderRadius: 16, borderWidth: 1, borderColor: "#FFFFFF" },
});
