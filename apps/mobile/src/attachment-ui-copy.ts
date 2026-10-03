import type { Artifact } from "../../../packages/domain/src";

type Translator = (key: string, values?: Record<string, string | number>) => string;

export function localizedAttachmentLabel(file: Artifact, t: Translator) {
  if (file.mimeType === "application/pdf") {
    return file.pageCount === 1
      ? t("1 page · PDF")
      : t("{count} pages · PDF", { count: file.pageCount });
  }
  const type = file.name.split(".").at(-1)?.toUpperCase() || t("FILE");
  return t("{type} · {size} KB", { type, size: Math.max(1, Math.ceil(file.size / 1024)) });
}
