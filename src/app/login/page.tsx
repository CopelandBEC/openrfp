import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MagicLinkForm } from "./magic-link-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  const { error } = await searchParams;

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

        <div className="space-y-3">
          <MagicLinkForm />
        </div>

        <div className="text-center">
          <span className="text-sm text-muted-foreground">
            New here? Use the magic link to sign up instantly — no separate
            registration needed.
          </span>
        </div>
      </div>
    </div>
  );
}
