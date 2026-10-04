import { ArrowUpRight, Check, Globe2, RotateCw } from "lucide-react-native";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, Linking, Pressable, Text, View } from "react-native";
import { z } from "zod";
import type { ActionProposal, BrowserSession } from "../../../packages/domain/src";
import { resultSourceUrl } from "./artifact-presentation";
import { useI18n } from "./i18n";
import { useInlinePreview } from "./preview";
import { ResultCardFrame } from "./result-card-frame";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export const BrowserRunContext = createContext({ running: false, active: false });

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.url(),
});

function resultValue(result: unknown) {
  if (Array.isArray(result))
    return resultValue(result.find((part) => part?.type === "text")?.content);
  if (typeof result !== "string") return result;
  try {
    return resultValue(JSON.parse(result));
  } catch {
    return undefined;
  }
}

function siteLabel(url: unknown, t: (key: string) => string) {
  if (typeof url !== "string") return t("Opening a page");
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return t("Opening a page");
  }
}

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { api, workspace, open } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  const previewVisible = useInlinePreview(active);
  const working = loading && active;
  const value = resultValue(result);
  const observation = observationSchema.safeParse(value);
  const approval = z
    .object({ approvalRequired: z.literal(true), actionId: z.string() })
    .safeParse(value);
  const toolError = z.object({ error: z.string() }).safeParse(value);
  const sessionId = observation.success ? observation.data.sessionId : undefined;
  const current = workspace.browsers.find((browser) => browser.id === sessionId);
  const [browserState, setBrowserState] = useState<{ owner: string; session: BrowserSession }>();
  const browser =
    browserState?.owner === api.identityKey && browserState.session.id === sessionId
      ? browserState.session
      : undefined;
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [opening, setOpening] = useState(false);
  const scope = useRef<{ api: typeof api; sessionId?: string } | null>({ api, sessionId });
  scope.current = { api, sessionId };
  useEffect(() => {
    scope.current = { api, sessionId };
    setOpening(false);
    return () => {
      scope.current = null;
    };
  }, [api, sessionId]);

  useEffect(() => {
    if (!sessionId || !previewVisible) return;
    let active = true;
    async function connect() {
      setError("");
      setPreviewFailed(false);
      try {
        const session = await api.request<BrowserSession>(
          `/api/browsers/${encodeURIComponent(sessionId || "")}`,
        );
        if (active) setBrowserState({ owner: api.identityKey, session });
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, sessionId, current?.updatedAt, retry, previewVisible]);

  const visited = observation.success ? observation.data : undefined;
  // A later turn can reuse the same browser. Never label that new page as an old source.
  const preview =
    previewVisible &&
    browser?.status === "active" &&
    browser.url === visited?.url &&
    (!current || current.url === visited?.url) &&
    !previewFailed
      ? browser.previewUrl
      : undefined;
  const failure = toolError.success
    ? toolError.data.error
    : !loading && !visited && !approval.success
      ? t("The browser did not return a page. Try your request again.")
      : "";
  const source = resultSourceUrl(visited?.url);
  async function openBrowser() {
    const stillCurrent = () => scope.current?.api === api && scope.current.sessionId === sessionId;
    if (!sessionId || opening || !stillCurrent()) return;
    setOpening(true);
    setError("");
    try {
      // Opening saved history is explicit; background previews remain paused.
      const session = await api.request<BrowserSession>(
        `/api/browsers/${encodeURIComponent(sessionId)}`,
      );
      if (stillCurrent()) {
        setBrowserState({ owner: api.identityKey, session });
        open({ type: "browser", browser: session });
      }
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (stillCurrent()) setOpening(false);
    }
  }
  return (
    <ResultCardFrame>
      <View style={[s.row, { gap: 11, padding: 16 }]}>
        <View style={[s.iconBox, { width: 38, height: 38, borderRadius: 12 }]}>
          <Globe2 size={20} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={2} style={[s.heading, { fontSize: 15, lineHeight: 21 }]}>
            {visited?.title || t("Browser")}
          </Text>
          <Text numberOfLines={1} style={s.small}>
            {working
              ? t("Reading the page…")
              : loading
                ? t("Browsing paused")
                : approval.success
                  ? t("Waiting for approval")
                  : failure
                    ? t("Couldn’t read the page")
                    : siteLabel(visited?.url ?? url, t)}
          </Text>
        </View>
        {working ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : visited ? (
          <Check size={17} color={colors.success} accessibilityLabel={t("Page read")} />
        ) : null}
      </View>
      {preview && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open browser")}
          onPress={openBrowser}
        >
          <Image
            accessibilityLabel={t("Browser preview: {title}", { title: visited?.title ?? "" })}
            source={{ uri: api.url(preview) }}
            style={{ width: "100%", aspectRatio: 1.7, backgroundColor: colors.subtle }}
            resizeMode="contain"
            onError={() => setPreviewFailed(true)}
          />
        </Pressable>
      )}
      <View style={{ padding: 16, paddingTop: preview ? 14 : 0, gap: 10 }}>
        {!preview && visited && (
          <Text style={s.small}>
            {(browser && browser.url !== visited.url) || (current && current.url !== visited.url)
              ? t("Page visited. The browser has moved on.")
              : browser?.status === "closed"
                ? t("Session saved. Take control to reopen it.")
                : browser?.status === "error"
                  ? t("Session needs attention. Take control to reconnect.")
                  : previewFailed
                    ? t("Preview unavailable. You can still take control.")
                    : !previewVisible || browser
                      ? t("Page read")
                      : t("Connecting to the saved session…")}
          </Text>
        )}
        {approval.success && (
          <Button
            primary
            onPress={() => {
              void api
                .request<ActionProposal>(`/api/actions/${approval.data.actionId}`)
                .then((action) => open({ type: "review", action }))
                .catch((failure) =>
                  setError(failure instanceof Error ? failure.message : t("Review unavailable")),
                );
            }}
          >
            {t("Review action")}
          </Button>
        )}
        <ErrorNotice error={failure || error} />
        {visited && (
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button small busy={opening} disabled={opening} onPress={() => void openBrowser()}>
              {t("Open browser")}
            </Button>
            {source && (
              <Button
                small
                icon={ArrowUpRight}
                onPress={() =>
                  void Linking.openURL(source).catch((cause) =>
                    setError(cause instanceof Error ? cause.message : String(cause)),
                  )
                }
              >
                {t("View source")}
              </Button>
            )}
          </View>
        )}
        {!!error && (
          <Button small icon={RotateCw} onPress={() => setRetry((attempt) => attempt + 1)}>
            {t("Reconnect preview")}
          </Button>
        )}
      </View>
    </ResultCardFrame>
  );
}
