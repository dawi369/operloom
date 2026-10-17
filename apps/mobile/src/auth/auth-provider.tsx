import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import { mobileAuthConfigured } from "../config";
import { createSingleFlight, type MobileAuthFailure } from "./auth-flow";
import {
  refreshWorkosSession,
  signInWithWorkos,
  type MobileSignInProvider,
  type StoredMobileSession,
} from "./workos-mobile-auth";

type AuthState = "loading" | "signed-out" | "signed-in";
type AuthOperation = "idle" | "signing-in" | "refreshing" | "signing-out";

type AuthContextValue = {
  state: AuthState;
  operation: AuthOperation;
  error: MobileAuthFailure | null;
  configured: boolean;
  getAccessToken(input?: { minValidityMs?: number }): Promise<string | null>;
  signIn(provider?: MobileSignInProvider): Promise<void>;
  signOut(): Promise<void>;
  clearError(): void;
};

const storageKey = "operloom.workos-session";
const AuthContext = createContext<AuthContextValue | null>(null);

const saveSession = async (session: StoredMobileSession | null) => {
  if (!session) return SecureStore.deleteItemAsync(storageKey);
  await SecureStore.setItemAsync(storageKey, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
};

const readSession = async () => {
  const encoded = await SecureStore.getItemAsync(storageKey);
  if (!encoded) return null;
  try {
    const session = JSON.parse(encoded) as StoredMobileSession;
    return session.accessToken && Number.isFinite(session.expiresAt) ? session : null;
  } catch {
    await saveSession(null);
    return null;
  }
};

export const clearSavedMobileSession = () => saveSession(null);

export function MobileAuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<StoredMobileSession | null>(null);
  const [state, setState] = useState<AuthState>("loading");
  const [operation, setOperation] = useState<AuthOperation>("idle");
  const [error, setError] = useState<MobileAuthFailure | null>(null);
  const refreshPromise = useRef<Promise<StoredMobileSession | null> | null>(null);
  const authorityGeneration = useRef(0);
  const signInFlight = useRef(createSingleFlight<void>()).current;

  useEffect(() => {
    void readSession()
      .then((stored) => {
        setSession(stored);
        setState(stored ? "signed-in" : "signed-out");
      })
      .catch(async () => {
        const failure: MobileAuthFailure = {
          stage: "session_persistence",
          code: "session_persistence_failed",
          message: "Your saved session could not be opened securely. Please sign in again.",
          retryable: true,
        };
        setSession(null);
        setError(failure);
        setState("signed-out");
      });
  }, []);

  const refresh = useCallback(async () => {
    if (!session?.refreshToken || !mobileAuthConfigured) return null;
    if (!refreshPromise.current) {
      const generation = authorityGeneration.current;
      setOperation("refreshing");
      refreshPromise.current = refreshWorkosSession(session.refreshToken)
        .then(async (next) => {
          if (authorityGeneration.current !== generation) return null;
          await saveSession(next);
          if (authorityGeneration.current !== generation) {
            await saveSession(null).catch(() => undefined);
            return null;
          }
          setSession(next);
          setState("signed-in");
          return next;
        })
        .catch(async () => {
          if (authorityGeneration.current !== generation) return null;
          const failure: MobileAuthFailure = {
            stage: "token_exchange",
            code: "refresh_failed",
            message: "Your session expired. Please sign in again.",
            retryable: true,
          };
          await saveSession(null).catch(() => undefined);
          setSession(null);
          setError(failure);
          setState("signed-out");
          return null;
        })
        .finally(() => {
          if (authorityGeneration.current === generation) {
            refreshPromise.current = null;
            setOperation("idle");
          }
        });
    }
    return refreshPromise.current;
  }, [session]);

  const getAccessToken = useCallback(
    async (input?: { minValidityMs?: number }) => {
      if (!session) return null;
      if (session.expiresAt - Date.now() > (input?.minValidityMs ?? 60_000)) {
        return session.accessToken;
      }
      const generation = authorityGeneration.current;
      const next = await refresh();
      if (next) return next.accessToken;
      if (authorityGeneration.current !== generation) return null;
      await saveSession(null).catch(() => undefined);
      setSession(null);
      setState("signed-out");
      return null;
    },
    [refresh, session],
  );

  const signIn = useCallback(
    async (provider?: MobileSignInProvider) => {
      return signInFlight
        .run(async () => {
          const generation = ++authorityGeneration.current;
          setOperation("signing-in");
          setError(null);
          const result = await signInWithWorkos({ provider, persistSession: saveSession });
          if (result.type === "signed-in" && authorityGeneration.current === generation) {
            setSession(result.session);
            setState("signed-in");
          } else if (result.type === "failed") {
            setError(result.failure);
          }
          setOperation("idle");
        })
        .catch(() => {
          // The flow is intentionally total. This is a final UI boundary for programming errors.
          const failure: MobileAuthFailure = {
            stage: "authorization_request",
            code: "request_failed",
            message: "Sign-in could not be started. Please try again.",
            retryable: true,
          };
          setError(failure);
          setOperation("idle");
        });
    },
    [signInFlight],
  );

  const signOut = useCallback(async () => {
    authorityGeneration.current += 1;
    setOperation("signing-out");
    setError(null);
    refreshPromise.current = null;
    const results = await Promise.allSettled([clearSavedMobileSession()]);
    setSession(null);
    setState("signed-out");
    setOperation("idle");
    if (results.some((result) => result.status === "rejected")) {
      const failure: MobileAuthFailure = {
        stage: "session_persistence",
        code: "session_persistence_failed",
        message: "Local session cleanup was incomplete. Please try again.",
        retryable: true,
      };
      setError(failure);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      operation,
      error,
      configured: mobileAuthConfigured,
      getAccessToken,
      signIn,
      signOut,
      clearError,
    }),
    [clearError, error, getAccessToken, operation, signIn, signOut, state],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useMobileAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useMobileAuth must be used inside MobileAuthProvider");
  return context;
};
