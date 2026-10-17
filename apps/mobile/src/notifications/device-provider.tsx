import { useWorkbenchClient } from "@operloom/react";
import * as Notifications from "expo-notifications";
import { router, type Href } from "expo-router";
import { useEffect, type PropsWithChildren } from "react";

import { useMobileAuth } from "../auth/auth-provider";
import { registerDeviceDelivery, routeForNotification } from "./device-delivery";

/** Registers this install for push once signed in and routes taps to the right tab. */
export function MobileDeviceProvider({ children }: PropsWithChildren) {
  const { state } = useMobileAuth();
  const client = useWorkbenchClient();
  useEffect(() => {
    if (state !== "signed-in") return;
    void registerDeviceDelivery(client).catch(() => undefined);
    const open = (data: unknown) => {
      const route = routeForNotification(data);
      if (route) router.push(route as Href);
    };
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) open(response.notification.request.content.data);
    });
    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      open(response.notification.request.content.data),
    );
    return () => subscription.remove();
  }, [client, state]);
  return children;
}
