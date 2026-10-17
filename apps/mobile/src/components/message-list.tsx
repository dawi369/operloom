import { FlatList, Text, View } from "react-native";

import type { ThreadMessage, ThreadMessagePart } from "../chat/chat-messages";
import { colors } from "../theme";

const Part = ({ part }: { part: ThreadMessagePart }) => {
  if (part.type === "text")
    return <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 22 }}>{part.text}</Text>;
  if (part.type === "reasoning")
    return (
      <Text style={{ color: colors.muted, fontSize: 14, fontStyle: "italic" }}>{part.text}</Text>
    );
  // Generic fallback: a pack renderer registered for this tool would replace this block.
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: part.isError ? colors.danger : colors.line,
        paddingLeft: 8,
      }}
    >
      <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "600" }}>{part.toolName}</Text>
      {part.result !== undefined ? (
        <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={6}>
          {typeof part.result === "string" ? part.result : JSON.stringify(part.result, null, 1)}
        </Text>
      ) : null}
    </View>
  );
};

export const MessageList = ({
  messages,
  footer,
}: {
  messages: ThreadMessage[];
  footer?: string;
}) => (
  <FlatList
    data={messages}
    keyExtractor={(message, index) => message.id ?? `m-${index}`}
    contentContainerStyle={{ padding: 16, gap: 12 }}
    renderItem={({ item }) => (
      <View
        style={{
          alignSelf: item.role === "user" ? "flex-end" : "flex-start",
          maxWidth: "88%",
          backgroundColor: item.role === "user" ? colors.accentSoft : colors.surface,
          borderColor: colors.line,
          borderWidth: 1,
          borderRadius: 14,
          padding: 12,
          gap: 6,
        }}
      >
        {item.content.map((part, index) => (
          <Part key={index} part={part} />
        ))}
      </View>
    )}
    ListFooterComponent={
      footer ? <Text style={{ color: colors.muted, padding: 16 }}>{footer}</Text> : null
    }
  />
);
