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
import {
  deriveStage,
  embeddedCount,
  firstEmbedded,
  rankedResponseIdsOf,
} from "@/lib/stage";

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

  // The counts do two jobs: the delete confirmation tells the user what goes
  // with an RFP before they agree, and the card derives which stage the
  // evaluation is actually at. `rfps.status` cannot answer the second — see
  // lib/stage.ts — so the rows are counted instead. RLS scopes every embedded
  // relation to the caller exactly as it scopes the parent.
  //
  // The ranking itself comes along so the card can tell whether the set of
  // vendors it ranks is still the set that is scored — a removed proposal
  // leaves no timestamp behind to compare.
  const { data: rfps, error: loadError } = await supabase
    .from("rfps")
    .select(
      "id, title, description, created_at, rubrics(edited_by_user, updated_at), responses(count), evaluations(response_id, updated_at, rubric_updated_at), comparisons(updated_at, ranking)"
    )
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
          {loadError ? (
            // A failed query is not an empty account. Rendering the empty
            // state here made every RFP look deleted when the query named a
            // column the database did not have yet — the schema in
            // supabase/schema.sql has to be applied before the code that
            // selects new columns from it, and this is what the owner sees
            // if it was not.
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
            >
              <h2 className="text-base font-semibold text-foreground">
                Couldn&apos;t load your RFPs
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Nothing has been deleted. Reload the page to try again; if it
                keeps happening, the message below is what the database said.
              </p>
              <p className="mt-3 break-words font-mono text-xs text-muted-foreground">
                {loadError.message}
              </p>
            </div>
          ) : rfps && rfps.length > 0 ? (
            <div className="grid gap-4">
              {rfps.map((rfp) => {
                const rubric = firstEmbedded<{
                  edited_by_user: boolean;
                  updated_at: string | null;
                }>(rfp.rubrics);
                const responseCount = embeddedCount(rfp.responses);
                // Update times, not creation times: an override edits an
                // evaluation in place and a re-rank upserts the comparison, so
                // neither creation time moves when the thing itself changes.
                const evaluations = (rfp.evaluations ?? []) as {
                  response_id: string;
                  updated_at: string;
                  rubric_updated_at: string | null;
                }[];
                const evaluatedAt = evaluations.map((e) => e.updated_at);
                const comparison = firstEmbedded<{
                  updated_at: string;
                  ranking: unknown;
                }>(rfp.comparisons);
                return (
                  <RfpCard
                    key={rfp.id}
                    rfp={{
                      id: rfp.id,
                      title: rfp.title,
                      description: rfp.description,
                      responseCount,
                      stage: deriveStage({
                        hasRubric: rubric != null,
                        rubricAccepted: rubric?.edited_by_user === true,
                        responseCount,
                        evaluations: evaluations.map((e) => ({
                          responseId: e.response_id,
                          rubricUpdatedAt: e.rubric_updated_at,
                        })),
                        rubricUpdatedAt: rubric?.updated_at ?? null,
                        comparisonAt: comparison?.updated_at ?? null,
                        latestEvaluationAt: evaluatedAt.length
                          ? evaluatedAt.reduce((a, b) => (a > b ? a : b))
                          : null,
                        rankedResponseIds: comparison
                          ? rankedResponseIdsOf(comparison.ranking)
                          : null,
                      }),
                    }}
                  />
                );
              })}
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
