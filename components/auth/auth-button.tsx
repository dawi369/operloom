"use client";

import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Building2Icon, Loader2Icon, LogInIcon, LogOutIcon, UserIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Client-side auth button that shows sign-in or user info + sign-out.
 * Uses refreshAuth({ ensureSignedIn: true }) for sign-in to avoid
 * server component cookie issues in Next.js 15+/16.
 */
export function AuthButton({
  localSession = false,
  onOpenWorkspace,
}: {
  localSession?: boolean;
  onOpenWorkspace?: () => void;
}) {
  const { user, loading, signOut, refreshAuth } = useAuth();

  if (loading) {
    return (
      <Button variant="ghost" size="sm" disabled>
        <Loader2Icon className="animate-spin" />
      </Button>
    );
  }

  if (user || localSession) {
    return (
      <div className="flex max-w-full min-w-0 items-center gap-2">
        <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <UserIcon className="size-3.5 shrink-0" />
          <span className="truncate">{user?.email ?? user?.firstName ?? "Local development"}</span>
        </span>
        {onOpenWorkspace ? (
          <Button
            className="shrink-0"
            variant="ghost"
            size="sm"
            onClick={onOpenWorkspace}
            title="Workspace access"
          >
            <Building2Icon className="size-4" />
            <span className="sr-only">Workspace access</span>
          </Button>
        ) : null}
        {user ? (
          <Button
            className="shrink-0"
            variant="ghost"
            size="sm"
            onClick={() => void signOut()}
            title="Sign out"
          >
            <LogOutIcon className="size-4" />
            <span className="sr-only">Sign out</span>
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={() => void refreshAuth({ ensureSignedIn: true })}>
      <LogInIcon className="size-4" />
      Sign in
    </Button>
  );
}
