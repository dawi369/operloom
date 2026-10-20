import {
  createRuntimeClient,
  createWorkbenchClient,
  createWorkbenchRealtimeAdapter,
  type WorkbenchSessionEvent,
} from "@operloom/client";
import {
  WorkbenchClientProvider,
  createWorkbenchQueryClient,
  invalidateWorkbenchQueries,
  useWorkbenchQueryClient,
  workbenchSessionEventInvalidations,
} from "@operloom/react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppState } from "react-native";
import { focusManager } from "@tanstack/react-query";

import { useMobileAuth } from "./auth/auth-provider";
import { mobileConfig } from "./config";

type RuntimeClient = ReturnType<typeof createRuntimeClient>;
type RealtimeState = "idle" | "connecting" | "connected" | "reconnecting";

type MobileWorkbench = {
  runtime: RuntimeClient;
  realtimeState: RealtimeState;
};

const MobileWorkbenchContext = createContext<MobileWorkbench | null>(null);
const clientIdentity = { platform: mobileConfig.platform, version: mobileConfig.version };

/** Keeps React Query in step with the Worker's session stream while the app is foregrounded. */
function SessionStream({
  realtime,
  onState,
}: {
  realtime: ReturnType<typeof createWorkbenchRealtimeAdapter>;
  onState(state: RealtimeState): void;
}) {
  const queryClient = useWorkbenchQueryClient();
  const lastEventId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let closed = false;
    let subscription: ReturnType<typeof realtime.subscribeSession> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed || AppState.currentState !== "active") return;
      onState(lastEventId.current ? "reconnecting" : "connecting");
      subscription = realtime.subscribeSession({ after: lastEventId.current });
      void (async () => {
        try {
          for await (const event of subscription!.events) {
            onState("connected");
            const typed: WorkbenchSessionEvent = event;
            if (typed.id) lastEventId.current = typed.id;
            void invalidateWorkbenchQueries(queryClient, workbenchSessionEventInvalidations(typed));
          }
        } catch {
          // The stream ends on network loss; a bounded retry resumes from the last id.
        }
        if (!closed) retry = setTimeout(connect, 2_000);
      })();
    };
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") connect();
      else {
        subscription?.close();
        onState("idle");
      }
    });
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      subscription?.close();
      appState.remove();
    };
  }, [onState, queryClient, realtime]);
  return null;
}

// react-query only knows browser focus; without this, intervals keep polling while the app is backgrounded.
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener("change", (state) =>
    handleFocus(state === "active"),
  );
  return () => subscription.remove();
});

export function MobileWorkbenchProvider({ children }: PropsWithChildren) {
  const auth = useMobileAuth();
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("idle");
  const queryClient = useMemo(() => createWorkbenchQueryClient(), []);
  const getAccessToken = auth.getAccessToken;
  const { client, realtime, runtime } = useMemo(() => {
    const baseUrl = `${mobileConfig.controlPlaneOrigin}/v1/me`;
    return {
      client: createWorkbenchClient({
        baseUrl,
        target: "control-plane",
        client: clientIdentity,
        getAccessToken,
      }),
      realtime: createWorkbenchRealtimeAdapter({
        baseUrl,
        target: "control-plane",
        client: clientIdentity,
        getAccessToken,
      }),
      runtime: createRuntimeClient({
        baseUrl: mobileConfig.controlPlaneOrigin,
        target: "me",
        getAccessToken: ({ minValidityMs }) => getAccessToken({ minValidityMs }),
      }),
    };
  }, [getAccessToken]);
  const value = useMemo(() => ({ runtime, realtimeState }), [runtime, realtimeState]);
  return (
    <WorkbenchClientProvider client={client} queryClient={queryClient}>
      <MobileWorkbenchContext.Provider value={value}>
        {auth.state === "signed-in" ? (
          <SessionStream realtime={realtime} onState={setRealtimeState} />
        ) : null}
        {children}
      </MobileWorkbenchContext.Provider>
    </WorkbenchClientProvider>
  );
}

export const useMobileWorkbench = () => {
  const context = useContext(MobileWorkbenchContext);
  if (!context) throw new Error("useMobileWorkbench must be used inside MobileWorkbenchProvider");
  return context;
};
