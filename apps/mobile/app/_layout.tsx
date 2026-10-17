import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { MobileAuthProvider } from "../src/auth/auth-provider";
import { MobileDeviceProvider } from "../src/notifications/device-provider";
import { MobileWorkbenchProvider } from "../src/workbench-provider";

export default function RootLayout() {
  return (
    <MobileAuthProvider>
      <MobileWorkbenchProvider>
        <MobileDeviceProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }} />
        </MobileDeviceProvider>
      </MobileWorkbenchProvider>
    </MobileAuthProvider>
  );
}
