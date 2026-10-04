import { ArrowUpRight, Check, ChevronRight, type LucideIcon, X } from "lucide-react-native";
import { type ReactNode, useMemo } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAvatarPresentation } from "./avatar-presentation";
import { AvatarRenderer } from "./avatar-renderer";
import { credentialStatusSummary } from "./credential-prompts-state";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import type { ThemeColors } from "./theme-palette";

const createUIStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center" },
    between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    text: { color: colors.text, fontSize: 15, lineHeight: 23 },
    muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
    small: { color: colors.muted, fontSize: 11, lineHeight: 17 },
    label: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 1.4,
      textTransform: "uppercase",
    },
    title: { color: colors.text, fontSize: 23, fontWeight: "600", letterSpacing: -0.7 },
    heading: { color: colors.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.25 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 23,
      borderWidth: 0,
      borderColor: colors.line,
      padding: 20,
    },
    divider: { height: 1, backgroundColor: colors.line, marginVertical: 18 },
    input: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 19,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: colors.text,
      fontSize: 16,
      backgroundColor: colors.card,
      minHeight: 45,
    },
    field: { gap: 7, marginBottom: 16 },
    button: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingHorizontal: 17,
      minHeight: 42,
      paddingVertical: 10,
      borderRadius: 24,
    },
    primary: { backgroundColor: colors.blue },
    secondary: { backgroundColor: colors.subtle },
    buttonText: { color: colors.text, fontSize: 14, fontWeight: "600" },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 20,
      alignSelf: "flex-start",
      backgroundColor: colors.canvas,
    },
    chipText: { fontSize: 10, fontWeight: "600", color: colors.muted },
    iconBox: {
      width: 42,
      height: 42,
      borderRadius: 13,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.sky,
    },
    error: {
      padding: 16,
      borderRadius: 14,
      backgroundColor: colors.subtle,
      marginVertical: 10,
      gap: 4,
    },
    modalShade: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: "center",
      alignItems: "center",
      padding: 28,
    },
    sheet: {
      backgroundColor: colors.raised,
      borderRadius: 30,
      width: "100%",
      maxWidth: 760,
      maxHeight: "90%",
      overflow: "hidden",
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 16 },
      shadowOpacity: 0.18,
      shadowRadius: 48,
      elevation: 18,
    },
  });
export function Button({
  children,
  onPress,
  icon: Icon,
  primary,
  disabled,
  busy,
  small,
  danger,
  expanded,
  style,
}: {
  children: ReactNode;
  onPress: () => void;
  icon?: LucideIcon;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  danger?: boolean;
  expanded?: boolean;
  style?: ViewStyle;
}) {
  const { colors, s } = useUI();

  const color = danger ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      aria-disabled={!!(disabled || busy)}
      aria-busy={!!busy}
      aria-expanded={expanded}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        primary ? s.primary : s.secondary,
        small && { minHeight: 38, paddingVertical: 7, paddingHorizontal: 13 },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} size="small" />
      ) : Icon ? (
        <Icon size={15} color={color} />
      ) : null}
      <Text style={[s.buttonText, { color }]}>{children}</Text>
    </Pressable>
  );
}
export function IconButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useUI();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 22,
          backgroundColor: pressed ? colors.line : colors.card,
        },
      ]}
    >
      <Icon size={20} strokeWidth={1.8} color={colors.text} />
    </Pressable>
  );
}
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { s } = useUI();

  return <View style={[s.card, style]}>{children}</View>;
}
export function Chip({ children, tint }: { children: ReactNode; tint?: string }) {
  const { s } = useUI();

  return (
    <View style={[s.chip, tint ? { backgroundColor: tint } : null]}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const { colors, s } = useUI();

  return (
    <View style={s.field}>
      <Text style={[s.small, { fontWeight: "600", color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        accessibilityLabel={label}
        {...props}
        style={[
          s.input,
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
    </View>
  );
}
export function Empty({
  icon: Icon,
  title,
  detail,
  children,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  const { colors, s } = useUI();

  return (
    <View style={{ alignItems: "center", padding: 40, gap: 13 }}>
      <View style={[s.iconBox, { width: 55, height: 55, borderRadius: 18 }]}>
        <Icon size={24} color={colors.blueDark} />
      </View>
      <Text style={s.heading}>{title}</Text>
      <Text style={[s.muted, { textAlign: "center", maxWidth: 360 }]}>{detail}</Text>
      {children}
    </View>
  );
}
export function ErrorNotice({ error }: { error?: string }) {
  const { colors, s } = useUI();

  return error ? (
    <View accessibilityRole="alert" style={s.error}>
      <Text style={[s.text, { color: colors.danger }]}>{error}</Text>
    </View>
  ) : null;
}
/** Shared dialog surface: a centered desktop window and a safe-area mobile sheet. */
export function ModalSurface({
  children,
  onClose,
  onBack = onClose,
  label,
  width: maxWidth = 760,
  height,
}: {
  children: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  label: string;
  width?: number;
  height?: number;
}) {
  const { colors, s } = useUI();

  const { width, height: viewportHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 700;
  return (
    <Modal transparent animationType={compact ? "slide" : "fade"} visible onRequestClose={onBack}>
      <View style={[s.modalShade, compact && { padding: 0, justifyContent: "flex-end" }]}>
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={label}
          role={Platform.OS === "web" ? "dialog" : undefined}
          aria-modal={true}
          style={[
            s.sheet,
            { maxWidth },
            height !== undefined && { height: Math.min(height, viewportHeight * 0.9) },
            compact && {
              maxWidth: "100%",
              maxHeight: viewportHeight - insets.top - 12,
              ...(height !== undefined ? { height: viewportHeight - insets.top - 12 } : {}),
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          {compact && (
            <View
              style={{
                alignSelf: "center",
                width: 34,
                height: 4,
                borderRadius: 3,
                backgroundColor: colors.hover,
                marginTop: 9,
                marginBottom: 3,
              }}
            />
          )}
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function Sheet({
  title,
  subtitle,
  children,
  onClose,
  wide,
  scroll = true,
  contentStyle,
  headerAccessory,
  footer,
  embedded = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  scroll?: boolean;
  contentStyle?: ViewStyle;
  headerAccessory?: ReactNode;
  footer?: ReactNode;
  embedded?: boolean;
}) {
  const { colors, s } = useUI();

  const { width } = useWindowDimensions();
  const { t } = useI18n();
  const compact = width < 700;
  const bodyStyle = { padding: compact ? 20 : 26, ...contentStyle };
  const contents = (
    <>
      <View
        style={[
          s.between,
          {
            paddingHorizontal: compact ? 20 : 26,
            paddingTop: embedded ? 14 : 20,
            paddingBottom: embedded ? 14 : 20,
            gap: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
          },
        ]}
      >
        <View style={{ flex: 1, gap: 6 }}>
          {headerAccessory}
          <Text
            numberOfLines={embedded ? 1 : undefined}
            style={{
              color: colors.text,
              fontSize: embedded ? 15 : 18,
              fontWeight: "600",
              letterSpacing: -0.3,
            }}
          >
            {title}
          </Text>
          {!!subtitle && (
            <Text
              numberOfLines={embedded ? 1 : undefined}
              style={[s.muted, embedded && { fontSize: 12, lineHeight: 17 }]}
            >
              {subtitle}
            </Text>
          )}
        </View>
        <IconButton icon={X} label={t("Close details")} onPress={onClose} />
      </View>
      {scroll ? (
        <ScrollView
          style={{ flexShrink: 1 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={bodyStyle}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1, minHeight: 0 }, bodyStyle]}>{children}</View>
      )}
      {footer && (
        <View style={{ padding: 20, borderTopWidth: 1, borderTopColor: colors.line }}>
          {footer}
        </View>
      )}
    </>
  );
  return embedded ? (
    <View
      testID="desktop-workspace-surface"
      accessibilityLabel={title}
      style={{ flex: 1, minHeight: 0, backgroundColor: colors.canvas }}
    >
      {contents}
    </View>
  ) : (
    <ModalSurface
      onClose={onClose}
      label={title}
      width={wide ? 1040 : 760}
      height={!scroll ? 760 : undefined}
    >
      {contents}
    </ModalSurface>
  );
}
export function CheckRow({
  label,
  checked,
  onPress,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
}) {
  const { colors, s } = useUI();

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      aria-checked={checked}
      onPress={onPress}
      style={[s.row, { gap: 10, paddingVertical: 9 }]}
    >
      <View
        style={{
          width: 19,
          height: 19,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.text : colors.line,
          backgroundColor: checked ? colors.text : colors.card,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && <Check size={13} color={colors.onFeature} />}
      </View>
      <Text style={[s.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}
export function SectionHeading({
  title,
  action,
  onPress,
}: {
  title: string;
  action?: string;
  onPress?: () => void;
}) {
  const { colors, s } = useUI();

  return (
    <View style={[s.between, { marginBottom: 19 }]}>
      <Text style={s.heading}>{title}</Text>
      {action && onPress && (
        <Pressable accessibilityRole="button" onPress={onPress} style={[s.row, { gap: 5 }]}>
          <Text style={[s.small, { color: colors.text }]}>{action}</Text>
          <ArrowUpRight size={13} color={colors.muted} />
        </Pressable>
      )}
    </View>
  );
}
export function LinkRow({
  title,
  detail,
  onPress,
  icon: Icon,
  tint,
}: {
  title: string;
  detail?: string;
  onPress: () => void;
  icon: LucideIcon;
  tint?: string;
}) {
  const { colors, s } = useUI();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        s.row,
        { paddingVertical: 13, gap: 14, borderRadius: 10 },
        pressed && { backgroundColor: colors.canvas },
      ]}
    >
      <View style={[s.iconBox, { backgroundColor: tint || colors.sky }]}>
        <Icon size={19} color={colors.text} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[s.text, { fontWeight: "500" }]}>{title}</Text>
        {!!detail && <Text style={s.small}>{detail}</Text>}
      </View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
  );
}
/** Companion media shared by the floating header and the agent portrait. */
export function Mascot({
  size = 42,
  variant: _variant = "sky",
  framing = "full",
}: {
  size?: number;
  variant?: "sky" | "sand" | "lilac";
  framing?: "full" | "portrait";
}) {
  const presentation = useAvatarPresentation();
  return (
    <AvatarRenderer
      size={size}
      design={presentation.design}
      asset={presentation.asset}
      state={presentation.state}
      active={presentation.active}
      framing={framing}
    />
  );
}

/** The conversation stays visible beneath the floating companion. */
export function HeaderFade() {
  const { colors } = useUI();

  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: -20 }}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="companionHeaderFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.canvas} stopOpacity="1" />
            <Stop offset="0.55" stopColor={colors.canvas} stopOpacity="0.96" />
            <Stop offset="1" stopColor={colors.canvas} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#companionHeaderFade)" />
      </Svg>
    </View>
  );
}
export { dateLabel, relativeDate, timeLabel } from "./display-date";

export function resultSummary(value: string) {
  const credential = credentialStatusSummary(value);
  if (credential) return credential;
  return /^Saved to (?:sample|local) sent mail(?: · .+)?$/.test(value)
    ? "Reply saved in your local Sent mail."
    : value;
}

export function useUI() {
  const { colors } = useTheme();
  const s = useMemo(() => createUIStyles(colors), [colors]);
  return { colors, s };
}
