import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms",
  description: "Terms for the Operloom public demo.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-6 py-16 sm:px-10">
      <Link className="text-muted-foreground text-sm underline-offset-4 hover:underline" href="/">
        ← Operloom
      </Link>
      <article className="mt-12 space-y-8">
        <header className="space-y-3">
          <p className="text-muted-foreground font-mono text-xs tracking-[0.14em] uppercase">
            Public demo
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-[-0.03em]">Terms</h1>
          <p className="text-muted-foreground leading-7">Last updated September 13, 2026.</p>
        </header>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Evaluation use</h2>
          <p className="text-muted-foreground leading-7">
            This public demo is provided for evaluating Operloom. It is not a production service,
            has no service-level guarantee, may cold-start, and may be changed or unavailable at any
            time.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Limits and acceptable use</h2>
          <p className="text-muted-foreground leading-7">
            Usage and concurrency limits apply. Do not attempt to evade limits, disrupt the service,
            access another user&apos;s data, or submit credentials, unlawful material, or sensitive
            personal information.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Outputs and responsibility</h2>
          <p className="text-muted-foreground leading-7">
            Model and workflow output can be incomplete or incorrect. Verify important results
            independently. You remain responsible for the content you submit and how you use any
            output.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Data handling</h2>
          <p className="text-muted-foreground leading-7">
            Use of the demo is also subject to the published privacy information. Demo operational
            data is retained for no more than seven days under the demo policy.
          </p>
          <Link className="inline-flex text-sm underline underline-offset-4" href="/privacy">
            Read the privacy notice
          </Link>
        </section>
      </article>
    </main>
  );
}
