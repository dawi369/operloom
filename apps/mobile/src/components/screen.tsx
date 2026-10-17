import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors } from "../theme";

export const Screen = ({
  children,
  title,
  subtitle,
  refreshing,
  onRefresh,
  scroll = true,
}: PropsWithChildren<{
  title?: string;
  subtitle?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  scroll?: boolean;
}>) => {
  const content = (
    <>
      {title ? (
        <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: 14 }}>
          <Text
            accessibilityRole="header"
            style={{ color: colors.ink, fontSize: 30, fontWeight: "700" }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21, marginTop: 4 }}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </>
  );
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.canvas }}
      edges={["top", "left", "right"]}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} />
            ) : undefined
          }
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
};

export const Card = ({ children, onPress }: PropsWithChildren<{ onPress?: () => void }>) => {
  const body = (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.line,
        borderRadius: 18,
        padding: 15,
        backgroundColor: colors.surface,
      }}
    >
      {children}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginBottom: 10,
        opacity: pressed ? 0.72 : 1,
      })}
    >
      {body}
    </Pressable>
  ) : (
    <View style={{ marginHorizontal: 16, marginBottom: 10 }}>{body}</View>
  );
};

export const ErrorNotice = ({ message }: { message?: string | null }) =>
  message ? (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 12,
        borderRadius: 14,
        backgroundColor: "#fee4e2",
        padding: 12,
      }}
    >
      <Text style={{ color: colors.danger }}>{message}</Text>
    </View>
  ) : null;

export const ActionButton = ({
  label,
  onPress,
  disabled,
  destructive,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => ({
      alignSelf: "flex-start",
      borderRadius: 16,
      backgroundColor: destructive ? colors.danger : colors.accent,
      paddingHorizontal: 14,
      paddingVertical: 10,
      opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
    })}
  >
    <Text style={{ color: "white", fontWeight: "700" }}>{label}</Text>
  </Pressable>
);

export const Meta = ({ children }: { children: ReactNode }) => (
  <Text style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>{children}</Text>
);
