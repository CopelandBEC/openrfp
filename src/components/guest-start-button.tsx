"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Turnstile } from "@/components/turnstile";
import { createClient } from "@/lib/supabase/client";
import { TURNSTILE_SITE_KEY } from "@/lib/auth/guest";

/**
 * Polls local session storage until the new session is readable. Purely local
 * — no network — so the common case resolves on the first pass.
 */
async function waitForSession(
  supabase: ReturnType<typeof createClient>,
  attempts = 10
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

interface GuestStartButtonProps {
  children: React.ReactNode;
  /** Where to land once a session exists. */
  next?: string;
  size?: "default" | "sm" | "lg";
  variant?: "default" | "outline";
  /** Wrapper classes. */
  className?: string;
  /** Classes for the button itself. */
  buttonClassName?: string;
}

/**
 * Starts a guest session and moves the visitor straight into the flow.
 *
 * The anonymous sign-in happens on an explicit click rather than on page load:
 * every session is a permanent row in auth.users, so minting one for each
 * crawler that touches the landing page would fill the table with rows nobody
 * asked for. A visitor who already has a session (guest or signed-in) skips
 * straight through.
 */
export function GuestStartButton({
  children,
  next = "/rfp/new",
  size = "lg",
  variant = "default",
  className,
  buttonClassName = "w-full sm:w-auto",
}: GuestStartButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  // Set when the visitor clicks before Turnstile has produced a token, so the
  // token callback below can pick that click back up once one arrives.
  const awaitingCaptcha = useRef(false);
  const captchaTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetCaptcha = useRef<(() => void) | null>(null);

  const start = useCallback(
    async (token: string | null) => {
      setPending(true);
      setError("");

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        const { error: signInError } = await supabase.auth.signInAnonymously(
          token ? { options: { captchaToken: token } } : undefined
        );

        if (signInError) {
          // Surfaced because the two likeliest causes are configuration, not
          // user error: anonymous sign-ins left disabled in the Supabase
          // dashboard, or a Turnstile secret key that doesn't match the site
          // key. Both look identical from the outside.
          console.error("Guest sign-in failed:", signInError.message);

          // The token is single-use — a retry needs a fresh one.
          resetCaptcha.current?.();
          setCaptchaToken(null);
          setPending(false);
          setError(
            signInError.status === 429
              ? "Too many sessions started from this network. Please wait a few minutes, or sign in instead."
              : "Couldn't start a session. Please try again, or sign in with an email link."
          );
          return;
        }

        // The destination is proxy-protected and reads the session from a
        // cookie, so navigating before that cookie is readable would bounce
        // the visitor straight back to /login. Confirm it landed first.
        if (!(await waitForSession(supabase))) {
          setPending(false);
          setError(
            "Your browser blocked the session cookie. Check that cookies are enabled for this site, then try again."
          );
          return;
        }
      }

      router.push(next);
    },
    [next, router]
  );

  useEffect(
    () => () => {
      if (captchaTimeout.current) clearTimeout(captchaTimeout.current);
    },
    []
  );

  const handleToken = useCallback(
    (token: string | null) => {
      setCaptchaToken(token);

      // Resume a click that arrived before Turnstile had a token for it.
      if (token && awaitingCaptcha.current) {
        awaitingCaptcha.current = false;
        if (captchaTimeout.current) clearTimeout(captchaTimeout.current);
        void start(token);
      }
    },
    [start]
  );

  function handleClick() {
    if (pending) return;

    if (TURNSTILE_SITE_KEY && !captchaToken) {
      awaitingCaptcha.current = true;
      setPending(true);

      // Turnstile is widely blocked by privacy extensions, and a blocked
      // script never calls back — without this the button would sit on
      // "Starting…" indefinitely with nothing to tell the visitor why.
      captchaTimeout.current = setTimeout(() => {
        awaitingCaptcha.current = false;
        setPending(false);
        setError(
          "The verification check didn't load — an ad blocker or privacy extension may be blocking it. Allow this site, or sign in with an email link instead."
        );
      }, 15000);

      return;
    }

    void start(captchaToken);
  }

  return (
    <div className={className}>
      <Button
        size={size}
        variant={variant}
        onClick={handleClick}
        disabled={pending}
        className={buttonClassName}
      >
        {pending ? "Starting…" : children}
      </Button>

      <Turnstile
        onToken={handleToken}
        registerReset={(reset) => {
          resetCaptcha.current = reset;
        }}
      />

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
