import {
  useConfirmMemory,
  useForgetMemory,
  useRememberMemory,
  useWorkbenchMemory,
} from "@operloom/react";
import type { MemoryKind, MemoryRecord } from "@operloom/client";
import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { ErrorNotice, Screen } from "../../src/components/screen";
import { colors } from "../../src/theme";

const kinds: MemoryKind[] = ["goal", "preference", "watchlist", "conclusion", "note"];

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "note";

/** What the agent carries across threads; proposals wait for a tap, anything can be forgotten. */
export default function MemoryScreen() {
  const memory = useWorkbenchMemory({ status: "all" });
  const confirm = useConfirmMemory();
  const forget = useForgetMemory();
  const remember = useRememberMemory();
  const [kind, setKind] = useState<MemoryKind>("watchlist");
  const [title, setTitle] = useState("");
  const records = (memory.data?.records ?? []).filter((record) => record.status !== "archived");
  const proposed = records.filter((record) => record.status === "proposed");
  const active = records.filter((record) => record.status === "active");
  const busy = confirm.isPending || forget.isPending;
  const error = memory.error ?? confirm.error ?? forget.error ?? remember.error;

  return (
    <Screen
      title="Memory"
      subtitle={
        proposed.length
          ? `${proposed.length} suggestion${proposed.length === 1 ? "" : "s"} waiting for you`
          : `${active.length} remembered`
      }
      refreshing={memory.isFetching}
      onRefresh={() => void memory.refetch()}
      loading={memory.isPending}
    >
      <ErrorNotice message={error ? String(error) : null} />
      <View style={{ paddingHorizontal: 16, gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {kinds.map((candidate) => (
            <Pressable
              key={candidate}
              accessibilityRole="button"
              onPress={() => setKind(candidate)}
              style={{
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 5,
                backgroundColor: kind === candidate ? colors.accent : colors.accentSoft,
              }}
            >
              <Text style={{ color: kind === candidate ? "white" : colors.accent, fontSize: 12 }}>
                {candidate}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            accessibilityLabel="Something to remember"
            placeholder={
              kind === "watchlist" ? "Market or topic to watch" : "Something to remember"
            }
            placeholderTextColor={colors.muted}
            value={title}
            onChangeText={setTitle}
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 10,
              padding: 10,
              color: colors.ink,
              backgroundColor: colors.surface,
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!title.trim() || remember.isPending}
            onPress={() =>
              remember.mutate(
                {
                  kind,
                  key: slug(title),
                  title: title.trim(),
                  content: kind === "watchlist" ? { query: title.trim() } : { text: title.trim() },
                },
                { onSuccess: () => setTitle("") },
              )
            }
            style={{
              backgroundColor: title.trim() ? colors.accent : colors.line,
              borderRadius: 10,
              paddingHorizontal: 14,
              justifyContent: "center",
            }}
          >
            <Text style={{ color: "white", fontWeight: "600" }}>Remember</Text>
          </Pressable>
        </View>
        {proposed.length ? (
          <Section title="Suggested by the agent">
            {proposed.map((record) => (
              <MemoryCard
                key={record.id}
                record={record}
                busy={busy}
                onConfirm={() => confirm.mutate(record.id)}
                onForget={() => forget.mutate(record.id)}
              />
            ))}
          </Section>
        ) : null}
        {kinds
          .map((candidate) => ({
            kind: candidate,
            items: active.filter((record) => record.kind === candidate),
          }))
          .filter((group) => group.items.length)
          .map((group) => (
            <Section key={group.kind} title={group.kind}>
              {group.items.map((record) => (
                <MemoryCard
                  key={record.id}
                  record={record}
                  busy={busy}
                  onForget={() => forget.mutate(record.id)}
                />
              ))}
            </Section>
          ))}
        {memory.data && records.length === 0 ? (
          <Text style={{ color: colors.muted }}>Nothing remembered yet.</Text>
        ) : null}
      </View>
    </Screen>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <View style={{ gap: 8 }}>
    <Text
      style={{
        color: colors.muted,
        fontSize: 12,
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: 0.6,
      }}
    >
      {title}
    </Text>
    {children}
  </View>
);

const MemoryCard = ({
  record,
  busy,
  onConfirm,
  onForget,
}: {
  record: MemoryRecord;
  busy: boolean;
  onConfirm?: () => void;
  onForget: () => void;
}) => {
  const detail =
    typeof record.content.text === "string"
      ? record.content.text
      : typeof record.content.summary === "string"
        ? record.content.summary
        : typeof record.content.query === "string"
          ? record.content.query
          : "";
  const meta = [
    record.source !== "user" ? `by ${record.source} · ${record.updatedAt.slice(0, 10)}` : null,
    record.scope === "workspace" ? "shared" : record.scope === "agent" ? "this agent" : null,
    record.target ? `${record.target.type}: ${record.target.id}` : null,
    record.expiresAt ? `expires ${record.expiresAt.slice(0, 10)}` : null,
  ].filter(Boolean);
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 6,
      }}
    >
      <Text style={{ color: colors.ink, fontWeight: "600" }}>{record.title}</Text>
      {detail && detail !== record.title ? (
        <Text style={{ color: colors.muted }} numberOfLines={3}>
          {detail}
        </Text>
      ) : null}
      {meta.length ? (
        <Text style={{ color: colors.muted, fontSize: 12 }}>{meta.join(" · ")}</Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {onConfirm ? (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={onConfirm}
            style={{ flex: 1, backgroundColor: colors.accent, borderRadius: 10, padding: 10 }}
          >
            <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>Keep</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onForget}
          style={{
            flex: 1,
            borderColor: colors.danger,
            borderWidth: 1,
            borderRadius: 10,
            padding: 10,
          }}
        >
          <Text style={{ color: colors.danger, textAlign: "center", fontWeight: "600" }}>
            Forget
          </Text>
        </Pressable>
      </View>
    </View>
  );
};
