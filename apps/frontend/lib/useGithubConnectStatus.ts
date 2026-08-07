"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AlertVariant } from "@/components/ui/Alert";

const ERROR_MESSAGES: Record<string, string> = {
  github_already_linked: "That GitHub account is already connected to a different Dreamer account.",
  github_connect_failed: "Failed to connect your GitHub account. Please try again.",
};

/**
 * Reads the ?github=connected / ?error=<code> query params that
 * githubCallbackHandler redirects back with after a Connect GitHub
 * attempt, turns them into a one-time banner, and strips them from the URL
 * so refreshing the page doesn't keep re-showing it.
 */
export function useGithubConnectStatus(): { variant: AlertVariant; message: string } | null {
  const searchParams = useSearchParams();
  const router = useRouter();
  const hasCleanedUp = useRef(false);

  const status = useMemo(() => {
    const githubParam = searchParams.get("github");
    const errorParam = searchParams.get("error");

    if (githubParam === "connected") {
      return { variant: "success" as const, message: "GitHub account connected." };
    }

    if (errorParam && errorParam in ERROR_MESSAGES) {
      return { variant: "error" as const, message: ERROR_MESSAGES[errorParam] };
    }

    return null;
  }, [searchParams]);

  useEffect(() => {
    if (!status || hasCleanedUp.current) {
      return;
    }

    hasCleanedUp.current = true;

    const params = new URLSearchParams(searchParams.toString());
    params.delete("github");
    params.delete("error");

    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    router.replace(nextUrl);
  }, [router, searchParams, status]);

  return status;
}
