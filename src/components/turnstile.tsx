"use client";

import { useCallback, useEffect, useRef } from "react";
import { TURNSTILE_SITE_KEY } from "@/lib/auth/guest";

interface TurnstileApi {
  render: (el: HTMLElement, options: Record<string, unknown>) => string;
  execute: (widgetId?: string) => void;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loader: Promise<TurnstileApi> | null = null;

/**
 * Loads the Turnstile script once per page, however many widgets mount.
 *
 * next/script was used for this before, but it dedupes a second <Script> with
 * the same src by chaining only onLoad/onError — never onReady — so when two
 * widgets mounted in one render (the login page has a magic-link form and a
 * guest button) the second one never learned the script was ready and every
 * getToken() on it timed out. A module-level promise has no such edge.
 */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(
        `script[src="${SCRIPT_SRC}"]`
      );
      const script = existing ?? document.createElement("script");
      const done = () => {
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error("Turnstile script loaded without its API"));
      };
      script.addEventListener("load", done, { once: true });
      script.addEventListener(
        "error",
        () => {
          loader = null;
          reject(new Error("Turnstile script failed to load"));
        },
        { once: true }
      );
      if (!existing) {
        script.src = SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
    });
  }
  return loader;
}

export interface TurnstileControls {
  /** Start (or restart) a challenge. Safe to call before the widget exists. */
  execute: () => void;
  /** Discard the current token so the next execute() yields a fresh one. */
  reset: () => void;
}

interface TurnstileProps {
  /** Fires with a fresh token, or null when the token expires or errors out. */
  onToken: (token: string | null) => void;
  /** Receives execute/reset once, on mount. */
  registerControls?: (controls: TurnstileControls) => void;
}

/**
 * Cloudflare Turnstile widget, rendered only when a site key is configured.
 *
 * The challenge does not run on mount. With `execution: "execute"` the widget
 * sits idle until `execute()` is called from getToken(), so a landing-page
 * visitor who never clicks costs nothing, and a page with two widgets runs at
 * most the one that was actually used. "interaction-only" keeps it invisible
 * unless Cloudflare wants something from the user.
 */
export function Turnstile({ onToken, registerControls }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  const executeRequested = useRef(false);
  const executing = useRef(false);

  // Kept in a ref so re-rendering the parent with a new closure doesn't tear
  // down and re-render the widget, which would drop a valid token.
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  const execute = useCallback(() => {
    if (executing.current) return;
    const id = widgetIdRef.current;
    if (id && window.turnstile) {
      executing.current = true;
      window.turnstile.execute(id);
    } else {
      // Script or widget not ready yet; run as soon as it is.
      executeRequested.current = true;
    }
  }, []);

  const reset = useCallback(() => {
    executing.current = false;
    executeRequested.current = false;
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
    onTokenRef.current(null);
  }, []);

  useEffect(() => {
    registerControls?.({ execute, reset });
  }, [registerControls, execute, reset]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;

    loadTurnstile()
      .then((api) => {
        const container = containerRef.current;
        if (cancelled || !container || widgetIdRef.current) return;

        const settle = (token: string | null) => {
          executing.current = false;
          onTokenRef.current(token);
        };

        widgetIdRef.current = api.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          appearance: "interaction-only",
          execution: "execute",
          callback: (token: string) => settle(token),
          "expired-callback": () => settle(null),
          "error-callback": () => settle(null),
          "timeout-callback": () => settle(null),
        });

        if (executeRequested.current) {
          executeRequested.current = false;
          execute();
        }
      })
      .catch((err: unknown) => {
        // Leave the token null; getToken() times out and reports the script
        // as blocked, which is the honest description of what happened.
        console.error("Turnstile:", err instanceof Error ? err.message : err);
      });

    return () => {
      cancelled = true;
      const id = widgetIdRef.current;
      widgetIdRef.current = null;
      executing.current = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [execute]);

  if (!TURNSTILE_SITE_KEY) return null;

  return <div ref={containerRef} className="empty:hidden" />;
}
