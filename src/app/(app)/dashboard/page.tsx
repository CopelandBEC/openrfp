import { redirect } from "next/navigation";
import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/sign-out-button";
import { RfpCard } from "@/components/rfp-card";
import { AppHeader } from "@/components/app-shell";
import { EmptyState } from "@/components/stage-state";
import { Button } from "@/components/ui/button";
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

  // The response count feeds the delete confirmation, so the user is told what
  // goes with the RFP before agreeing.
  const { data: rfps } = await supabase
    .from("rfps")
    .select("id, title, description, status, created_at, responses(count)")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-background">
      <AppHeader
        label="Dashboard"
        action={
          <SignOutButton
            isGuest={guest}
            action={async () => {
              "use server";
              const supabase = await createClient();
              await supabase.auth.signOut();
              redirect("/login");
            }}
          />
        }
      />

      <main className="container mx-auto max-w-3xl px-4 py-10">
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

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Your RFPs
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {rfps?.length
                ? "Pick up where you left off — each card shows what comes next."
                : "Upload an RFP and OpenRFP will build the rubric to score against."}
            </p>
          </div>
          <Button size="lg" render={<Link href="/rfp/new" />}>
            <PlusIcon aria-hidden="true" />
            New evaluation
          </Button>
        </div>

        <div className="mt-8">
          {rfps && rfps.length > 0 ? (
            <div className="grid gap-4">
              {rfps.map((rfp) => (
                <RfpCard
                  key={rfp.id}
                  rfp={{
                    id: rfp.id,
                    title: rfp.title,
                    description: rfp.description,
                    status: rfp.status,
                    responseCount:
                      (rfp.responses as unknown as { count: number }[] | null)?.[0]
                        ?.count ?? 0,
                  }}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="Nothing here yet"
              action={
                <Button render={<Link href="/rfp/new" />}>
                  <PlusIcon aria-hidden="true" />
                  Start an evaluation
                </Button>
              }
            >
              Upload an RFP, accept or edit the rubric it proposes, then drop in
              the vendor proposals. You get scores with the passage behind each
              one quoted.
            </EmptyState>
          )}
        </div>
      </main>
    </div>
  );
}
