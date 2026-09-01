"use client";

import { useCallback, useRef, useState } from "react";
import { Turnstile } from "@/components/turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/auth/guest";

export interface CaptchaResult {
  /** False when verification never loaded — usually a blocking extension. */
  ok: boolean;
  /** Null when CAPTCHA is not configured, which is the local-dev default. */
  token: string | null;
}

/**
 * Shared Turnstile plumbing for every form that hits an unauthenticated
 * Supabase auth endpoint.
 *
 * Supabase's CAPTCHA protection is a project-wide switch: turning it on makes
 * a token mandatory on sign-up, OTP/magic link, password sign-in and anonymous
 * sign-in alike. So the magic-link form needs one just as much as the guest
 * button does — enabling the setting with only the guest path wired up would
 * take existing sign-in down. (Authenticated calls such as updateUser, which
 * is how a guest saves their work, are not covered by that switch.)
 *
 * `render` must be placed in the tree for tokens to arrive.
 */
export function useCaptcha() {
  const [, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const waiters = useRef<Array<(token: string) => void>>([]);

  const handleToken = useCallback((token: string | null) => {
    tokenRef.current = token;
    setToken(token);
    if (token) {
      // Release anyone who submitted before the token arrived.
      waiters.current.splice(0).forEach((resolve) => resolve(token));
    }
  }, []);

  /**
   * Resolves with a token, or ok:false if none arrives in time. Turnstile is
   * widely blocked by privacy extensions and a blocked script never calls
   * back, so waiting forever is not an option.
   */
  const getToken = useCallback(
    (timeoutMs = 15000): Promise<CaptchaResult> => {
      if (!TURNSTILE_SITE_KEY) return Promise.resolve({ ok: true, token: null });
      if (tokenRef.current) {
        return Promise.resolve({ ok: true, token: tokenRef.current });
      }

      return new Promise((resolve) => {
        const waiter = (token: string) => {
          clearTimeout(timer);
          resolve({ ok: true, token });
        };
        const timer = setTimeout(() => {
          waiters.current = waiters.current.filter((w) => w !== waiter);
          resolve({ ok: false, token: null });
        }, timeoutMs);
        waiters.current.push(waiter);
      });
    },
    []
  );

  /** Tokens are single-use, so a failed attempt must discard the old one. */
  const reset = useCallback(() => {
    tokenRef.current = null;
    resetRef.current?.();
  }, []);

  const render = (
    <Turnstile
      onToken={handleToken}
      registerReset={(fn) => {
        resetRef.current = fn;
      }}
    />
  );

  return { render, getToken, reset };
}

export const CAPTCHA_BLOCKED_MESSAGE =
  "The verification check didn't load — an ad blocker or privacy extension may be blocking it. Allow this site and try again.";
