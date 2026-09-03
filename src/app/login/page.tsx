import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MagicLinkForm } from "./magic-link-form";
import { GuestStartButton } from "@/components/guest-start-button";
import { isGuest } from "@/lib/auth/guest";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Guests hold a session too, so a bare `if (user)` would bounce one straight
  // back to the dashboard and leave them no way to reach the sign-in form —
  // which is exactly what someone with an existing account needs when they
  // started as a guest by mistake.
  if (user && !isGuest(user)) {
    redirect("/dashboard");
  }

  const { error } = await searchParams;
  const guest = isGuest(user);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">OpenRFP</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to evaluate RFP responses
          </p>
        </div>

        {error === "auth" && (
          <p
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-center text-sm text-destructive"
            role="alert"
          >
            That sign-in link didn&apos;t work — it may have expired. Request a
            new one below.
          </p>
        )}

        {guest && (
          <p
            className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground"
            role="status"
          >
            You have a guest evaluation in progress. Signing in here opens an
            existing account instead — the guest work won&apos;t carry over, and
            no new account is created. To keep it, go back and use{" "}
            <span className="font-medium text-foreground">
              Save to an account
            </span>
            .
          </p>
        )}

        <div className="space-y-3">
          <MagicLinkForm guest={guest} />
        </div>

        {!guest && (
          <>
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <div className="flex flex-col items-center gap-2">
              <GuestStartButton
                size="default"
                variant="outline"
                className="w-full"
                buttonClassName="w-full"
              >
                Continue without an account
              </GuestStartButton>
              <p className="text-center text-xs text-muted-foreground">
                Run a full evaluation now and decide later. You can add an email
                at any point to save it.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
