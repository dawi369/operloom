import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({
  default: { easConfig: { projectId: "proj" }, expoConfig: {} },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "install-1" }));
vi.mock("expo-device", () => ({ isDevice: true }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
  deleteItemAsync: async (key: string) => void store.delete(key),
}));
const permission = { status: "granted" };
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: async () => permission,
  requestPermissionsAsync: async () => permission,
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[abc]" }),
}));

const { deviceDeliveryState, registerDeviceDelivery, revokeDeviceDelivery, routeForNotification } =
  await import("./device-delivery");

const client = () => {
  const calls: unknown[] = [];
  const devices = [{ id: "dev-1", status: "active" }];
  return {
    calls,
    client: {
      devices: {
        register: async (input: unknown) => {
          calls.push(["register", input]);
          return { ok: true, device: { id: "dev-1" } };
        },
        revoke: async (id: string) => {
          calls.push(["revoke", id]);
          devices.length = 0;
          return { ok: true };
        },
        list: async () => ({ ok: true, devices }),
      },
    } as never,
  };
};

describe("device delivery", () => {
  it("registers once per install with a stable installation id and tracks the device", async () => {
    const { client: api, calls } = client();
    expect(await registerDeviceDelivery(api)).toEqual({ state: "registered", deviceId: "dev-1" });
    expect(await registerDeviceDelivery(api)).toEqual({ state: "registered", deviceId: "dev-1" });
    expect(
      calls.map((call) => (call as [string, { installationId: string }])[1].installationId),
    ).toEqual(["install-1", "install-1"]);
    expect(await deviceDeliveryState(api)).toBe("registered");
    await revokeDeviceDelivery(api);
    expect(calls.at(-1)).toEqual(["revoke", "dev-1"]);
    expect(await deviceDeliveryState(api)).toBe("unregistered");
  });

  it("reports denial without registering", async () => {
    permission.status = "denied";
    const { client: api, calls } = client();
    expect(await registerDeviceDelivery(api)).toEqual({ state: "denied" });
    expect(calls).toEqual([]);
    permission.status = "granted";
  });

  it("maps notification routes onto app screens", () => {
    expect(routeForNotification({ route: "approvals" })).toBe("/(tabs)/approvals");
    expect(routeForNotification({ route: "memory", recordId: "m" })).toBe("/(tabs)/memory");
    expect(routeForNotification({ route: "history", recordId: "r" })).toBe("/(tabs)/chat");
    expect(routeForNotification({ route: "unknown" })).toBeNull();
    expect(routeForNotification(null)).toBeNull();
  });
});
