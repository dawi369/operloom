import type { ArtifactSummary } from "@operloom/client";
import { useWorkbenchArtifacts } from "@operloom/react";
import { Component, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import {
  artifactMeta,
  artifactRows,
  sanitizeArtifactData,
  withinRendererBound,
} from "../../src/artifacts/artifact-content";
import { resolveNativeArtifactRenderer } from "../../src/artifacts/native-renderers";
import { Card, ErrorNotice, Screen } from "../../src/components/screen";
import { colors } from "../../src/theme";

/** What agents produced, newest first; a pack's native renderer takes over when it ships one, otherwise the generic view. */
export default function ArtifactsScreen() {
  const artifacts = useWorkbenchArtifacts({ limit: 50 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = artifacts.data?.artifacts ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  if (selected) {
    return (
      <Screen
        title={selected.title ?? selected.kind ?? "Artifact"}
        subtitle={artifactMeta(selected)}
      >
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelectedId(null)}
            style={{ alignSelf: "flex-start" }}
          >
            <Text style={{ color: colors.accent, fontWeight: "600" }}>‹ All artifacts</Text>
          </Pressable>
          <ArtifactBody artifact={selected} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      title="Artifacts"
      subtitle={items.length ? `${items.length} produced by your agents` : "Nothing produced yet."}
      refreshing={artifacts.isFetching}
      onRefresh={() => void artifacts.refetch()}
      loading={artifacts.isPending}
    >
      <ErrorNotice message={artifacts.error ? String(artifacts.error) : null} />
      {items.map((item) => (
        <Card key={item.id} onPress={() => setSelectedId(item.id)}>
          <Text style={{ color: colors.ink, fontWeight: "600" }}>
            {item.title ?? item.kind ?? item.id}
          </Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>
            {artifactMeta(item)}
          </Text>
        </Card>
      ))}
    </Screen>
  );
}

const ArtifactBody = ({ artifact }: { artifact: ArtifactSummary }) => {
  const native = resolveNativeArtifactRenderer(artifact.kind);
  const data = sanitizeArtifactData(artifact.data) as Record<string, unknown> | undefined;
  if (native && withinRendererBound(data)) {
    const Renderer = native.Component;
    return (
      <RendererBoundary fallback={<GenericArtifact data={data} uri={artifact.uri} />}>
        <Renderer
          artifact={{
            id: artifact.id,
            kind: artifact.kind ?? "",
            title: artifact.title,
            mimeType: artifact.mimeType,
            data,
          }}
        />
      </RendererBoundary>
    );
  }
  return <GenericArtifact data={data} uri={artifact.uri} />;
};

const GenericArtifact = ({ data, uri }: { data: unknown; uri?: string }) => {
  const rows = artifactRows(data);
  if (!rows.length) {
    return (
      <Text style={{ color: colors.muted }}>
        {uri ? `Stored at ${uri}; open it from the console.` : "This artifact has no inline data."}
      </Text>
    );
  }
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        borderRadius: 14,
        paddingVertical: 6,
      }}
    >
      {rows.map((row, index) => (
        <View
          key={`${row.path}-${index}`}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 6,
            borderTopWidth: index ? 1 : 0,
            borderTopColor: colors.line,
          }}
        >
          <Text style={{ color: colors.muted, fontSize: 12 }}>{row.path || "value"}</Text>
          {row.nested ? (
            row.value ? (
              <Text style={{ color: colors.muted, fontSize: 12 }}>{row.value}</Text>
            ) : null
          ) : (
            <Text style={{ color: colors.ink }} selectable>
              {row.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
};

/** A throwing pack renderer falls back to the generic view, matching the console. */
class RendererBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
