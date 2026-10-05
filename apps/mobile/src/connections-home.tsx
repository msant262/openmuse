import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { ConnectionsCatalog } from "./connections-catalog";
import { useI18n } from "./i18n";
import { IntegrationSettings } from "./integration-settings";
import { McpConnections } from "./mcp-connections";
import { NativeConnections } from "./native-connections";
import { Button, Field, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export function ConnectionsHome({ query: externalQuery }: { query?: string }) {
  const { api } = useWorkspace();
  const { t } = useI18n();
  const { s } = useUI();
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [legacy, setLegacy] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .request<{ configured: boolean }>("/api/composio/status")
      .then((value) => {
        if (active) setLegacy(value.configured);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);
  const search = externalQuery ?? query;
  return (
    <View style={{ gap: 22 }}>
      <Text style={s.muted}>
        {t("Choose an app and sign in with your account. You can disconnect it whenever you want.")}
      </Text>
      {externalQuery === undefined && (
        <Field
          label={t("Search connections")}
          value={query}
          onChangeText={setQuery}
          placeholder={t("Google, Gmail, calendar…")}
        />
      )}
      <NativeConnections query={search} />
      <IntegrationSettings query={search} />
      <Button small onPress={() => setAdvanced(!advanced)}>
        {t(advanced ? "Hide advanced connections" : "Advanced connections")}
      </Button>
      {advanced && (
        <>
          <McpConnections query={search} />
          {legacy && <ConnectionsCatalog query={search} nativeConnections={() => null} />}
        </>
      )}
    </View>
  );
}
