import { useActivateThread, useCreateThread, useWorkbenchSession } from "@operloom/react";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useChatThread } from "../../src/chat/use-chat-thread";
import { MessageList } from "../../src/components/message-list";
import { colors } from "../../src/theme";
import { useMobileWorkbench } from "../../src/workbench-provider";

export default function ChatScreen() {
  const session = useWorkbenchSession();
  const workspaceId = session.data?.workspace?.id ?? null;
  const activeThreadId = session.data?.activeThread?.threadId ?? null;
  const threads = session.data?.threads ?? [];
  const createThread = useCreateThread(workspaceId);
  const activateThread = useActivateThread(workspaceId);
  const { realtimeState } = useMobileWorkbench();
  const chat = useChatThread(activeThreadId);
  const [draft, setDraft] = useState("");
  const busy = chat.snapshot.state === "sending" || chat.snapshot.state === "running";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top"]}>
      <View
        style={{
          paddingHorizontal: 16,
          paddingVertical: 10,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Text
          style={{ color: colors.ink, fontSize: 22, fontWeight: "700", flex: 1 }}
          numberOfLines={1}
        >
          {session.data?.activeAgent?.name ?? "Chat"}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{realtimeState}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => createThread.mutate(undefined)}
          style={{
            borderColor: colors.line,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: colors.accent, fontWeight: "600" }}>New</Text>
        </Pressable>
      </View>
      {threads.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        >
          {threads.map((thread) => (
            <Pressable
              key={thread.threadId}
              onPress={() => activateThread.mutate(thread.threadId)}
              style={{
                borderRadius: 999,
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: thread.isActive ? colors.accent : colors.surface,
                borderColor: colors.line,
                borderWidth: 1,
              }}
            >
              <Text
                style={{ color: thread.isActive ? "white" : colors.ink, fontSize: 13 }}
                numberOfLines={1}
              >
                {thread.title || "Untitled"}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <MessageList
          messages={chat.messages}
          footer={
            chat.snapshot.error
              ? chat.snapshot.error.message
              : busy
                ? "Working…"
                : activeThreadId
                  ? undefined
                  : "Start a thread to chat with this agent."
          }
        />
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: colors.line,
          }}
        >
          <TextInput
            value={draft}
            onChangeText={setDraft}
            accessibilityLabel="Message"
            placeholder="Message"
            editable={Boolean(activeThreadId) && !busy}
            multiline
            style={{
              flex: 1,
              backgroundColor: colors.surface,
              borderColor: colors.line,
              borderWidth: 1,
              borderRadius: 12,
              padding: 10,
              color: colors.ink,
              maxHeight: 120,
            }}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!activeThreadId || busy || !draft.trim()}
            onPress={() => {
              const text = draft;
              setDraft("");
              void chat.send(text).catch(() => setDraft(text));
            }}
            style={{
              backgroundColor: colors.accent,
              borderRadius: 12,
              paddingHorizontal: 16,
              justifyContent: "center",
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ color: "white", fontWeight: "600" }}>{busy ? "…" : "Send"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
