import { ArrowLeft, ChevronRight, Grid2X2, Link2, Search } from "lucide-react-native";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { CredentialInteractionRequest } from "../../../packages/domain/src/runtime";
import { ComposioSetup } from "./composio-setup";
import {
  appendCatalogPage,
  type ComposioAccount,
  type ConnectionCatalog,
  type ConnectionToolkit,
  catalogPath,
  connectionStatusLabel,
} from "./connections-state";
import { useCredentialPrompts } from "./credential-prompts";
import { useI18n } from "./i18n";
import { IntegrationSettings } from "./integration-settings";
import { McpConnections } from "./mcp-connections";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type AccountsResponse = {
  configured: boolean;
  connections: ComposioAccount[];
  pendingRequests: CredentialInteractionRequest[];
};

function ServiceLogo({ item }: { item: Pick<ConnectionToolkit, "slug" | "name" | "logo"> }) {
  const { colors } = useUI();

  const [failed, setFailed] = useState(false);
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: 11,
        backgroundColor: colors.subtle,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {item.logo && /^https:\/\//i.test(item.logo) && !failed ? (
        <Image
          source={{ uri: item.logo }}
          accessibilityLabel={item.name}
          onError={() => setFailed(true)}
          style={{ width: 25, height: 25 }}
          resizeMode="contain"
        />
      ) : (
        <Grid2X2 size={20} color={colors.muted} />
      )}
    </View>
  );
}

export function ConnectionsCatalog({
  query: externalQuery,
  nativeConnections,
}: {
  query?: string;
  nativeConnections: (
    query: string,
    selectToolkit: (toolkit: ConnectionToolkit) => void,
  ) => ReactNode;
}) {
  const { colors, s } = useUI();

  const { api, notify } = useWorkspace();
  const { t } = useI18n();
  const prompts = useCredentialPrompts();
  const [tab, setTab] = useState<"explore" | "connected">("explore");
  const [search, setSearch] = useState("");
  const query = externalQuery ?? search;
  const [debounced, setDebounced] = useState(query);
  const [category, setCategory] = useState("");
  const [configured, setConfigured] = useState<boolean>();
  const [catalog, setCatalog] = useState<ConnectionCatalog>();
  const [accounts, setAccounts] = useState<ComposioAccount[]>([]);
  const [pending, setPending] = useState<CredentialInteractionRequest[]>([]);
  const [selected, setSelected] = useState<ConnectionToolkit>();
  const [confirmDisconnect, setConfirmDisconnect] = useState<string>();
  const [error, setError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [updateKey, setUpdateKey] = useState(false);
  const generation = useRef(0);
  const accountGeneration = useRef(0);
  const reload = useCallback(async () => {
    const current = ++accountGeneration.current;
    const result = await api.request<AccountsResponse>("/api/composio/connections");
    if (current !== accountGeneration.current) return;
    setConfigured(result.configured);
    setAccounts(result.connections);
    setPending(result.pendingRequests ?? []);
    setAccountError("");
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const poll = () => {
      if (
        AppState.currentState === "background" ||
        (Platform.OS === "web" && typeof document !== "undefined" && document.hidden)
      )
        return;
      void reload().catch(() => setAccountError(t("Saved connections could not be loaded.")));
    };
    poll();
    const timer = setInterval(poll, 5000);
    const subscription = AppState.addEventListener("change", (value) => {
      if (value === "active") poll();
    });
    if (Platform.OS === "web" && typeof document !== "undefined")
      document.addEventListener("visibilitychange", poll);
    return () => {
      ++accountGeneration.current;
      clearInterval(timer);
      subscription.remove();
      if (Platform.OS === "web" && typeof document !== "undefined")
        document.removeEventListener("visibilitychange", poll);
    };
  }, [reload, t]);
  useEffect(() => {
    const current = ++generation.current;
    setCatalog(undefined);
    setError("");
    if (!configured || tab !== "explore") {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .request<ConnectionCatalog>(catalogPath(debounced, category))
      .then((result) => {
        if (generation.current === current) setCatalog(result);
      })
      .catch(() => {
        if (generation.current === current)
          setError(t("The app catalog could not be loaded. Try again."));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      ++generation.current;
    };
  }, [api, configured, tab, debounced, category, attempt, t]);
  useEffect(() => {
    if (!selected || !configured) return;
    let active = true;
    void api
      .request<ConnectionToolkit>(`/api/composio/toolkits/${encodeURIComponent(selected.slug)}`)
      .then((result) => {
        if (active) setSelected(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, configured, selected?.slug]);

  async function more() {
    if (!catalog?.nextCursor || loading) return;
    const current = generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.request<ConnectionCatalog>(
        catalogPath(debounced, category, catalog.nextCursor),
      );
      if (generation.current === current)
        setCatalog((previous) => ({
          ...result,
          items: appendCatalogPage(previous?.items ?? [], result.items),
        }));
    } catch {
      if (generation.current === current)
        setError(t("The app catalog could not be loaded. Try again."));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }
  async function connect(item: ConnectionToolkit, replace = false) {
    if (!configured) return;
    setBusy(item.slug);
    setError("");
    try {
      const result = await api.request<{ request: CredentialInteractionRequest }>(
        `/api/composio/toolkits/${encodeURIComponent(item.slug)}/connect`,
        { replace, purpose: t("Connect this app to use it in your conversations") },
      );
      setSelected(undefined);
      prompts?.show(result.request);
      await reload();
    } catch {
      setError(t("Could not start this connection. Try again."));
    } finally {
      setBusy(undefined);
    }
  }
  async function disconnect(account: ComposioAccount) {
    setBusy(account.id);
    setError("");
    try {
      await api.request(
        `/api/composio/connections/${encodeURIComponent(account.id)}/disconnect`,
        {},
      );
      setConfirmDisconnect(undefined);
      await reload();
      notify(t("Account disconnected."));
    } catch {
      setError(t("The connection could not be removed. Try again."));
    } finally {
      setBusy(undefined);
    }
  }
  const matchingAccounts = accounts.filter((item) =>
    `${item.serviceName} ${item.toolkit} ${item.alias ?? ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const serviceAccounts = selected
    ? accounts.filter((account) => account.toolkit === selected.slug)
    : [];
  if (selected)
    return (
      <View style={{ gap: 20 }}>
        <Button
          small
          icon={ArrowLeft}
          onPress={() => {
            setSelected(undefined);
            setError("");
            setConfirmDisconnect(undefined);
          }}
        >
          {t("Back to connections")}
        </Button>
        <View style={[s.row, { gap: 12 }]}>
          <ServiceLogo item={selected} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={s.heading}>{selected.name}</Text>
            <Text style={s.small}>
              {selected.categories.map((item) => t(item.name)).join(" · ")}
            </Text>
          </View>
        </View>
        <Text style={s.muted}>{selected.description}</Text>
        {serviceAccounts.map((account) => (
          <View
            key={account.id}
            style={{ padding: 15, backgroundColor: colors.subtle, borderRadius: 16, gap: 12 }}
          >
            <Text style={s.text}>{account.alias || account.serviceName}</Text>
            <Text style={s.small}>{t(connectionStatusLabel(account.status))}</Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button
                small
                disabled={!!busy || !configured}
                busy={busy === selected.slug}
                onPress={() => void connect(selected, true)}
              >
                {t("Reconnect")}
              </Button>
              <Button small disabled={!!busy} onPress={() => setConfirmDisconnect(account.id)}>
                {t("Disconnect")}
              </Button>
            </View>
            {confirmDisconnect === account.id && (
              <>
                <Text style={s.muted}>
                  {t(
                    "Disconnect {service}? Your agent will no longer have access to this account.",
                    { service: account.serviceName },
                  )}
                </Text>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  <Button small onPress={() => setConfirmDisconnect(undefined)} disabled={!!busy}>
                    {t("Cancel")}
                  </Button>
                  <Button
                    small
                    danger
                    busy={busy === account.id}
                    disabled={!!busy}
                    onPress={() => void disconnect(account)}
                  >
                    {t("Disconnect")}
                  </Button>
                </View>
              </>
            )}
          </View>
        ))}
        {configured === false ? (
          <ComposioSetup
            onConnected={() => {
              setConfigured(true);
              setAttempt((value) => value + 1);
              void reload().catch(() =>
                setAccountError(t("Saved connections could not be loaded.")),
              );
              void prompts?.refresh().catch(() => {});
            }}
          />
        ) : configured === undefined ? (
          <ActivityIndicator color={colors.muted} />
        ) : selected.noAuth ? (
          <Text style={s.muted}>{t("This app is ready to use without an account.")}</Text>
        ) : (
          <>
            <Text style={s.small}>
              {t(
                "Your agent gains access after you authorize the account. You can disconnect it here at any time.",
              )}
            </Text>
            <Button
              primary
              icon={Link2}
              busy={busy === selected.slug}
              disabled={!!busy || !prompts}
              onPress={() => void connect(selected)}
            >
              {t(serviceAccounts.length ? "Connect another account" : "Connect account")}
            </Button>
          </>
        )}
        <ErrorNotice error={accountError} />
        {!!accountError && (
          <Button small onPress={() => void reload().catch(() => {})}>
            {t("Retry")}
          </Button>
        )}
        <ErrorNotice error={error} />
      </View>
    );
  return (
    <View style={{ gap: 18 }}>
      <View
        style={{
          flexDirection: "row",
          padding: 4,
          borderRadius: 14,
          backgroundColor: colors.subtle,
          gap: 4,
        }}
      >
        {(["explore", "connected"] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)}
            style={{
              flex: 1,
              paddingVertical: 10,
              alignItems: "center",
              borderRadius: 10,
              backgroundColor: tab === value ? colors.card : "transparent",
            }}
          >
            <Text style={[s.text, { fontSize: 13, fontWeight: tab === value ? "600" : "400" }]}>
              {t(value === "explore" ? "Explore apps" : "Your connections")}
            </Text>
          </Pressable>
        ))}
      </View>
      {externalQuery === undefined && (
        <View
          style={[
            s.row,
            { gap: 9, borderRadius: 24, paddingHorizontal: 14, backgroundColor: colors.subtle },
          ]}
        >
          <Search size={17} color={colors.muted} />
          <TextInput
            accessibilityLabel={t("Search connectors")}
            placeholder={t("Search connectors")}
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            style={{ flex: 1, minWidth: 0, paddingVertical: 12, color: colors.text, fontSize: 14 }}
          />
        </View>
      )}
      <ErrorNotice error={accountError} />
      {configured === undefined && !accountError && <ActivityIndicator color={colors.muted} />}
      {!!accountError && (
        <Button small onPress={() => void reload().catch(() => {})}>
          {t("Retry")}
        </Button>
      )}
      {pending
        .filter((item) => item.schema.serviceName.toLowerCase().includes(query.toLowerCase()))
        .map((request) => (
          <Pressable
            key={request.id}
            accessibilityRole="button"
            onPress={() => prompts?.show(request)}
            style={[
              s.row,
              { gap: 12, padding: 14, borderRadius: 16, backgroundColor: colors.subtle },
            ]}
          >
            <Link2 size={19} color={colors.blueDark} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={s.text}>{request.schema.serviceName}</Text>
              <Text style={s.small}>{t("Finish connecting")}</Text>
            </View>
            <ChevronRight size={16} color={colors.muted} />
          </Pressable>
        ))}
      {tab === "explore" ? (
        <>
          {configured === false && (
            <ComposioSetup
              onConnected={() => {
                setConfigured(true);
                setAttempt((value) => value + 1);
                void reload().catch(() => {});
                void prompts?.refresh().catch(() => {});
              }}
            />
          )}
          {configured && (
            <>
              <Text style={s.muted}>
                {t("Find the apps your agent can work with, then connect the accounts you choose.")}
              </Text>
              {catalog?.categories.length || category ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 7 }}
                >
                  <Button small primary={!category} onPress={() => setCategory("")}>
                    {t("All apps")}
                  </Button>
                  {catalog?.categories.map((item) => (
                    <Button
                      key={item.id}
                      small
                      primary={category === item.id}
                      onPress={() => setCategory(item.id)}
                    >
                      {t(item.name)}
                    </Button>
                  ))}
                </ScrollView>
              ) : null}
              <View>
                {catalog?.items.map((item) => (
                  <Pressable
                    key={item.slug}
                    accessibilityRole="button"
                    accessibilityLabel={t("Manage {name}", { name: item.name })}
                    onPress={() => {
                      setSelected(item);
                      setError("");
                    }}
                    style={[
                      s.row,
                      {
                        gap: 12,
                        paddingVertical: 15,
                        borderBottomWidth: 1,
                        borderBottomColor: colors.line,
                      },
                    ]}
                  >
                    <ServiceLogo item={item} />
                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                      <Text style={[s.text, { fontWeight: "500" }]}>{item.name}</Text>
                      <Text style={s.small} numberOfLines={2}>
                        {item.description}
                      </Text>
                      {accounts.some(
                        (account) =>
                          account.toolkit === item.slug &&
                          connectionStatusLabel(account.status) === "Connected",
                      ) && (
                        <Text style={[s.small, { color: colors.success }]}>{t("Connected")}</Text>
                      )}
                    </View>
                    <ChevronRight size={16} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
              {loading && <ActivityIndicator color={colors.muted} />}
              {!loading && catalog?.items.length === 0 && (
                <Text style={s.muted}>
                  {t("No matching connectors. Try another name or category.")}
                </Text>
              )}
              <ErrorNotice error={error} />
              {!!error && (
                <Button small onPress={() => setAttempt((value) => value + 1)}>
                  {t("Retry")}
                </Button>
              )}
              {!!catalog?.nextCursor && (
                <Button disabled={loading} onPress={() => void more()}>
                  {t("Show more apps")}
                </Button>
              )}
            </>
          )}
        </>
      ) : (
        <>
          {matchingAccounts.length > 0 && (
            <View style={{ gap: 5 }}>
              <Text style={s.small}>{t("Connected apps")}</Text>
              {matchingAccounts.map((account) => (
                <Pressable
                  key={account.id}
                  accessibilityRole="button"
                  accessibilityLabel={t("Manage {name}", { name: account.serviceName })}
                  onPress={() =>
                    setSelected({
                      slug: account.toolkit,
                      name: account.serviceName,
                      description: "",
                      categories: [],
                      authSchemes: [],
                      noAuth: false,
                      deprecated: false,
                    })
                  }
                  style={[
                    s.row,
                    {
                      gap: 12,
                      paddingVertical: 13,
                      borderBottomWidth: 1,
                      borderBottomColor: colors.line,
                    },
                  ]}
                >
                  <Link2 size={19} color={colors.muted} />
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Text style={s.text}>{account.serviceName}</Text>
                    <Text style={s.small}>
                      {account.alias ? `${account.alias} · ` : ""}
                      {t(connectionStatusLabel(account.status))}
                    </Text>
                  </View>
                  <ChevronRight size={16} color={colors.muted} />
                </Pressable>
              ))}
            </View>
          )}
          <IntegrationSettings query={query} />
          {nativeConnections(query, (toolkit) => {
            setSelected(toolkit);
            setError("");
            setConfirmDisconnect(undefined);
          })}
          <McpConnections query={query} />
          {configured && !query && (
            <>
              <Button small onPress={() => setUpdateKey((value) => !value)}>
                {t(updateKey ? "Cancel" : "Update catalog key")}
              </Button>
              {updateKey && (
                <ComposioSetup
                  onConnected={() => {
                    setUpdateKey(false);
                    void reload().catch(() => {});
                  }}
                />
              )}
            </>
          )}
        </>
      )}
    </View>
  );
}
