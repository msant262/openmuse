import { useEffect, useState } from "react";
import { Image, Text, TextInput, View } from "react-native";
import type { AcceptedMessageInput } from "../../../packages/domain/src/runtime";
import {
  mapPreviewPointToImage,
  type NormalizedRegion,
  normalizedRegion,
} from "./annotation-geometry";
import type { ConversationFileResource, ConversationFrame } from "./conversation-resources";
import { Button, Card, useUI } from "./ui";
import { useWorkspace } from "./workspace";

export type AnnotationSource =
  | { kind: "message"; messageId: string; quote: string }
  | { kind: "attachment"; resource: ConversationFileResource }
  | { kind: "frame"; frame: ConversationFrame };
type Annotation = AcceptedMessageInput["annotations"][number];

export function ConversationAnnotationComposer({
  source,
  onAdd,
  onCancel,
}: {
  source: AnnotationSource;
  onAdd: (annotation: Annotation) => void;
  onCancel: () => void;
}) {
  const { colors, s } = useUI();
  const inputStyle = {
    minHeight: 46,
    maxHeight: 110,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    padding: 10,
    color: colors.text,
    backgroundColor: colors.card,
  } as const;

  const { api } = useWorkspace();
  const [quote, setQuote] = useState(source.kind === "message" ? source.quote.slice(0, 8000) : "");
  const [comment, setComment] = useState("");
  const [region, setRegion] = useState<NormalizedRegion>();
  const [error, setError] = useState("");
  const image =
    source.kind === "frame"
      ? {
          uri: `data:${source.frame.mimeType};base64,${source.frame.image}`,
          name: "Tela atual",
        }
      : source.kind === "attachment" && source.resource.file.mimeType.startsWith("image/")
        ? { uri: api.url(source.resource.file.url), name: source.resource.file.name }
        : undefined;
  useEffect(() => {
    setQuote(source.kind === "message" ? source.quote.slice(0, 8000) : "");
    setComment("");
    setRegion(undefined);
    setError("");
  }, [source]);
  function add() {
    if (!comment.trim()) {
      setError("Escreva um comentário antes de adicionar a marcação.");
      return;
    }
    if (source.kind === "message") {
      onAdd({
        reference: {
          kind: "message",
          messageId: source.messageId,
          ...(quote.trim() ? { quote: quote.trim() } : {}),
        },
        comment: comment.trim(),
      });
      return;
    }
    if (!region && (source.kind === "frame" || image)) {
      setError("Marque uma região da imagem antes de adicionar.");
      return;
    }
    if (source.kind === "frame") {
      if (!region) return;
      onAdd({
        reference: {
          kind: "frame",
          frameId: source.frame.frameId,
          sessionGeneration: source.frame.sessionGeneration,
          region,
        },
        comment: comment.trim(),
      });
      return;
    }
    onAdd({
      reference: {
        kind: "attachment",
        attachmentId: source.resource.file.id,
        version: source.resource.version,
        ...(image && region ? { region } : {}),
        ...(!image && quote.trim() ? { quote: quote.trim() } : {}),
      },
      comment: comment.trim(),
    });
  }
  return (
    <Card style={{ gap: 10, padding: 14 }}>
      <Text style={s.heading}>
        {source.kind === "message"
          ? "Citar texto da conversa"
          : source.kind === "frame"
            ? "Marcar região da tela"
            : image
              ? "Marcar região da imagem"
              : "Citar trecho do arquivo"}
      </Text>
      {source.kind === "message" && (
        <TextInput
          accessibilityLabel="Quoted text"
          value={quote}
          onChangeText={setQuote}
          placeholder="Trecho citado (opcional)"
          multiline
          style={inputStyle}
        />
      )}
      {source.kind === "attachment" && !image && (
        <TextInput
          accessibilityLabel="File quote"
          value={quote}
          onChangeText={setQuote}
          placeholder="Trecho do arquivo (opcional)"
          multiline
          style={inputStyle}
        />
      )}
      {image && <RegionSelector uri={image.uri} onRegion={setRegion} />}
      {region && (
        <Text style={s.small}>
          Região normalizada: {region.x.toFixed(3)}, {region.y.toFixed(3)} ·{" "}
          {region.width.toFixed(3)} × {region.height.toFixed(3)}
        </Text>
      )}
      <TextInput
        accessibilityLabel="Annotation comment"
        value={comment}
        onChangeText={(value) => {
          setComment(value);
          setError("");
        }}
        placeholder="Seu comentário (obrigatório)"
        multiline
        style={inputStyle}
      />
      {!!error && <Text style={{ color: colors.danger }}>{error}</Text>}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button small onPress={onCancel}>
          Cancelar
        </Button>
        <Button small primary onPress={add}>
          Adicionar ao rascunho
        </Button>
      </View>
    </Card>
  );
}

function RegionSelector({
  uri,
  onRegion,
}: {
  uri: string;
  onRegion: (value: NormalizedRegion | undefined) => void;
}) {
  const { colors, s } = useUI();

  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [start, setStart] = useState<{ x: number; y: number }>();
  const [end, setEnd] = useState<{ x: number; y: number }>();
  const fitScale = Math.min(viewport.width / dimensions.width, viewport.height / dimensions.height);
  const fitWidth = dimensions.width * fitScale;
  const fitHeight = dimensions.height * fitScale;
  const region = start && end ? normalizedRegion(start, end) : undefined;
  const ready = viewport.width > 0 && viewport.height > 0 && dimensions.width > 0;
  function point(x: number, y: number) {
    return mapPreviewPointToImage({ x, y }, viewport, dimensions, { zoom, rotation });
  }
  return (
    <View style={{ gap: 8 }}>
      <View
        onLayout={(event) =>
          setViewport({
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height,
          })
        }
        onStartShouldSetResponder={() => ready}
        onMoveShouldSetResponder={() => ready}
        onResponderGrant={(event) => {
          const next = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
          setStart(next);
          setEnd(undefined);
          onRegion(undefined);
        }}
        onResponderMove={(event) => {
          const next = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
          if (next) setEnd(next);
        }}
        onResponderRelease={(event) => {
          const next = point(event.nativeEvent.locationX, event.nativeEvent.locationY);
          if (next) {
            setEnd(next);
            const value = start ? normalizedRegion(start, next) : undefined;
            onRegion(value);
          } else onRegion(undefined);
        }}
        style={{
          width: "100%",
          maxWidth: 340,
          height: 250,
          backgroundColor: colors.code,
          overflow: "hidden",
          alignSelf: "center",
        }}
      >
        <View
          style={{
            position: "absolute",
            width: "100%",
            height: "100%",
            transform: [{ rotate: `${rotation}deg` }, { scale: zoom }],
          }}
          pointerEvents="none"
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            onLoad={(event) => {
              const source = event.nativeEvent.source;
              if (source.width > 0 && source.height > 0)
                setDimensions({ width: source.width, height: source.height });
            }}
            style={{ width: "100%", height: "100%" }}
          />
          {region && (
            <View
              style={{
                position: "absolute",
                left: (viewport.width - fitWidth) / 2 + region.x * fitWidth,
                top: (viewport.height - fitHeight) / 2 + region.y * fitHeight,
                width: region.width * fitWidth,
                height: region.height * fitHeight,
                borderColor: colors.selectedBorder,
                borderWidth: 2,
                backgroundColor: "#FF2F6630",
              }}
            />
          )}
        </View>
      </View>
      {!ready && <Text style={s.muted}>Carregando prévia…</Text>}
      <View style={{ flexDirection: "row", gap: 7, justifyContent: "center" }}>
        <Button
          small
          onPress={() => setZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))))}
        >
          −
        </Button>
        <Text style={[s.small, { alignSelf: "center" }]}>{Math.round(zoom * 100)}%</Text>
        <Button
          small
          onPress={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))}
        >
          +
        </Button>
        <Button
          small
          onPress={() => setRotation((value) => ((value + 90) % 360) as 0 | 90 | 180 | 270)}
        >
          Rotacionar
        </Button>
        <Button
          small
          onPress={() => {
            setStart(undefined);
            setEnd(undefined);
            onRegion(undefined);
          }}
        >
          Limpar região
        </Button>
      </View>
    </View>
  );
}
