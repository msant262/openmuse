import { useI18n } from "./i18n";
export default function BrowserConsole({ url }: { url: string }) {
  const { t } = useI18n();
  return (
    <iframe
      title={t("Remote browser session console")}
      src={url}
      style={{ height: 540, width: "100%", border: 0, borderRadius: 12, background: "#FFF" }}
    />
  );
}
