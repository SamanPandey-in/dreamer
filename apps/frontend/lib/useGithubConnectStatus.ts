"use client";

import { useEffect, useState } from "react";
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
  const [status, setStatus] = useState<{ variant: AlertVariant; message: string } | null>(null);

  useEffect(() => {
    const githubParam = searchParams.get("github");
    const errorParam = searchParams.get("error");

    if (githubParam === "connected") {
      setStatus({ variant: "success", message: "GitHub account connected." });
    } else if (errorParam && errorParam in ERROR_MESSAGES) {
      setStatus({ variant: "error", message: ERROR_MESSAGES[errorParam] });
    } else {
      return;
    }

    router.replace(window.location.pathname);
    // Only meant to run once, against whatever query string the page
    // landed on — router.replace() below intentionally changes the URL
    // out from under this same effect, so it must not re-fire because of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return status;
}
