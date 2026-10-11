import type { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist";
import { PDF_READER_ASSET_ROOT } from "./pdf-reader-assets";

export type PdfRuntime = {
  getDocument: typeof getDocument;
  GlobalWorkerOptions: typeof GlobalWorkerOptions;
  TextLayer: typeof TextLayer;
};
declare global {
  var __okamiPdfRuntime: PdfRuntime | undefined;
}
let loading: Promise<PdfRuntime> | undefined;

/** Keep the PDF library out of chat startup; load the local, versioned bundle on demand. */
export function loadPdfRuntime(): Promise<PdfRuntime> {
  if (globalThis.__okamiPdfRuntime) return Promise.resolve(globalThis.__okamiPdfRuntime);
  if (loading) return loading;
  loading = new Promise<PdfRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${PDF_READER_ASSET_ROOT}runtime.js`;
    script.async = true;
    script.onload = () => {
      if (globalThis.__okamiPdfRuntime) resolve(globalThis.__okamiPdfRuntime);
      else {
        script.remove();
        reject(new Error("PDF runtime did not initialize"));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("PDF runtime could not be loaded"));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
