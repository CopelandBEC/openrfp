"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  useCaptcha,
  CAPTCHA_BLOCKED_MESSAGE,
} from "@/components/use-captcha";

type State =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

export function MagicLinkForm() {
  const [state, setState] = useState<State>({ status: "idle" });
  const captcha = useCaptcha();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (
      form.elements.namedItem("email") as HTMLInputElement
    ).value.trim();

    if (!email) {
      setState({ status: "error", message: "Please enter your email address." });
      return;
    }

    setState({ status: "sending" });

    // Required whenever CAPTCHA protection is enabled on the Supabase project:
    // that switch covers the OTP endpoint too, not just anonymous sign-in.
    // Resolves immediately with a null token when Turnstile isn't configured.
    const { ok, token } = await captcha.getToken();
    if (!ok) {
      setState({ status: "error", message: CAPTCHA_BLOCKED_MESSAGE });
      return;
    }

    // Request the OTP from the browser (not a server action) so Supabase's
    // PKCE code verifier is stored in THIS browser's cookies — the same
    // browser that will open the emailed link. Server-side requests leave
    // the verifier where the click can't reach it ("PKCE code verifier not
    // found" on exchange).
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        captchaToken: token ?? undefined,
      },
    });

    if (error) {
      // The token is single-use — a retry needs a fresh one.
      captcha.reset();
      setState({
        status: "error",
        message:
          error.status === 429
            ? "Too many attempts — please wait a few minutes before trying again."
            : "Couldn't send the magic link. Please try again.",
      });
      return;
    }

    setState({ status: "sent", email });
  }

  if (state.status === "sent") {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4 text-center">
        <p className="text-sm font-medium text-foreground">Check your email</p>
        <p className="mt-1 text-sm text-muted-foreground">
          We sent a sign-in link to{" "}
          <span className="font-medium text-foreground">{state.email}</span>.
          Click the link in that email to sign in — be sure to open it in this
          same browser.
        </p>
        <button
          type="button"
          onClick={() => setState({ status: "idle" })}
          className="mt-3 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Use a different email
        </button>
      </div>
    );
  }

  const isPending = state.status === "sending";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="magic-email" className="text-sm font-medium">
          Sign in with a magic link
        </label>
        <input
          id="magic-email"
          name="email"
          type="email"
          required
          disabled={isPending}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="you@institution.org"
        />
      </div>

      {captcha.render}

      {state.status === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Sending link…" : "Send magic link"}
      </button>
    </form>
  );
}
