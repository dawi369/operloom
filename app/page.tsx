/**
 * Home route for the current assistant workbench.
 *
 * The first screen is the usable assistant thread surface. Higher-level
 * workbench panels can wrap this route over time without turning the app into a
 * marketing or demo landing page.
 */
import { WorkbenchShell } from "@/components/workbench/workbench-shell";
import {
  authPresentationCookieName,
  isSignedOutPresentation,
} from "@/lib/workbench/auth-presentation";
import { cookies } from "next/headers";

export default async function Home() {
  const cookieStore = await cookies();
  const demoMode = process.env.WORKBENCH_ENVIRONMENT === "demo";
  const initialSignedOutPresentation = isSignedOutPresentation(
    cookieStore.get(authPresentationCookieName)?.value,
  );

  return (
    <main className="h-dvh">
      <WorkbenchShell
        demoMode={demoMode}
        initialSignedOutPresentation={initialSignedOutPresentation}
      />
    </main>
  );
}
