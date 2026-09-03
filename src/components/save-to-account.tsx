"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type State =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

/**
 * Turns the current guest session into a permanent account.
 *
 * `updateUser({ email })` attaches an email to the anonymous user that is
 * already signed in, which means the user id never changes — every RFP,
 * response and evaluation they just created stays theirs with nothing copied
 * or migrated. Supabase emails a confirmation link; clicking it clears
 * `is_anonymous` and the account is a normal one from then on.
 *
 * Called from the browser, like the magic-link form, so the PKCE code verifier
 * is stored in the same browser that will open the link.
 */
export function SaveToAccountForm({
  next = "/dashboard?saved=1",
}: {
  next?: string;
}) {
  const [state, setState] = useState<State>({ status: "idle" });

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

    setState({ status: "saving" });

    const redirectTo = new URL("/auth/callback", window.location.origin);
    redirectTo.searchParams.set("next", next);

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser(
      { email },
      { emailRedirectTo: redirectTo.toString() }
    );

    if (error) {
      // GoTrue returns 422 for several unrelated conditions (a validation
      // failure, anonymous conversion disabled, ...), so the status alone must
      // not be read as "taken" — that message sends a guest off to abandon
      // their work over what may have been a typo. The error code is exact.
      const alreadyRegistered =
        error.code === "email_exists" || /already/i.test(error.message);

      setState({
        status: "error",
        message: alreadyRegistered
          ? "That email already has an account. Sign in to it from the link below — note that this guest work won't carry over."
          : error.status === 429
            ? "Too many attempts — please wait a few minutes before trying again."
            : error.status === 422
              ? "That email address couldn't be used. Check it and try again."
              : "Couldn't send the confirmation email. Please try again.",
      });
      return;
    }

    setState({ status: "sent", email });
  }

  if (state.status === "sent") {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <p className="text-sm font-medium text-foreground">
          Confirm your email to finish saving
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          We sent a link to{" "}
          <span className="font-medium text-foreground">{state.email}</span>.
          Open it in this same browser and your work is saved to the account.
          Until then, keep this tab open.
        </p>
      </div>
    );
  }

  const isPending = state.status === "saving";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="email"
          type="email"
          required
          disabled={isPending}
          aria-label="Email address"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="you@institution.org"
        />
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? "Sending…" : "Save my work"}
        </button>
      </div>

      {state.status === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
