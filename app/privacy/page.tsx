import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Privacy information for the Operloom public demo.",
};

export default function PrivacyPage() {
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
          <h1 className="font-display text-4xl font-semibold tracking-[-0.03em]">Privacy</h1>
          <p className="text-muted-foreground leading-7">Last updated September 13, 2026.</p>
        </header>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">What the demo processes</h2>
          <p className="text-muted-foreground leading-7">
            Operloom processes your sign-in identity, chat messages, workflow inputs and outputs,
            generated artifacts, and operational security records needed to run and protect the
            service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Providers</h2>
          <p className="text-muted-foreground leading-7">
            WorkOS handles authentication. Cloudflare stores demo workspace data and runs the
            control plane. OpenRouter and its selected model provider process model requests. Fly
            runs repository-analysis workflows. Sentry receives error diagnostics with replay and
            performance tracing disabled.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Retention and use</h2>
          <p className="text-muted-foreground leading-7">
            Demo chats, runs, audit records, and artifacts are deleted after seven days. Identity
            and session records follow WorkOS account controls. Data is not sold or used for
            advertising. Do not submit secrets or sensitive personal information to this public
            evaluation environment.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">Questions or deletion</h2>
          <p className="text-muted-foreground leading-7">
            Use the workspace controls to manage your account data, or contact the project owner.
          </p>
          <a
            className="inline-flex text-sm underline underline-offset-4"
            href="mailto:operloom@t23.dev"
          >
            operloom@t23.dev
          </a>
        </section>
      </article>
    </main>
  );
}
