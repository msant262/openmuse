import { useI18n } from "./i18n";
export default function BrowserConsole({ url, height = 540 }: { url: string; height?: number }) {
  const { t } = useI18n();
  return (
    <iframe
      title={t("Remote browser session console")}
      src={url}
      style={{ height, width: "100%", border: 0, borderRadius: 12, background: "#FFF" }}
    />
  );
}
