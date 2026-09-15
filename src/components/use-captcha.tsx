"use client";

import { useCallback, useRef } from "react";
import {
  Turnstile,
  type TurnstileControls,
  type TurnstileFailure,
} from "@/components/turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/auth/guest";

export interface CaptchaResult {
  /** False when no token is coming; see `reason`. */
  ok: boolean;
  /** Null when CAPTCHA is not configured, which is the local-dev default. */
  token: string | null;
  /** Set only when ok is false. Pass to captchaMessage() for the copy. */
  reason?: TurnstileFailure;
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
  const tokenRef = useRef<string | null>(null);
  const controlsRef = useRef<TurnstileControls | null>(null);
  const executeRequested = useRef(false);
  const waiters = useRef<Array<(result: CaptchaResult) => void>>([]);
  /**
   * Sticky once the script itself is gone. The widget only tries to load on
   * mount, so a later getToken() has nothing left to wait for and should say
   * so at once instead of sitting out the full timeout. A "rejected"
   * challenge is not sticky — that one is worth retrying.
   */
  const unavailable = useRef(false);

  /** Hand every pending getToken() the same outcome, once. */
  const release = useCallback((result: CaptchaResult) => {
    waiters.current.splice(0).forEach((resolve) => resolve(result));
  }, []);

  /**
   * Hand the widget back in a state that can run again. A spent challenge
   * leaves an in-flight flag that execute() alone will not clear, so without
   * this the *next* attempt quietly does nothing and rides the timeout out.
   * Done here rather than in each caller so no caller can forget.
   */
  const clearForRetry = useCallback(() => {
    controlsRef.current?.reset();
  }, []);

  const handleToken = useCallback(
    (token: string | null) => {
      tokenRef.current = token;
      // Release anyone who submitted before the token arrived.
      if (token) release({ ok: true, token });
    },
    [release]
  );

  /**
   * A failure has to release the waiters too. Leaving them pending was how a
   * rejected challenge — a site key not valid for the hostname, say — turned
   * into fifteen seconds of a dead "Starting…" button followed by a message
   * blaming the visitor's ad blocker.
   */
  const handleFailure = useCallback(
    (reason: TurnstileFailure) => {
      tokenRef.current = null;
      if (reason === "unavailable") unavailable.current = true;
      release({ ok: false, token: null, reason });
      clearForRetry();
    },
    [release, clearForRetry]
  );

  const registerControls = useCallback((controls: TurnstileControls) => {
    controlsRef.current = controls;
    if (executeRequested.current) {
      executeRequested.current = false;
      controls.execute();
    }
  }, []);

  /**
   * Resolves with a token, or ok:false if none is coming. The challenge is
   * started here, on demand, rather than when the widget mounts. Turnstile is
   * widely blocked by privacy extensions and a blocked script never calls
   * back, so the timeout remains the backstop for a widget that goes silent.
   */
  const getToken = useCallback(
    (timeoutMs = 15000): Promise<CaptchaResult> => {
      if (!TURNSTILE_SITE_KEY) return Promise.resolve({ ok: true, token: null });
      if (tokenRef.current) {
        return Promise.resolve({ ok: true, token: tokenRef.current });
      }
      if (unavailable.current) {
        return Promise.resolve({
          ok: false,
          token: null,
          reason: "unavailable" as const,
        });
      }

      if (controlsRef.current) controlsRef.current.execute();
      else executeRequested.current = true;

      return new Promise((resolve) => {
        const waiter = (result: CaptchaResult) => {
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          waiters.current = waiters.current.filter((w) => w !== waiter);
          // Deliberately not sticky, unlike a script that never loaded. A
          // widget that went quiet for fifteen seconds may only have been
          // slow; we have no evidence it is gone, and claiming otherwise
          // would lock the visitor out until they reloaded. The retry costs
          // another wait, which is the honest price of not knowing.
          clearForRetry();
          resolve({ ok: false, token: null, reason: "unavailable" });
        }, timeoutMs);
        waiters.current.push(waiter);
      });
    },
    [clearForRetry]
  );

  /**
   * Tokens are single-use, so a failed attempt must discard the old one — and
   * so must a successful one, or the next submit would replay it.
   */
  const reset = useCallback(() => {
    tokenRef.current = null;
    controlsRef.current?.reset();
  }, []);

  const render = (
    <Turnstile
      onToken={handleToken}
      onFailure={handleFailure}
      registerControls={registerControls}
    />
  );

  return { render, getToken, reset };
}

export const CAPTCHA_BLOCKED_MESSAGE =
  "The verification check didn't load — an ad blocker or privacy extension may be blocking it. Allow this site and try again.";

const CAPTCHA_REJECTED_MESSAGE =
  "The verification check didn't pass. Please try again — if it keeps failing, sign-in is temporarily unavailable.";

/**
 * Copy for a failed getToken(). The distinction matters to the visitor: one
 * of these is worth acting on, and the other means the site is misconfigured
 * and no amount of allowlisting on their end will help.
 *
 * Neither message offers another way in, and that is deliberate. Supabase's
 * CAPTCHA switch is project-wide, so every route — guest sign-in, magic link,
 * any we add later — is gated by this same widget and this same site key.
 * There is no CAPTCHA-free path to point at, and in the misconfigured-key
 * case that `rejected` exists to name, sending someone to a second flow means
 * sending them somewhere guaranteed to fail the same way.
 */
export function captchaMessage(reason: TurnstileFailure | undefined): string {
  return reason === "rejected"
    ? CAPTCHA_REJECTED_MESSAGE
    : CAPTCHA_BLOCKED_MESSAGE;
}
