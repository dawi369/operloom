import {
  useWorkbenchApprovals,
  useWorkbenchClient,
  useWorkbenchQueryClient,
  workbenchQueryKeys,
} from "@operloom/react";
import { useMutation } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";

import { Screen } from "../../src/components/screen";
import { colors } from "../../src/theme";

export default function ApprovalsScreen() {
  const approvals = useWorkbenchApprovals();
  const client = useWorkbenchClient();
  const queryClient = useWorkbenchQueryClient();
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "deny" }) =>
      input.decision === "approve"
        ? client.approvals.approve(input.id)
        : client.approvals.deny(input.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.approvals() }),
  });
  const pending = (approvals.data?.approvals ?? []).filter(
    (item) => item.status === "requested" && item.id,
  );

  return (
    <Screen
      title="Approvals"
      subtitle={pending.length ? `${pending.length} waiting on you` : "Nothing is waiting on you."}
      refreshing={approvals.isFetching}
      onRefresh={() => void approvals.refetch()}
      loading={approvals.isPending}
    >
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        {pending.map((item) => (
          <View
            key={item.id}
            style={{
              backgroundColor: colors.surface,
              borderColor: colors.line,
              borderWidth: 1,
              borderRadius: 14,
              padding: 14,
              gap: 8,
            }}
          >
            <Text style={{ color: colors.ink, fontWeight: "600" }}>
              {item.toolId ?? "Tool call"}
            </Text>
            {item.reason ? <Text style={{ color: colors.muted }}>{item.reason}</Text> : null}
            {item.input?.url ? (
              <Text style={{ color: colors.muted, fontSize: 12 }}>{item.input.url}</Text>
            ) : null}
            {item.memoryUsed?.length ? (
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                Based on: {item.memoryUsed.map((record) => record.title).join(" · ")}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                disabled={decide.isPending}
                onPress={() => decide.mutate({ id: item.id!, decision: "approve" })}
                style={{ flex: 1, backgroundColor: colors.accent, borderRadius: 10, padding: 10 }}
              >
                <Text style={{ color: "white", textAlign: "center", fontWeight: "600" }}>
                  Approve
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={decide.isPending}
                onPress={() => decide.mutate({ id: item.id!, decision: "deny" })}
                style={{
                  flex: 1,
                  borderColor: colors.danger,
                  borderWidth: 1,
                  borderRadius: 10,
                  padding: 10,
                }}
              >
                <Text style={{ color: colors.danger, textAlign: "center", fontWeight: "600" }}>
                  Deny
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
        {decide.error ? <Text style={{ color: colors.danger }}>{String(decide.error)}</Text> : null}
      </View>
    </Screen>
  );
}
