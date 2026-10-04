import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { useI18n } from "./i18n";
import { Button, useUI } from "./ui";

interface PdfReaderProps {
  url: string;
  token: string;
  pageCount: number;
  height?: number;
}
export default function PdfReader({ url, pageCount, height = 570 }: PdfReaderProps) {
  const { s } = useUI();

  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Button small icon={ChevronLeft} disabled={page <= 1} onPress={() => setPage(page - 1)}>
            {t("Previous")}
          </Button>
          <Text style={s.small}>
            {page} / {pageCount}
          </Text>
          <Button
            small
            icon={ChevronRight}
            disabled={page >= pageCount}
            onPress={() => setPage(page + 1)}
          >
            {t("Next")}
          </Button>
        </View>
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            icon={Minus}
            disabled={zoom !== null && zoom <= 50}
            onPress={() => setZoom((zoom ?? 100) - 25)}
          >
            {t("Zoom out")}
          </Button>
          <Text style={s.small}>{zoom === null ? t("Fit width") : `${zoom}%`}</Text>
          <Button
            small
            icon={Plus}
            disabled={zoom !== null && zoom >= 200}
            onPress={() => setZoom((zoom ?? 100) + 25)}
          >
            {t("Zoom in")}
          </Button>
        </View>
      </View>
      <iframe
        key={`${page}:${zoom}`}
        title={t("PDF document reader")}
        src={`${url}#page=${page}&navpanes=0&toolbar=0&${zoom === null ? "view=FitH" : `zoom=${zoom}`}`}
        style={{ height, width: "100%", border: 0, borderRadius: 12, background: "#e7e9e3" }}
      />
    </View>
  );
}
