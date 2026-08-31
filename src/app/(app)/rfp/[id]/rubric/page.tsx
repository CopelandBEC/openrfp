"use client";

import { useEffect, useState, use, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScaleDescriptions {
  [score: string]: string;
}

interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoring_scale: string;
  scale_descriptions: ScaleDescriptions;
}

interface Rubric {
  id?: string;
  rfp_id?: string;
  criteria: Criterion[];
  total_weight?: number;
  ai_generated?: boolean;
  edited_by_user?: boolean;
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a scoring scale like "1-5" into an array of score numbers [1,2,3,4,5] */
function parseScaleRange(scale: string): number[] {
  const match = scale.match(/^(\d+)-(\d+)$/);
  if (!match) return [];
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/** Build a fresh criterion with empty scale descriptions for a 1-5 scale */
function makeBlankCriterion(): Criterion {
  return {
    id: `criterion_${crypto.randomUUID()}`,
    name: "New Criterion",
    description: "",
    weight: 0,
    scoring_scale: "1-5",
    scale_descriptions: {},
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RubricPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNew = searchParams.get("new") === "1";

  const supabase = useMemo(() => createClient(), []);

  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [noRubric, setNoRubric] = useState(false);
  const [hasEdits, setHasEdits] = useState(false);
  const [saving, setSaving] = useState(false);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  // No synchronous setState ahead of the first await — these run from an
  // effect on mount, where the state already starts in the right shape. The
  // user-initiated path resets explicitly via regenerate() below.
  const fetchRubric = useCallback(async () => {
    try {
      const { data, error: queryError } = await supabase
        .from("rubrics")
        .select("*")
        .eq("rfp_id", id)
        .single();

      if (queryError) {
        if (queryError.code === "PGRST116") {
          // no rows — no rubric yet
          setNoRubric(true);
          setRubric(null);
        } else {
          throw new Error(queryError.message);
        }
      } else if (data) {
        setRubric(data as Rubric);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rubric");
    } finally {
      setLoading(false);
    }
  }, [id, supabase]);

  const generateRubric = useCallback(async () => {
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
      const generated: Rubric = data.rubric;
      setRubric(generated);
      setHasEdits(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (isNew) {
      // See the note on the sibling pages: client-side fetch, and the rule
      // does not trace awaits.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      generateRubric();
    } else {
      fetchRubric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** User-initiated (re)generation: reset the view before kicking off the call. */
  const regenerate = useCallback(() => {
    setLoading(true);
    setError("");
    setNoRubric(false);
    void generateRubric();
  }, [generateRubric]);

  // -----------------------------------------------------------------------
  // Editing helpers
  // -----------------------------------------------------------------------

  const markEdited = () => {
    setHasEdits(true);
  };

  const updateCriterion = (index: number, patch: Partial<Criterion>) => {
    setRubric((prev) => {
      if (!prev) return prev;
      const nextCriteria = [...prev.criteria];
      nextCriteria[index] = { ...nextCriteria[index], ...patch };
      return { ...prev, criteria: nextCriteria };
    });
    markEdited();
  };

  const updateScaleDescription = (
    index: number,
    score: string,
    desc: string,
  ) => {
    setRubric((prev) => {
      if (!prev) return prev;
      const nextCriteria = [...prev.criteria];
      const criterion = { ...nextCriteria[index] };
      criterion.scale_descriptions = {
        ...criterion.scale_descriptions,
        [score]: desc,
      };
      nextCriteria[index] = criterion;
      return { ...prev, criteria: nextCriteria };
    });
    markEdited();
  };

  const removeCriterion = (index: number) => {
    setRubric((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        criteria: prev.criteria.filter((_, i) => i !== index),
      };
    });
    markEdited();
  };

  const addCriterion = () => {
    setRubric((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        criteria: [...prev.criteria, makeBlankCriterion()],
      };
    });
    markEdited();
  };

  // -----------------------------------------------------------------------
  // Weight validation
  // -----------------------------------------------------------------------

  const weightSum = rubric
    ? rubric.criteria.reduce((sum, c) => sum + (c.weight || 0), 0)
    : 0;
  const weightsValid = Math.abs(weightSum - 100) < 0.01;

  // -----------------------------------------------------------------------
  // Save
  // -----------------------------------------------------------------------

  const acceptRubric = async () => {
    if (!rubric || !weightsValid) return;
    setSaving(true);
    setError("");
    try {
      const criteriaPayload = {
        criteria: rubric.criteria,
        total_weight: weightSum,
      };

      const { error: saveError } = await supabase
        .from("rubrics")
        .upsert(
          {
            rfp_id: id,
            criteria: criteriaPayload,
            edited_by_user: true,
          },
          { onConflict: "rfp_id" }
        );

      if (saveError) {
        throw new Error(saveError.message);
      }

      setHasEdits(false);
      router.push(`/rfp/${id}/responses`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save rubric");
    } finally {
      setSaving(false);
    }
  };

  // -----------------------------------------------------------------------
  // Render: loading
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background">
        <header className="absolute top-0 w-full border-b">
          <div className="container mx-auto flex h-16 items-center justify-between px-4">
            <a
              href="/dashboard"
              className="text-lg font-bold tracking-tight text-primary"
            >
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
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">
            Reading your RFP and generating evaluation criteria…
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            This usually takes 15–60 seconds
          </p>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: error
  // -----------------------------------------------------------------------

  if (error) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="border-b">
          <div className="container mx-auto flex h-16 items-center justify-between px-4">
            <a
              href="/dashboard"
              className="text-lg font-bold tracking-tight text-primary"
            >
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
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="max-w-md text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button onClick={regenerate} className="mt-4">
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: no rubric — show generate button
  // -----------------------------------------------------------------------

  if (noRubric && !rubric) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="border-b">
          <div className="container mx-auto flex h-16 items-center justify-between px-4">
            <a
              href="/dashboard"
              className="text-lg font-bold tracking-tight text-primary"
            >
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
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div className="max-w-md text-center">
            <h2 className="text-xl font-semibold text-foreground">
              No rubric yet
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Generate an evaluation rubric from your RFP document.
            </p>
            <Button onClick={regenerate} className="mt-6">
              Generate Rubric
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: rubric loaded but empty (safety)
  // -----------------------------------------------------------------------

  if (!rubric) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <header className="border-b">
          <div className="container mx-auto flex h-16 items-center justify-between px-4">
            <a
              href="/dashboard"
              className="text-lg font-bold tracking-tight text-primary"
            >
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
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <Button onClick={regenerate}>Generate Rubric</Button>
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render: main editor
  // -----------------------------------------------------------------------

  const criteria = rubric.criteria || [];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <a
            href="/dashboard"
            className="text-lg font-bold tracking-tight text-primary"
          >
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
        {/* Title row */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Review Evaluation Rubric
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The AI generated these criteria from your RFP. Edit any criterion,
              adjust weights, then accept to proceed.
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={regenerate}
            className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground"
          >
            Regenerate
          </Button>
        </div>

        {/* Weight validation banner */}
        <div
          className={`mt-6 flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
            weightsValid
              ? "bg-muted text-primary"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          {weightsValid ? (
            <span className="font-medium text-primary">
              ✓ Weights sum to 100%
            </span>
          ) : (
            <span className="font-medium">
              ⚠ Weights sum to {weightSum}%, should be 100%
            </span>
          )}
        </div>

        {/* Unsaved changes indicator */}
        {hasEdits && (
          <div className="mt-3">
            <Badge variant="secondary">Unsaved changes</Badge>
          </div>
        )}

        {/* Criteria cards */}
        <div className="mt-8 space-y-4">
          {criteria.map((criterion, index) => {
            const scores = parseScaleRange(criterion.scoring_scale);
            return (
              <Card key={criterion.id || index}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg text-primary">
                      Criterion {index + 1}
                    </CardTitle>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeCriterion(index)}
                      className="text-xs text-destructive hover:text-destructive"
                    >
                      Remove
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Name */}
                  <div className="space-y-1.5">
                    <Label htmlFor={`name-${index}`}>Criterion Name</Label>
                    <Input
                      id={`name-${index}`}
                      value={criterion.name}
                      onChange={(e) =>
                        updateCriterion(index, { name: e.target.value })
                      }
                    />
                  </div>

                  {/* Description */}
                  <div className="space-y-1.5">
                    <Label htmlFor={`desc-${index}`}>Description</Label>
                    <Textarea
                      id={`desc-${index}`}
                      value={criterion.description}
                      rows={3}
                      onChange={(e) =>
                        updateCriterion(index, { description: e.target.value })
                      }
                    />
                  </div>

                  {/* Weight + Scale */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor={`weight-${index}`}>Weight (%)</Label>
                      <Input
                        id={`weight-${index}`}
                        type="number"
                        min={0}
                        max={100}
                        value={criterion.weight}
                        onChange={(e) =>
                          updateCriterion(index, {
                            weight:
                              e.target.value === ""
                                ? 0
                                : Math.max(
                                    0,
                                    Math.min(100, Number(e.target.value)),
                                  ),
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Scoring Scale</Label>
                      <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
                        {criterion.scoring_scale}
                      </div>
                    </div>
                  </div>

                  {/* Scale descriptions */}
                  {scores.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-sm font-medium">
                        Scale Descriptions
                      </Label>
                      <div className="space-y-2">
                        {scores.map((score) => (
                          <div key={score} className="flex items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-primary">
                              {score}
                            </div>
                            <Input
                              value={criterion.scale_descriptions?.[String(score)] || ""}
                              placeholder={`Description for score ${score}`}
                              onChange={(e) =>
                                updateScaleDescription(
                                  index,
                                  String(score),
                                  e.target.value,
                                )
                              }
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Add criterion + accept row */}
        <div className="mt-8 flex items-center justify-between">
          <Button variant="outline" onClick={addCriterion}>
            + Add Criterion
          </Button>
          <div className="flex items-center gap-3">
            {saving && (
              <span className="text-sm text-muted-foreground">Saving…</span>
            )}
            <Button
              onClick={acceptRubric}
              disabled={!weightsValid || saving}
              className={weightsValid ? "" : "cursor-not-allowed opacity-50"}
            >
              {saving ? "Saving…" : "Accept Rubric →"}
            </Button>
          </div>
        </div>

        {/* Helpful hint when weights are invalid */}
        {!weightsValid && (
          <p className="mt-3 text-right text-xs text-muted-foreground">
            Adjust criterion weights so they total 100% to enable Accept.
          </p>
        )}
      </main>
    </div>
  );
}
