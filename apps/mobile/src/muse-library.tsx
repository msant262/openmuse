import {
  AudioLines,
  Download,
  FileText,
  Globe2,
  Image as ImageIcon,
  LayoutGrid,
  List,
  MoreHorizontal,
  Search,
  Send,
  Shapes,
  Upload,
  Video,
} from "lucide-react-native";
import { useState } from "react";
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { Artifact } from "../../../packages/domain/src";
import { localizedAttachmentLabel } from "./attachment-ui-copy";
import { FileContentPreview } from "./file-content-preview";
import { useI18n } from "./i18n";
import { useThemedStyles } from "./theme";
import type { ThemeColors } from "./theme-palette";
import { Button, Empty, ErrorNotice, IconButton, LinkRow, Sheet, useUI } from "./ui";
import { useWorkspace } from "./workspace";

type Category = "all" | "documents" | "web" | "images" | "videos" | "audio";
const categories = [
  { id: "all", label: "All artifacts", icon: Shapes },
  { id: "documents", label: "Documents", icon: FileText },
  { id: "web", label: "Web artifacts", icon: Globe2 },
  { id: "images", label: "Images", icon: ImageIcon },
  { id: "videos", label: "Videos", icon: Video },
  { id: "audio", label: "Audio", icon: AudioLines },
] as const;

function categoryOf(file: Artifact): Exclude<Category, "all"> {
  if (file.mimeType.startsWith("image/")) return "images";
  if (file.mimeType.startsWith("video/")) return "videos";
  if (file.mimeType.startsWith("audio/")) return "audio";
  if (file.mimeType === "text/html" || /\.html?$/i.test(file.name)) return "web";
  return "documents";
}
function fileAppearance(file: Artifact) {
  const category = categoryOf(file);
  return {
    category,
    Icon: categories.find((item) => item.id === category)?.icon ?? FileText,
    tint:
      category === "images"
        ? "#DCF0E4"
        : category === "videos"
          ? "#EEE4F9"
          : category === "audio"
            ? "#F9E2D5"
            : category === "web"
              ? "#E4E9F8"
              : "#DEEDFC",
    ink:
      category === "images"
        ? "#39835B"
        : category === "videos"
          ? "#946AC2"
          : category === "audio"
            ? "#BD7248"
            : category === "web"
              ? "#647BC0"
              : "#3187D5",
  };
}

export function LibraryFileIcon({ file, size = 44 }: { file: Artifact; size?: number }) {
  const { api } = useWorkspace();
  const { Icon, tint, ink, category } = fileAppearance(file);
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        backgroundColor: tint,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {category === "images" && failedUrl !== file.url ? (
        <Image
          source={{ uri: api.url(file.url) }}
          style={{ width: size, height: size }}
          resizeMode="cover"
          onError={() => setFailedUrl(file.url)}
        />
      ) : (
        <Icon size={size * 0.58} color={ink} strokeWidth={1.6} />
      )}
    </View>
  );
}

function LibraryPreview({ file }: { file: Artifact }) {
  const styles = useThemedStyles(createLibraryStyles);

  const { api } = useWorkspace();
  const { t } = useI18n();
  const { Icon, tint, ink, category } = fileAppearance(file);
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <View style={[styles.preview, { backgroundColor: tint }]}>
      {category === "images" && failedUrl !== file.url ? (
        <Image
          source={{ uri: api.url(file.url) }}
          style={{ width: "100%", height: 182 }}
          resizeMode="cover"
          onError={() => setFailedUrl(file.url)}
        />
      ) : category === "videos" && Platform.OS === "web" && failedUrl !== file.url ? (
        <video
          aria-label={file.name}
          src={`${api.url(file.url)}#t=0.1`}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailedUrl(file.url)}
          style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }}
        />
      ) : category === "web" && Platform.OS === "web" ? (
        <FileContentPreview file={file} url={api.url(file.url)} height={182} passive />
      ) : file.mimeType === "application/pdf" && Platform.OS === "web" ? (
        <iframe
          title={`${t("Document preview")}: ${file.name}`}
          src={`${api.url(file.url)}#page=1&view=FitH&toolbar=0&navpanes=0&scrollbar=0`}
          loading="lazy"
          tabIndex={-1}
          aria-hidden
          style={{ width: "100%", height: "100%", border: 0, pointerEvents: "none" }}
        />
      ) : (
        <View style={{ alignItems: "center", gap: 12, padding: 20 }}>
          <Icon size={48} color={ink} strokeWidth={1.35} />
          <Text numberOfLines={2} style={{ color: ink, fontSize: 12, textAlign: "center" }}>
            {file.name.split(".").at(-1)?.toUpperCase() || t("FILE")}
          </Text>
        </View>
      )}
    </View>
  );
}

export function MuseLibrary({
  files,
  uploading,
  uploadError,
  onUpload,
}: {
  files: Artifact[];
  uploading: boolean;
  uploadError: string;
  onUpload: () => void;
}) {
  const { colors, s } = useUI();
  const styles = useThemedStyles(createLibraryStyles);

  const { api, open } = useWorkspace();
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === "web" && width >= 1024;
  const [category, setCategory] = useState<Category>("all");
  const [group, setGroup] = useState<"artifacts" | "media">("artifacts");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Artifact>();
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const visible = [...files]
    .filter((file) => {
      const kind = categoryOf(file);
      const media = ["images", "videos", "audio"].includes(kind);
      const matchesGroup = desktop ? category !== "all" || !media : (group === "media") === media;
      return (
        matchesGroup &&
        (!desktop || category === "all" || category === kind) &&
        `${file.name} ${file.source} ${file.mimeType}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      );
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const grid = desktop && layout === "grid";
  const availableWidth = width - 68 - 228 - 96;
  const columns = Math.max(2, Math.floor((availableWidth + 20) / 248));
  const cardWidth = Math.floor((availableWidth - (columns - 1) * 20) / columns);
  function show(file: Artifact) {
    setSelected(undefined);
    open({ type: "file", file });
  }
  async function download(file: Artifact) {
    setDownloading(true);
    setError("");
    try {
      const current = await api.request<Artifact>(`/api/files/${file.id}`);
      await Linking.openURL(api.url(current.url));
      setSelected(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  }
  return (
    <View style={[styles.root, !desktop && styles.mobileRoot]}>
      {desktop && (
        <View style={styles.sidebar}>
          <View style={styles.search}>
            <Search size={15} color={colors.muted} />
            <TextInput
              accessibilityLabel={t("Search library")}
              placeholder={t("Search")}
              placeholderTextColor={colors.muted}
              value={query}
              onChangeText={setQuery}
              style={styles.searchInput}
            />
          </View>
          {categories.map((item, index) => (
            <View key={item.id}>
              {(index === 0 || index === 3) && (
                <Text style={styles.categoryHeading}>{t(index === 0 ? "Artifacts" : "Media")}</Text>
              )}
              <Pressable
                accessibilityRole="tab"
                accessibilityLabel={t(item.label)}
                aria-selected={category === item.id}
                onPress={() => {
                  setCategory(item.id);
                  setGroup(index >= 3 ? "media" : "artifacts");
                }}
                style={[styles.category, category === item.id && styles.selectedCategory]}
              >
                <item.icon
                  size={18}
                  color={category === item.id ? colors.text : colors.muted}
                  strokeWidth={1.7}
                />
                <Text
                  style={[styles.categoryLabel, category === item.id && { color: colors.text }]}
                >
                  {t(item.label)}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {desktop ? (
          <View style={styles.toolbar}>
            <Text style={styles.title}>
              {t(categories.find((item) => item.id === category)?.label || "All artifacts")}
            </Text>
            <View style={[s.row, { gap: 8 }]}>
              <IconButton
                icon={grid ? List : LayoutGrid}
                label={t(grid ? "List view" : "Grid view")}
                onPress={() => setLayout(grid ? "list" : "grid")}
              />
              <Button small primary icon={Upload} busy={uploading} onPress={onUpload}>
                {t("Import file")}
              </Button>
            </View>
          </View>
        ) : (
          <View style={styles.mobileToolbar}>
            <View style={styles.segments}>
              {(["artifacts", "media"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="tab"
                  accessibilityLabel={t(item === "artifacts" ? "Artifacts" : "Media")}
                  aria-selected={group === item}
                  onPress={() => {
                    setGroup(item);
                    setCategory("all");
                  }}
                  style={[styles.segment, group === item && styles.selectedSegment]}
                >
                  <Text
                    style={{ fontSize: 15, color: group === item ? colors.text : colors.muted }}
                  >
                    {t(item === "artifacts" ? "Artifacts" : "Media")}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={[s.between, { gap: 10, paddingTop: 10 }]}>
              <View style={[styles.search, { flex: 1, marginBottom: 0 }]}>
                <Search size={14} color={colors.muted} />
                <TextInput
                  accessibilityLabel={t("Search library")}
                  placeholder={t("Search")}
                  placeholderTextColor={colors.muted}
                  value={query}
                  onChangeText={setQuery}
                  style={styles.searchInput}
                />
              </View>
              <IconButton
                icon={Upload}
                label={t("Import file")}
                onPress={() => !uploading && onUpload()}
              />
            </View>
          </View>
        )}
        <ScrollView
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={[styles.content, !desktop && styles.mobileContent]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ErrorNotice error={uploadError} />
          {desktop && visible.length > 0 && <Text style={styles.recent}>{t("Recent")}</Text>}
          <View style={grid ? styles.grid : { gap: 0 }}>
            {visible.map((file) => (
              <View
                key={file.id}
                style={grid ? [styles.card, { width: cardWidth }] : styles.listItem}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${t("Open attachment")}: ${file.name}`}
                  onPress={() => show(file)}
                  style={grid ? { width: "100%" } : [s.row, { flex: 1, minWidth: 0, gap: 12 }]}
                >
                  {grid ? <LibraryPreview file={file} /> : <LibraryFileIcon file={file} />}
                  <View style={grid ? styles.cardInfo : { flex: 1, minWidth: 0, gap: 4 }}>
                    {grid && <LibraryFileIcon file={file} size={29} />}
                    <View style={{ flex: 1, minWidth: 0, gap: 4, paddingRight: grid ? 20 : 0 }}>
                      <Text numberOfLines={1} style={grid ? styles.cardName : styles.fileName}>
                        {file.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.fileMeta}>
                        {localizedAttachmentLabel(file, t)}
                      </Text>
                    </View>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("More options for {name}", { name: file.name })}
                  onPress={() => {
                    setError("");
                    setSelected(file);
                  }}
                  style={grid ? styles.cardMore : styles.rowMore}
                >
                  <MoreHorizontal size={19} color={colors.muted} />
                </Pressable>
              </View>
            ))}
          </View>
          {!visible.length && (
            <View style={{ paddingVertical: desktop ? 100 : 60 }}>
              <Empty
                icon={group === "media" && !desktop ? ImageIcon : Shapes}
                title={t(query ? "No matching files" : "Your library starts here")}
                detail={t(
                  query
                    ? "Try another name or file type."
                    : "Documents, images and things you create will be kept here.",
                )}
              />
              {!query && (
                <Button
                  style={{ alignSelf: "center", marginTop: 18 }}
                  icon={Upload}
                  busy={uploading}
                  onPress={onUpload}
                >
                  {t("Import file")}
                </Button>
              )}
            </View>
          )}
        </ScrollView>
      </View>
      {selected && (
        <Sheet
          title={selected.name}
          subtitle={localizedAttachmentLabel(selected, t)}
          onClose={() => setSelected(undefined)}
        >
          <View style={{ gap: 4 }}>
            <LinkRow icon={FileText} title={t("Open attachment")} onPress={() => show(selected)} />
            {Platform.OS === "web" && (
              <Button icon={Download} busy={downloading} onPress={() => void download(selected)}>
                {t("Open / download")}
              </Button>
            )}
            <LinkRow
              icon={Send}
              title={t("Attach to email")}
              onPress={() => {
                setSelected(undefined);
                open({ type: "email", draft: { attachmentIds: [selected.id] } });
              }}
            />
            <ErrorNotice error={error} />
          </View>
        </Sheet>
      )}
    </View>
  );
}

const createLibraryStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: colors.canvas },
    mobileRoot: { paddingTop: 104 },
    sidebar: {
      width: 228,
      paddingHorizontal: 12,
      paddingTop: 17,
      borderRightWidth: 1,
      borderRightColor: colors.line,
    },
    search: {
      flexDirection: "row",
      alignItems: "center",
      height: 35,
      borderRadius: 22,
      backgroundColor: colors.subtle,
      paddingHorizontal: 12,
      gap: 8,
      marginBottom: 14,
    },
    searchInput: { flex: 1, minWidth: 0, paddingVertical: 6, color: colors.text, fontSize: 13 },
    categoryHeading: {
      color: colors.muted,
      fontSize: 12,
      paddingHorizontal: 12,
      marginTop: 12,
      marginBottom: 7,
    },
    category: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 37,
      gap: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
      marginVertical: 2,
    },
    selectedCategory: { backgroundColor: colors.subtle },
    categoryLabel: { color: colors.muted, fontSize: 13 },
    toolbar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      paddingTop: 42,
      paddingBottom: 23,
      paddingHorizontal: 48,
    },
    title: { color: colors.text, fontSize: 28, fontWeight: "600", letterSpacing: -0.65 },
    mobileToolbar: { paddingHorizontal: 18, paddingBottom: 8 },
    segments: {
      flexDirection: "row",
      padding: 4,
      height: 43,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 25,
      backgroundColor: colors.card,
    },
    segment: { flex: 1, justifyContent: "center", alignItems: "center", borderRadius: 21 },
    selectedSegment: { backgroundColor: colors.subtle },
    content: { paddingHorizontal: 48, paddingBottom: 36 },
    mobileContent: { paddingHorizontal: 18, paddingBottom: 24 },
    recent: { color: colors.text, fontSize: 15, marginBottom: 20 },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 20 },
    card: {
      width: 252,
      borderRadius: 22,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.card,
    },
    preview: {
      width: "100%",
      height: 182,
      overflow: "hidden",
      justifyContent: "center",
      alignItems: "center",
    },
    cardInfo: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 15,
      paddingHorizontal: 13,
      gap: 10,
    },
    cardName: { fontSize: 13, color: colors.text, fontWeight: "500" },
    fileName: { fontSize: 16, color: colors.text, letterSpacing: -0.2 },
    fileMeta: { fontSize: 12, lineHeight: 17, color: colors.muted },
    listItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 72,
      paddingVertical: 12,
    },
    rowMore: { width: 30, height: 40, alignItems: "center", justifyContent: "center" },
    cardMore: {
      position: "absolute",
      bottom: 18,
      right: 5,
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
    },
  });
