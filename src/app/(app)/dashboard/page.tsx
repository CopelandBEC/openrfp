import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/sign-out-button";
import { isGuest } from "@/lib/auth/guest";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  // Auth is enforced by the (app) layout; RLS scopes this query to the caller.
  const supabase = await createClient();

  const { saved } = await searchParams;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const guest = isGuest(user);

  const { data: rfps } = await supabase
    .from("rfps")
    .select("id, title, description, status, created_at")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <span className="text-lg font-bold tracking-tight">OpenRFP</span>
            <span className="text-sm text-muted-foreground">
              Dashboard
            </span>
          </div>
          <SignOutButton
            isGuest={guest}
            action={async () => {
              "use server";
              const supabase = await createClient();
              await supabase.auth.signOut();
              redirect("/login");
            }}
          />
        </div>
      </header>

      <main className="container mx-auto px-4 py-12">
        {saved === "1" && !guest && (
          <p
            className="mb-8 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-foreground"
            role="status"
          >
            <span className="font-medium">Your work is saved.</span>{" "}
            <span className="text-muted-foreground">
              Everything you evaluated as a guest is now on this account — sign
              in with the same email any time to pick it back up.
            </span>
          </p>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Your RFPs
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your RFP evaluations
            </p>
          </div>
          <a
            href="/rfp/new"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90"
          >
            New RFP Evaluation
          </a>
        </div>

        <div className="mt-8">
          {rfps && rfps.length > 0 ? (
            <div className="grid gap-4">
              {rfps.map((rfp) => (
                <a
                  key={rfp.id}
                  href={`/rfp/${rfp.id}/rubric`}
                  className="block rounded-lg border p-4 transition-colors hover:bg-muted/30"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-semibold">{rfp.title}</h2>
                    <span className="text-xs uppercase text-muted-foreground">
                      {rfp.status}
                    </span>
                  </div>
                  {rfp.description && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {rfp.description}
                    </p>
                  )}
                </a>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No RFPs yet. Click &quot;New RFP Evaluation&quot; to get
                started.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
