import { Check, Copy, MoreHorizontal, Reply, Share2 } from "lucide-react-native";
import { type ReactNode, useRef, useState } from "react";
import {
  Clipboard,
  Modal,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "./i18n";
import { useUI } from "./ui";

async function copyMessage(text: string) {
  if (Platform.OS !== "web") {
    Clipboard.setString(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const selection = document.createElement("textarea");
  selection.value = text;
  selection.style.position = "fixed";
  selection.style.opacity = "0";
  document.body.append(selection);
  selection.select();
  const copied = document.execCommand("copy");
  selection.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

/** Long press, right click, or the keyboard-accessible overflow opens message actions. */
export function MessageBubble({
  children,
  text,
  user,
  contextual,
  onQuote,
}: {
  children: ReactNode;
  text: string;
  user: boolean;
  contextual: boolean;
  onQuote?: () => void;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const anchor = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    top: number;
    width: number;
    height: number;
  }>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  function showMenu() {
    setError("");
    setCopied(false);
    anchor.current?.measureInWindow((x, y, bubbleWidth, bubbleHeight) => {
      setMenu({ x, y: y + bubbleHeight + 7, top: y, width: bubbleWidth, height: bubbleHeight });
    });
  }
  async function copy() {
    try {
      await copyMessage(text);
      setCopied(true);
      setError("");
    } catch {
      setError(t("Could not copy this message."));
    }
  }
  async function share() {
    try {
      if (Platform.OS === "web") {
        if (navigator.share) await navigator.share({ text });
        else {
          await copy();
          return;
        }
      } else await Share.share({ message: text });
      setMenu(undefined);
    } catch (cause) {
      if (cause instanceof Error && cause.name === "AbortError") return;
      setError(t("Could not share this message."));
    }
  }
  const menuWidth = Math.min(244, width - 32);
  const menuHeight = (onQuote ? 3 : 2) * 48 + 16 + (error ? 66 : 0);
  return (
    <View
      ref={anchor}
      collapsable={false}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Pressable
        accessible={false}
        onLongPress={showMenu}
        delayLongPress={420}
        {...(Platform.OS === "web"
          ? {
              onContextMenu: (event: { preventDefault: () => void }) => {
                event.preventDefault();
                showMenu();
              },
            }
          : {})}
        style={{
          paddingHorizontal: 15,
          paddingVertical: 10,
          borderRadius: 23,
          borderBottomRightRadius: user ? 18 : 23,
          borderBottomLeftRadius: user ? 23 : 18,
          backgroundColor: user ? colors.blue : colors.subtle,
        }}
      >
        {children}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Message actions")}
        aria-expanded={!!menu}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={showMenu}
        style={({ pressed }) => ({
          position: "absolute",
          ...(user ? { left: contextual ? -30 : -26 } : { right: contextual ? -30 : -26 }),
          top: 3,
          width: contextual ? 30 : 26,
          height: 36,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 18,
          opacity: hovered || focused || pressed ? 1 : contextual ? 0 : 0.45,
          backgroundColor: pressed || focused ? colors.subtle : "transparent",
        })}
      >
        <MoreHorizontal size={18} strokeWidth={1.7} color={colors.muted} />
      </Pressable>
      {!!menu && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setMenu(undefined)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.17)" }}>
            <Pressable
              accessible={false}
              onPress={() => setMenu(undefined)}
              style={StyleSheet.absoluteFill}
            />
            <View
              pointerEvents="none"
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{
                position: "absolute",
                left: menu.x,
                top: menu.top,
                width: menu.width,
                height: menu.height,
                overflow: "hidden",
                paddingHorizontal: 15,
                paddingVertical: 10,
                borderRadius: 23,
                borderBottomRightRadius: user ? 18 : 23,
                borderBottomLeftRadius: user ? 23 : 18,
                backgroundColor: user ? colors.blue : colors.subtle,
              }}
            >
              {children}
            </View>
            <View
              accessibilityViewIsModal
              accessibilityLabel={t("Message actions")}
              role={Platform.OS === "web" ? "dialog" : undefined}
              aria-modal={true}
              style={{
                position: "absolute",
                left: Math.max(
                  16,
                  Math.min(user ? menu.x + menu.width - menuWidth : menu.x, width - menuWidth - 16),
                ),
                top: Math.max(
                  insets.top + 16,
                  Math.min(menu.y, height - menuHeight - insets.bottom - 16),
                ),
                width: menuWidth,
                borderRadius: 23,
                overflow: "hidden",
                backgroundColor: colors.card,
                paddingVertical: 6,
                shadowColor: colors.shadow,
                shadowOffset: { width: 0, height: 8 },
                shadowOpacity: 0.13,
                shadowRadius: 28,
                elevation: 10,
              }}
            >
              {onQuote && (
                <MessageAction
                  icon={Reply}
                  label={t("Reply")}
                  onPress={() => {
                    setMenu(undefined);
                    onQuote();
                  }}
                />
              )}
              <MessageAction
                icon={copied ? Check : Copy}
                label={t(copied ? "Copied" : "Copy")}
                onPress={() => void copy()}
              />
              <MessageAction icon={Share2} label={t("Share")} onPress={() => void share()} last />
              {!!error && (
                <Text style={[s.small, { padding: 12, color: colors.danger }]}>{error}</Text>
              )}
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

function MessageAction({
  icon: Icon,
  label,
  onPress,
  last,
}: {
  icon: typeof Copy;
  label: string;
  onPress: () => void;
  last?: boolean;
}) {
  const { colors } = useUI();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 15,
        minHeight: 48,
        paddingHorizontal: 18,
        backgroundColor: pressed ? colors.subtle : "transparent",
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: colors.line,
      })}
    >
      <Icon size={21} strokeWidth={1.65} color={colors.text} />
      <Text style={{ color: colors.text, fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}
