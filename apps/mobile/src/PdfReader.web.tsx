import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react-native";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useI18n } from "./i18n";
import { PDF_READER_ASSET_ROOT } from "./pdf-reader-assets";
import { loadPdfRuntime, type PdfRuntime } from "./pdf-reader-runtime.web";
import { Button, ErrorNotice, useUI } from "./ui";

interface PdfReaderProps {
  url: string;
  token: string;
  pageCount: number;
  height?: number;
}
const textStyles = `
.okami-pdf-text {position:absolute;inset:0;overflow:clip;line-height:1;letter-spacing:normal;word-spacing:normal;text-align:initial;transform-origin:0 0;-webkit-text-size-adjust:none;text-size-adjust:none;--min-font-size:1;--min-font-size-inv:calc(1 / var(--min-font-size));--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));}
.okami-pdf-text :is(span,br) {color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;-webkit-user-select:text;user-select:text;}
.okami-pdf-text > :not(.markedContent),.okami-pdf-text .markedContent span:not(.markedContent) {--font-height:0;--scale-x:1;--rotate:0deg;font-size:calc(var(--text-scale-factor) * var(--font-height));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));}
.okami-pdf-text .markedContent {display:contents;}
.okami-pdf-text ::selection {background:rgba(80,130,255,.3);}
.okami-pdf-links {position:absolute;inset:0;pointer-events:none;}
.okami-pdf-links a {position:absolute;pointer-events:auto;}
.okami-pdf-links a:hover,.okami-pdf-links a:focus-visible {background:rgba(80,130,255,.16);outline:2px solid #5683d7;}
`;

export default function PdfReader({ url, token, pageCount, height = 570 }: PdfReaderProps) {
  const { colors, s } = useUI();

  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pages, setPages] = useState(pageCount);
  const [loadedDocument, setLoadedDocument] = useState<{
    pdf: PDFDocumentProxy;
    url: string;
    token: string;
    retry: number;
  } | null>(null);
  const [runtime, setRuntime] = useState<PdfRuntime | null>(null);
  const [status, setStatus] = useState<"loading" | "rendering" | "ready" | "error">("loading");
  const [retry, setRetry] = useState(0);
  const document =
    loadedDocument?.url === url && loadedDocument.token === token && loadedDocument.retry === retry
      ? loadedDocument.pdf
      : null;
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState<{
    document: PDFDocumentProxy;
    page: number;
    zoom: number | null;
    width: number;
  } | null>(null);
  const ready =
    status === "ready" &&
    rendered?.document === document &&
    rendered.page === page &&
    rendered.zoom === zoom &&
    rendered.width === width;
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const linksRef = useRef<HTMLDivElement>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(1, element.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    let loading: PDFDocumentLoadingTask | undefined;
    setLoadedDocument(null);
    setRendered(null);
    if (canvasRef.current) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
    textRef.current?.replaceChildren();
    linksRef.current?.replaceChildren();
    setPage(1);
    setPages(pageCount);
    setStatus("loading");
    void loadPdfRuntime()
      .then(async (api) => {
        if (!current) return;
        api.GlobalWorkerOptions.workerSrc = `${PDF_READER_ASSET_ROOT}worker.mjs`;
        loading = api.getDocument({
          url,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
          cMapUrl: `${PDF_READER_ASSET_ROOT}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDF_READER_ASSET_ROOT}standard_fonts/`,
          wasmUrl: `${PDF_READER_ASSET_ROOT}wasm/`,
        });
        const pdf = await loading.promise;
        if (!current) return;
        setRuntime(api);
        setPages(pdf.numPages);
        setLoadedDocument({ pdf, url, token, retry });
      })
      .catch(() => {
        if (current) setStatus("error");
      });
    return () => {
      current = false;
      void loading?.destroy().catch(() => {});
    };
  }, [url, token, retry, pageCount]);

  useEffect(() => {
    const canvas = canvasRef.current,
      text = textRef.current,
      links = linksRef.current;
    if (!document || !runtime || !width || !canvas || !text || !links) return;
    let current = true;
    let render: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setStatus("rendering");
    text.replaceChildren();
    links.replaceChildren();
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (!current) return;
      try {
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = (width / base.width) * ((zoom ?? 100) / 100);
        const viewport = pdfPage.getViewport({ scale });
        // One visible bitmap. Bound its physical memory on high-DPI/zoomed mobile screens.
        const density = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(8_388_608 / (viewport.width * viewport.height)),
        );
        canvas.width = Math.max(1, Math.floor(viewport.width * density));
        canvas.height = Math.max(1, Math.floor(viewport.height * density));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        render = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [density, 0, 0, density, 0, 0],
        });
        await render.promise;
        if (!current) return;
        const textContent = await pdfPage.getTextContent();
        if (!current) return;
        text.style.setProperty("--total-scale-factor", String(scale));
        textLayer = new runtime.TextLayer({
          container: text,
          viewport,
          textContentSource: textContent,
        });
        await textLayer.render();
        if (!current) return;
        for (const annotation of await pdfPage.getAnnotations()) {
          if (!current) return;
          if (
            annotation.subtype !== "Link" ||
            !annotation.url ||
            !/^(https?:|mailto:)/i.test(annotation.url)
          )
            continue;
          const [x1, y1] = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
          const [x2, y2] = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
          const anchor = window.document.createElement("a");
          anchor.href = annotation.url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.setAttribute(
            "aria-label",
            tRef.current("Open source: {url}", { url: annotation.url }),
          );
          Object.assign(anchor.style, {
            left: `${Math.min(x1, x2)}px`,
            top: `${Math.min(y1, y2)}px`,
            width: `${Math.abs(x2 - x1)}px`,
            height: `${Math.abs(y2 - y1)}px`,
          });
          links.appendChild(anchor);
        }
        if (current) {
          setRendered({ document, page, zoom, width });
          setStatus("ready");
        }
      } finally {
        pdfPage.cleanup();
      }
    })().catch(() => {
      if (current) setStatus("error");
    });
    return () => {
      current = false;
      render?.cancel();
      textLayer?.cancel();
    };
  }, [document, runtime, page, zoom, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.between, { gap: 8, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            icon={ChevronLeft}
            disabled={!document || page <= 1}
            onPress={() => setPage(page - 1)}
          >
            {t("Previous")}
          </Button>
          <Text style={s.small}>
            {page} / {pages}
          </Text>
          <Button
            small
            icon={ChevronRight}
            disabled={!document || page >= pages}
            onPress={() => setPage(page + 1)}
          >
            {t("Next")}
          </Button>
        </View>
        <View style={[s.row, { gap: 8 }]}>
          <Button
            small
            icon={Minus}
            disabled={!document || (zoom !== null && zoom <= 50)}
            onPress={() => setZoom((zoom ?? 100) - 25)}
          >
            {t("Zoom out")}
          </Button>
          <Text style={s.small}>{zoom === null ? t("Fit width") : `${zoom}%`}</Text>
          <Button
            small
            icon={Plus}
            disabled={!document || (zoom !== null && zoom >= 200)}
            onPress={() => setZoom((zoom ?? 100) + 25)}
          >
            {t("Zoom in")}
          </Button>
        </View>
      </View>
      <style>{textStyles}</style>
      <ErrorNotice
        error={
          status === "error"
            ? t("Could not display this PDF. Try again or use Open / download.")
            : ""
        }
      />
      {status === "error" && (
        <Button small onPress={() => setRetry(retry + 1)}>
          {t("Try again")}
        </Button>
      )}
      <div
        ref={viewportRef}
        style={{
          height,
          width: "100%",
          overflow: "auto",
          borderRadius: 12,
          background: "#e7e9e3",
          position: "relative",
          padding: 12,
          boxSizing: "border-box",
        }}
      >
        {(status === "loading" || status === "rendering") && (
          <View
            style={{
              position: "absolute",
              inset: 0,
              justifyContent: "center",
              alignItems: "center",
              gap: 12,
            }}
          >
            <ActivityIndicator color={colors.blueDark} />
            <Text style={s.muted}>{t("Loading PDF…")}</Text>
          </View>
        )}
        <div
          style={{
            position: "relative",
            width: "max-content",
            margin: "0 auto",
            visibility: ready ? "visible" : "hidden",
          }}
        >
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={t("PDF page {page} of {pages}", { page, pages })}
            style={{ display: "block" }}
          />
          <div ref={textRef} className="okami-pdf-text" />
          <div ref={linksRef} className="okami-pdf-links" />
        </div>
      </div>
    </View>
  );
}
