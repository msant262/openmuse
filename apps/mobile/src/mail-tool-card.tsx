import { Mail, Search } from "lucide-react-native";
import { useContext } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { useI18n } from "./i18n";
import { ResultCardFrame } from "./result-card-frame";
import { Button, ErrorNotice, useUI } from "./ui";
import { useWorkspace } from "./workspace";

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  unread: z.boolean(),
  label: z.string(),
  attachments: z.array(z.string()),
});

export function MailToolCard({
  result,
  loading,
  search = false,
}: {
  result: unknown;
  loading: boolean;
  search?: boolean;
}) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const { open } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success) return <ErrorNotice error={error.data.error} />;
  if (loading)
    return (
      <View style={[s.row, { gap: 10, padding: 14 }]}>
        {active ? (
          <ActivityIndicator size="small" color={colors.blueDark} />
        ) : (
          <Mail size={16} color={colors.muted} />
        )}
        <Text style={s.muted}>
          {!active
            ? t("Mail reading paused")
            : search
              ? t("Checking your inbox…")
              : t("Reading the email…")}
        </Text>
      </View>
    );
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ id: z.string() })), truncated: z.boolean() })
      .safeParse(value);
    if (!parsed.success)
      return <ErrorNotice error={t("The mailbox did not return readable results.")} />;
    const count = parsed.data.matches.length;
    return (
      <View style={[s.row, { gap: 9, padding: 12 }]}>
        <Search size={16} color={colors.muted} />
        <Text style={s.muted}>
          {count
            ? parsed.data.truncated
              ? t(count === 1 ? "Found at least {count} email" : "Found at least {count} emails", {
                  count,
                })
              : t(count === 1 ? "Found {count} email" : "Found {count} emails", { count })
            : t("No matching emails")}
        </Text>
      </View>
    );
  }
  const parsed = z
    .object({ messages: z.array(messageSchema), truncated: z.boolean() })
    .safeParse(value);
  if (!parsed.success) return <ErrorNotice error={t("The email could not be displayed.")} />;
  const message = parsed.data.messages.at(-1);
  if (!message) return <Text style={s.muted}>{t("No messages in this thread.")}</Text>;
  return (
    <ResultCardFrame style={{ padding: 18, gap: 14 }}>
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { backgroundColor: colors.subtle }]}>
          <Mail size={20} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>{message.sender}</Text>
          <Text style={s.small}>
            {t("Email")} ·{" "}
            {parsed.data.messages.length === 1
              ? t("1 message")
              : t("{count} messages", { count: parsed.data.messages.length })}
          </Text>
        </View>
      </View>
      <Text numberOfLines={2} style={[s.heading, { fontSize: 18, lineHeight: 24 }]}>
        {message.subject}
      </Text>
      <Text style={s.muted} numberOfLines={3}>
        {message.body}
      </Text>
      {parsed.data.truncated && (
        <Text style={s.small}>{t("Showing an excerpt of this thread.")}</Text>
      )}
      <Button small icon={Mail} onPress={() => open({ type: "mail", mail: message })}>
        {t("Open email")}
      </Button>
    </ResultCardFrame>
  );
}
