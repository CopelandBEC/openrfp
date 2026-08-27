"use client";

import { useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function RubricPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNew = searchParams.get("new") === "1";

  const [rubric, setRubric] = useState<any>(null);
  const [loading, setLoading] = useState(isNew);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (isNew) {
      generateRubric();
    } else {
      fetchRubric();
    }
  }, [id]);

  const fetchRubric = async () => {
    // In a real implementation, fetch from Supabase
    // For now, just redirect to generate if no rubric
  };

  const generateRubric = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/generate-rubric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfp_id: id }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate rubric");
      }
      const data = await res.json();
      setRubric(data.rubric);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            Reading your RFP and generating evaluation criteria...
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            This usually takes 15-60 seconds
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center px-4">
        <div className="max-w-md text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            onClick={generateRubric}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!rubric) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <button
          onClick={generateRubric}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Generate Rubric
        </button>
      </div>
    );
  }

  const criteria = rubric.criteria?.criteria || rubric.criteria || [];

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

      <main className="container mx-auto max-w-3xl px-4 py-12">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Review Evaluation Rubric
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The AI generated these criteria from your RFP. Edit any criterion,
              adjust weights, then accept to proceed.
            </p>
          </div>
          <button
            onClick={generateRubric}
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            Regenerate
          </button>
        </div>

        <div className="mt-8 space-y-4">
          {criteria.map((c: any, i: number) => (
            <div key={c.id || i} className="rounded-lg border p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="font-semibold">{c.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {c.description}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      Weight: {c.weight}%
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Scale: {c.scoring_scale}
                    </span>
                  </div>
                </div>
              </div>
              {c.scale_descriptions && (
                <div className="mt-4 space-y-1">
                  {Object.entries(c.scale_descriptions).map(
                    ([score, desc]: [string, any]) => (
                      <div
                        key={score}
                        className="flex gap-3 text-xs text-muted-foreground"
                      >
                        <span className="w-8 flex-shrink-0 font-medium text-foreground">
                          {score}
                        </span>
                        <span>{desc}</span>
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="mt-8 flex justify-end gap-3">
          <button
            onClick={() => router.push(`/rfp/${id}/responses`)}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground"
          >
            Accept Rubric → Upload Responses
          </button>
        </div>
      </main>
    </div>
  );
}
