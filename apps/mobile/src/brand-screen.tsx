import { type ReactNode, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Image, Platform, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, Ellipse, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

export const brandMark = require("../public/okami-mark.png");

function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    if (Platform.OS === "web") {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReduced(media.matches);
      update();
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => {});
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      mounted = false;
      listener.remove();
    };
  }, []);
  return reduced;
}

export function BrandBackdrop({ children }: { children: ReactNode }) {
  const { scheme } = useTheme();
  const dark = scheme === "dark";
  return (
    <View style={{ flex: 1, backgroundColor: dark ? "#0B1018" : "#F8FAFF" }}>
      <View
        pointerEvents="none"
        accessible={false}
        style={{ position: "absolute", inset: 0, overflow: "hidden" }}
      >
        <Svg
          width="100%"
          height="100%"
          viewBox="0 0 1000 1100"
          preserveAspectRatio="xMidYMid slice"
        >
          <Defs>
            <RadialGradient id="cyanGlow">
              <Stop offset="0" stopColor="#00DCE8" stopOpacity={dark ? 0.16 : 0.13} />
              <Stop offset="1" stopColor="#00DCE8" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="violetGlow">
              <Stop offset="0" stopColor="#A234FF" stopOpacity={dark ? 0.18 : 0.1} />
              <Stop offset="1" stopColor="#A234FF" stopOpacity="0" />
            </RadialGradient>
            <LinearGradient id="brandArc" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#00DCE8" stopOpacity="0" />
              <Stop offset=".5" stopColor="#00DCE8" stopOpacity={dark ? 0.6 : 0.3} />
              <Stop offset="1" stopColor="#E21EFF" stopOpacity="0" />
            </LinearGradient>
          </Defs>
          <Ellipse cx="925" cy="100" rx="460" ry="420" fill="url(#cyanGlow)" />
          <Ellipse cx="70" cy="1020" rx="400" ry="420" fill="url(#violetGlow)" />
          <Path
            d="M 620 -90 Q 1010 95 1040 485"
            fill="none"
            stroke="url(#brandArc)"
            strokeWidth="1.5"
          />
          <Path
            d="M -40 670 Q 20 1040 360 1190"
            fill="none"
            stroke="url(#brandArc)"
            strokeWidth="1.5"
          />
        </Svg>
      </View>
      <SafeAreaView style={{ flex: 1 }}>{children}</SafeAreaView>
    </View>
  );
}

export function BrandLockup({ compact = false }: { compact?: boolean }) {
  const { scheme } = useTheme();
  const { t } = useI18n();
  return (
    <View style={{ alignItems: "center", gap: 2 }}>
      <Image
        source={brandMark}
        accessible={false}
        resizeMode="contain"
        style={{ width: compact ? 116 : 172, height: compact ? 116 : 172 }}
      />
      <Text
        accessibilityRole="header"
        style={{
          fontSize: compact ? 32 : 42,
          fontWeight: "800",
          letterSpacing: -1.8,
          color: scheme === "dark" ? "#F4F7FB" : "#121925",
        }}
      >
        Okami<Text style={{ color: scheme === "dark" ? "#00DCE8" : "#007D91" }}>Bot</Text>
      </Text>
      <Text
        style={{
          fontSize: 10,
          letterSpacing: 2.2,
          textTransform: "uppercase",
          color: scheme === "dark" ? "#ADB7C8" : "#536177",
          marginTop: 10,
        }}
      >
        {t("Your AI companion")}
      </Text>
    </View>
  );
}

function LoadingDots({ label }: { label: string }) {
  const reduced = useReducedMotion();
  const values = useRef([
    new Animated.Value(1),
    new Animated.Value(1),
    new Animated.Value(1),
  ]).current;
  useEffect(() => {
    if (reduced) {
      for (const value of values) value.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.stagger(
        160,
        values.map((value) =>
          Animated.sequence([
            Animated.timing(value, {
              toValue: 0.25,
              duration: 450,
              useNativeDriver: Platform.OS !== "web",
            }),
            Animated.timing(value, {
              toValue: 1,
              duration: 450,
              useNativeDriver: Platform.OS !== "web",
            }),
          ]),
        ),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [reduced, values]);
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      aria-busy
      style={{ flexDirection: "row", gap: 9, padding: 8 }}
    >
      {values.map((opacity, index) => (
        <Animated.View
          key={["cyan", "teal", "violet"][index]}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            opacity,
            backgroundColor: ["#00C9DE", "#00DCE8", "#C42CEF"][index],
          }}
        />
      ))}
    </View>
  );
}

export function BrandLoading({ label, children }: { label: string; children?: ReactNode }) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <BrandBackdrop>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          alignItems: "center",
          padding: 28,
          gap: 24,
        }}
      >
        <BrandLockup />
        {children ?? (
          <>
            <LoadingDots label={label} />
            <Text style={{ color: colors.muted, fontSize: 15, textAlign: "center" }}>{label}</Text>
          </>
        )}
        <Text
          style={{
            color: colors.faint,
            fontSize: 10,
            letterSpacing: 2,
            textAlign: "center",
            marginTop: 24,
          }}
        >
          {t("A brighter tomorrow, together.")}
        </Text>
      </ScrollView>
    </BrandBackdrop>
  );
}
