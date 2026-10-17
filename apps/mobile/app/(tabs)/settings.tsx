import {
  useActivateAgent,
  useActivateWorkspace,
  useWorkbenchAgents,
  useWorkbenchClient,
  useWorkbenchSession,
  useWorkbenchWorkspaces,
} from "@operloom/react";
import { Pressable, Text, View } from "react-native";

import { useMobileAuth } from "../../src/auth/auth-provider";
import { Screen } from "../../src/components/screen";
import { mobileConfig } from "../../src/config";
import { revokeDeviceDelivery } from "../../src/notifications/device-delivery";
import { colors } from "../../src/theme";

const Row = ({ label, active, onPress }: { label: string; active: boolean; onPress(): void }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={{
      backgroundColor: active ? colors.accentSoft : colors.surface,
      borderColor: colors.line,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
    }}
  >
    <Text style={{ color: colors.ink, fontWeight: active ? "700" : "400" }}>{label}</Text>
  </Pressable>
);

export default function SettingsScreen() {
  const auth = useMobileAuth();
  const client = useWorkbenchClient();
  const session = useWorkbenchSession();
  const workspaceId = session.data?.workspace?.id ?? null;
  const workspaces = useWorkbenchWorkspaces();
  const agents = useWorkbenchAgents(true, workspaceId);
  const activateWorkspace = useActivateWorkspace();
  const activateAgent = useActivateAgent(workspaceId);

  return (
    <Screen title="Workspace" subtitle={mobileConfig.controlPlaneOrigin}>
      <View style={{ paddingHorizontal: 16, gap: 18 }}>
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.muted, fontWeight: "600" }}>Workspaces</Text>
          {(workspaces.data?.workspaces ?? []).map((workspace) => (
            <Row
              key={workspace.id}
              label={workspace.name}
              active={workspace.isActive}
              onPress={() => activateWorkspace.mutate(workspace.id)}
            />
          ))}
        </View>
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.muted, fontWeight: "600" }}>Agents</Text>
          {(agents.data?.agents ?? []).map((agent) => (
            <Row
              key={agent.id}
              label={agent.name}
              active={session.data?.activeAgent?.id === agent.id}
              onPress={() => activateAgent.mutate({ agentId: agent.id })}
            />
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void revokeDeviceDelivery(client).finally(() => auth.signOut())}
          style={{ borderColor: colors.danger, borderWidth: 1, borderRadius: 12, padding: 12 }}
        >
          <Text style={{ color: colors.danger, textAlign: "center", fontWeight: "600" }}>
            Sign out
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
