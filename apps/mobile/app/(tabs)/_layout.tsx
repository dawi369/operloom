import { Redirect, Tabs } from "expo-router";

import { useMobileAuth } from "../../src/auth/auth-provider";
import { colors } from "../../src/theme";

export default function TabsLayout() {
  const { state } = useMobileAuth();
  if (state === "signed-out") return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent }}>
      <Tabs.Screen name="chat" options={{ title: "Chat" }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals" }} />
      <Tabs.Screen name="artifacts" options={{ title: "Artifacts" }} />
      <Tabs.Screen name="memory" options={{ title: "Memory" }} />
      <Tabs.Screen name="settings" options={{ title: "Workspace" }} />
    </Tabs>
  );
}
