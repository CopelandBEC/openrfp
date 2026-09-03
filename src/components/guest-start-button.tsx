"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useCaptcha, CAPTCHA_BLOCKED_MESSAGE } from "@/components/use-captcha";

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
  const captcha = useCaptcha();

  async function handleClick() {
    if (pending) return;
    setPending(true);
    setError("");

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      const { ok, token } = await captcha.getToken();
      if (!ok) {
        setPending(false);
        setError(CAPTCHA_BLOCKED_MESSAGE);
        return;
      }

      const { error: signInError } = await supabase.auth.signInAnonymously(
        token ? { options: { captchaToken: token } } : undefined
      );

      if (signInError) {
        // Surfaced because the two likeliest causes are configuration, not
        // user error: anonymous sign-ins left disabled in the Supabase
        // dashboard, or a Turnstile secret key that doesn't match the site
        // key. Both look identical from the outside.
        console.error("Guest sign-in failed:", signInError.message);
        captcha.reset();
        setPending(false);
        setError(
          signInError.status === 429
            ? "Too many sessions started from this network. Please wait a few minutes, or sign in instead."
            : "Couldn't start a session. Please try again, or sign in with an email link."
        );
        return;
      }

      // The destination is proxy-protected and reads the session from a
      // cookie, so navigating before that cookie is readable would bounce the
      // visitor straight back to /login. Confirm it landed first.
      if (!(await waitForSession(supabase))) {
        setPending(false);
        setError(
          "Your browser blocked the session cookie. Check that cookies are enabled for this site, then try again."
        );
        return;
      }
    }

    router.push(next);
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

      {captcha.render}

      {error && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
