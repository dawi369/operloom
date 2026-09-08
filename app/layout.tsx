/**
 * Root Next.js layout for the workbench shell.
 *
 * This file owns global font/theme providers and document metadata. Product
 * runtime behavior belongs in `app/assistant.tsx` and the API routes, keeping
 * layout concerns separate from agent orchestration.
 */
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";

import { getAuthConfiguration } from "@/lib/workbench/auth-configuration";
import { TooltipProvider } from "@/components/ui/tooltip";
import { workbenchProduct } from "@/lib/workbench/product-identity";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: workbenchProduct.webTitle,
    template: `%s · ${workbenchProduct.webTitle}`,
  },
  description: workbenchProduct.description,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { workOsConfigured } = getAuthConfiguration();
  return (
    <html lang="en">
      <body className={`${plexSans.variable} ${plexMono.variable} antialiased`}>
        <AuthKitProvider
          // Without an auth provider there is no session to restore. Local
          // identity remains a separate, server-authorized workspace decision.
          initialAuth={workOsConfigured ? undefined : { user: null }}
          onSessionExpired={workOsConfigured ? undefined : false}
        >
          <TooltipProvider>{children}</TooltipProvider>
        </AuthKitProvider>
      </body>
    </html>
  );
}
