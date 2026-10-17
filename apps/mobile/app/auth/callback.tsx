import { Redirect } from "expo-router";

/** The system browser returns here; the sign-in flow already consumed the URL via Linking. */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
