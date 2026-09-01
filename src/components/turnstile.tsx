"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Script from "next/script";
import { TURNSTILE_SITE_KEY } from "@/lib/auth/guest";

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileProps {
  /** Fires with a fresh token, or null when the token expires or errors out. */
  onToken: (token: string | null) => void;
  /**
   * Receives a function that discards the current token and asks Turnstile for
   * a new one. Tokens are single-use, so a failed submit must reset before the
   * next attempt or the retry is rejected as a replay.
   */
  registerReset?: (reset: () => void) => void;
}

/**
 * Cloudflare Turnstile widget, rendered only when a site key is configured.
 *
 * "interaction-only" appearance keeps it invisible unless Cloudflare actually
 * wants a challenge, so the common case stays a single click.
 */
export function Turnstile({ onToken, registerReset }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const [scriptReady, setScriptReady] = useState(false);

  // Kept in a ref so re-rendering the parent with a new closure doesn't tear
  // down and re-render the widget, which would drop a valid token.
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const reset = useCallback(() => {
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
      onTokenRef.current(null);
    }
  }, []);

  useEffect(() => {
    registerReset?.(reset);
  }, [registerReset, reset]);

  useEffect(() => {
    if (!scriptReady || !TURNSTILE_SITE_KEY) return;
    const container = containerRef.current;
    if (!container || !window.turnstile || widgetIdRef.current) return;

    widgetIdRef.current = window.turnstile.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (token: string) => onTokenRef.current(token),
      "expired-callback": () => onTokenRef.current(null),
      "error-callback": () => onTokenRef.current(null),
    });

    return () => {
      const id = widgetIdRef.current;
      widgetIdRef.current = null;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [scriptReady]);

  if (!TURNSTILE_SITE_KEY) return null;

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        onReady={() => setScriptReady(true)}
      />
      <div ref={containerRef} className="empty:hidden" />
    </>
  );
}
