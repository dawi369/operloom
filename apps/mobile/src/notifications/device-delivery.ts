import type { WorkbenchClient } from "@operloom/client";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";

import { mobileConfig } from "../config";

const installationKey = "operloom.push.installation-id";
const deviceKey = "operloom.push.device-id";

/** One stable id per install so re-registration replays instead of duplicating the device. */
const installationId = async () => {
  const existing = await SecureStore.getItemAsync(installationKey);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(installationKey, created);
  return created;
};

export type DeviceDeliveryState = "unsupported" | "denied" | "registered" | "unregistered";

export const registerDeviceDelivery = async (
  client: WorkbenchClient,
): Promise<{ state: DeviceDeliveryState; deviceId?: string }> => {
  if (!Device.isDevice) return { state: "unsupported" };
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return { state: "unsupported" };
  const current = await Notifications.getPermissionsAsync();
  const permission =
    current.status === "granted" ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted") return { state: "denied" };
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const response = await client.devices.register({
    installationId: await installationId(),
    platform: mobileConfig.platform,
    token: token.data,
    appVersion: mobileConfig.version,
  });
  const deviceId = response.device?.id;
  if (deviceId) await SecureStore.setItemAsync(deviceKey, deviceId);
  return deviceId ? { state: "registered", deviceId } : { state: "unregistered" };
};

export const revokeDeviceDelivery = async (client: WorkbenchClient) => {
  const deviceId = await SecureStore.getItemAsync(deviceKey);
  if (!deviceId) return;
  await client.devices.revoke(deviceId).catch(() => undefined);
  await SecureStore.deleteItemAsync(deviceKey);
};

export const deviceDeliveryState = async (
  client: WorkbenchClient,
): Promise<DeviceDeliveryState> => {
  const deviceId = await SecureStore.getItemAsync(deviceKey);
  if (!deviceId) return "unregistered";
  const response = await client.devices.list();
  const active = response.devices?.some(
    (device) => device.id === deviceId && device.status === "active",
  );
  if (!active) await SecureStore.deleteItemAsync(deviceKey);
  return active ? "registered" : "unregistered";
};

/** Maps notification payload routes (see the Worker's notification deliveries) to app routes. */
export const routeForNotification = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;
  const route = "route" in data && typeof data.route === "string" ? data.route : "";
  if (route === "approvals") return "/(tabs)/approvals";
  if (route === "memory") return "/(tabs)/memory";
  if (route === "history" || route === "actions" || route === "chat") return "/(tabs)/chat";
  return null;
};
