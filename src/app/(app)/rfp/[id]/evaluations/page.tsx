"use client";

import { use } from "react";

export default function EvaluationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <a href="/dashboard" className="text-lg font-bold tracking-tight">
            OpenRFP
          </a>
          <a
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to dashboard
          </a>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight">Evaluations</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Per-response evaluations with scores and cited evidence.
        </p>

        <div className="mt-8 rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">
            Evaluations will appear here after responses are processed.
          </p>
          <a
            href={`/rfp/${id}/comparison`}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
          >
            View Comparison →
          </a>
        </div>
      </main>
    </div>
  );
}
