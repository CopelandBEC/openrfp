"use client";

import {
  useEffect,
  useState,
  use,
  useCallback,
  useMemo,
} from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ScoreEntry {
  score: number;
  max: number;
  rationale: string;
  evidence_quote: string;
  page_ref: string | null;
  overridden?: boolean;
}

interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoring_scale: number;
  scale_descriptions?: Record<string, string>;
}

interface Rubric {
  id: string;
  rfp_id: string;
  criteria: RubricCriterion[];
  total_weight: number;
  ai_generated: boolean;
  edited_by_user: boolean;
  locked: boolean;
  created_at: string;
}

interface Evaluation {
  id: string;
  response_id: string;
  rfp_id: string;
  scores: Record<string, ScoreEntry>;
  overall_score: number;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  model_used: string | null;
  prompt_version: string | null;
  created_at: string;
}

interface VendorResponse {
  id: string;
  rfp_id: string;
  vendor_name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recalculate the overall score from individual criterion scores and rubric
 * weights. For each criterion in the rubric, take (score / max) * weight,
 * sum them, then divide by total_weight * 100.
 */
function recalculateOverallScore(
  scores: Record<string, ScoreEntry>,
  rubric: Rubric | null
): number {
  if (!rubric || !rubric.criteria || rubric.criteria.length === 0) {
    return 0;
  }
  const totalWeight = rubric.total_weight || rubric.criteria.reduce(
    (sum, c) => sum + c.weight,
    0
  );
  if (totalWeight === 0) return 0;

  let weightedSum = 0;
  let scoredWeight = 0;
  for (const criterion of rubric.criteria) {
    const entry = scores[criterion.id];
    if (!entry || entry.max === 0) continue;
    weightedSum += (entry.score / entry.max) * criterion.weight;
    scoredWeight += criterion.weight;
  }
  if (scoredWeight === 0) return 0;
  return Number(((weightedSum / scoredWeight) * 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// Criterion Card
// ---------------------------------------------------------------------------

function CriterionCard({
  criterion,
  scoreEntry,
  evaluationId,
  onOverride,
}: {
  criterion: RubricCriterion;
  scoreEntry: ScoreEntry;
  evaluationId: string;
  onOverride: (
    evaluationId: string,
    criterionId: string,
    newScore: number
  ) => Promise<void>;
}) {
  const [overriding, setOverriding] = useState(false);
  const [overrideValue, setOverrideValue] = useState<string>(
    String(scoreEntry.score)
  );
  const [saving, setSaving] = useState(false);
  const [overrideError, setOverrideError] = useState("");

  const handleSave = useCallback(async () => {
    const parsed = parseFloat(overrideValue);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > scoreEntry.max) {
      setOverrideError(`Enter a number from 0 to ${scoreEntry.max}`);
      return;
    }
    setOverrideError("");
    setSaving(true);
    try {
      await onOverride(evaluationId, criterion.id, parsed);
      setOverriding(false);
    } catch (err) {
      setOverrideError(
        err instanceof Error ? err.message : "Failed to save override"
      );
    } finally {
      setSaving(false);
    }
  }, [overrideValue, scoreEntry.max, criterion.id, evaluationId, onOverride]);

  return (
    <Card className="border-border">
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold text-primary">
              {criterion.name}
            </CardTitle>
            {criterion.description && (
              <p className="text-sm text-muted-foreground">
                {criterion.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-primary text-primary-foreground">
              {scoreEntry.score}/{scoreEntry.max}
            </Badge>
            {scoreEntry.overridden && (
              <Badge variant="secondary">Overridden</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Rationale */}
        <div>
          <h4 className="text-sm font-semibold text-foreground">Rationale</h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {scoreEntry.rationale}
          </p>
        </div>

        {/* Evidence quote */}
        {scoreEntry.evidence_quote && (
          <blockquote className="border-l-4 border-primary/30 bg-muted/50 rounded-r-md p-3 text-sm italic text-foreground">
            &ldquo;{scoreEntry.evidence_quote}&rdquo;
            {scoreEntry.page_ref && (
              <span className="mt-1 block text-xs not-italic text-muted-foreground">
                Page {scoreEntry.page_ref}
              </span>
            )}
          </blockquote>
        )}

        <Separator />

        {/* Override controls */}
        <div className="flex items-center gap-3">
          {!overriding ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOverrideValue(String(scoreEntry.score));
                setOverriding(true);
              }}
            >
              Override Score
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={scoreEntry.max}
                step="0.5"
                value={overrideValue}
                onChange={(e) => setOverrideValue(e.target.value)}
                className="w-24"
                aria-label={`Override score for ${criterion.name}`}
              />
              <span className="text-xs text-muted-foreground">
                / {scoreEntry.max}
              </span>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOverriding(false);
                  setOverrideError("");
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
          {overrideError && (
            <p className="text-xs text-destructive">{overrideError}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function EvaluationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const supabase = useMemo(() => createClient(), []);

  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [responses, setResponses] = useState<VendorResponse[]>([]);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  // See the note in responses/page.tsx: no synchronous setState ahead of the
  // first await, since this only runs from an effect.
  const fetchEvaluations = useCallback(async () => {
    try {
      const [evalsRes, responsesRes, rubricRes] = await Promise.all([
        supabase
          .from("evaluations")
          .select(
            "id, response_id, rfp_id, scores, overall_score, summary, strengths, weaknesses, model_used, prompt_version, created_at"
          )
          .eq("rfp_id", id)
          .order("created_at", { ascending: true }),
        supabase
          .from("responses")
          .select("id, rfp_id, vendor_name")
          .eq("rfp_id", id)
          .order("created_at", { ascending: true }),
        supabase
          .from("rubrics")
          .select(
            "id, rfp_id, criteria, ai_generated, edited_by_user, locked, created_at"
          )
          .eq("rfp_id", id)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      if (evalsRes.error) throw new Error(evalsRes.error.message);
      if (responsesRes.error) throw new Error(responsesRes.error.message);
      if (rubricRes.error) throw new Error(rubricRes.error.message);

      setEvaluations(
        (evalsRes.data as Evaluation[] | null) ?? ([] as Evaluation[])
      );
      setResponses(
        (responsesRes.data as VendorResponse[] | null) ??
          ([] as VendorResponse[])
      );

      const rubricData = rubricRes.data?.[0] as
        | (Omit<Rubric, "criteria"> & {
            criteria: RubricCriterion[] | Record<string, unknown>;
          })
        | null;
      if (rubricData) {
        // criteria may be stored as { criteria: [...] } or as the array itself
        const rawCriteria = rubricData.criteria as
          | RubricCriterion[]
          | { criteria: RubricCriterion[] };
        const criteriaArray = Array.isArray(rawCriteria)
          ? rawCriteria
          : (rawCriteria as { criteria: RubricCriterion[] }).criteria ??
            [];
        setRubric({
          ...rubricData,
          criteria: criteriaArray,
        } as Rubric);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load evaluations"
      );
    } finally {
      setLoading(false);
    }
  }, [id, supabase]);

  useEffect(() => {
    // Client-side data fetch. The rule flags any effect that can transitively
    // reach setState and does not trace awaits, so it cannot tell this apart
    // from the cascading-render anti-pattern it targets. The real fix is to
    // load this data in a server component; tracked as a follow-up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEvaluations();
  }, [fetchEvaluations]);

  // -------------------------------------------------------------------------
  // Override handler
  // -------------------------------------------------------------------------

  const handleOverride = useCallback(
    async (evaluationId: string, criterionId: string, newScore: number) => {
      const evaluation = evaluations.find((e) => e.id === evaluationId);
      if (!evaluation) return;

      const updatedScores: Record<string, ScoreEntry> = {
        ...evaluation.scores,
        [criterionId]: {
          ...evaluation.scores[criterionId],
          score: newScore,
          overridden: true,
        },
      };

      const newOverall = recalculateOverallScore(updatedScores, rubric);

      const { error: updateError } = await supabase
        .from("evaluations")
        .update({ scores: updatedScores, overall_score: newOverall })
        .eq("id", evaluationId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      // Update local state
      setEvaluations((prev) =>
        prev.map((e) =>
          e.id === evaluationId
            ? { ...e, scores: updatedScores, overall_score: newOverall }
            : e
        )
      );
      setError("");
    },
    [evaluations, rubric, supabase]
  );

  // -------------------------------------------------------------------------
  // Derived helpers
  // -------------------------------------------------------------------------

  const vendorNameFor = useCallback(
    (responseId: string): string => {
      const r = responses.find((resp) => resp.id === responseId);
      return r?.vendor_name ?? "Unknown vendor";
    },
    [responses]
  );

  const hasEvaluations = evaluations.length > 0;
  const showCompareButton = evaluations.length >= 2;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link
            href="/dashboard"
            className="text-lg font-bold tracking-tight text-primary"
          >
            OpenRFP
          </Link>
          <div className="flex items-center gap-6">
            <Link
              href={`/rfp/${id}/responses`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              &larr; Responses
            </Link>
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              &larr; Back to dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-4xl px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight text-primary">
          Evaluations
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Per-response evaluations with scores and cited evidence.
        </p>

        {error && (
          <div className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="mt-12 flex flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">
              Loading evaluations...
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !hasEvaluations && (
          <div className="mt-8 rounded-lg border border-dashed border-border bg-muted p-12 text-center">
            <p className="text-sm text-muted-foreground">
              No evaluations yet. Go back and evaluate your responses first.
            </p>
            <Link
              href={`/rfp/${id}/responses`}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              &larr; Go to Responses
            </Link>
          </div>
        )}

        {/* Evaluations */}
        {!loading && hasEvaluations && (
          <div className="mt-8 space-y-6">
            <Tabs defaultValue={evaluations[0]?.id ?? ""} className="w-full">
              <TabsList className="flex w-full flex-wrap">
                {evaluations.map((evaluation) => (
                  <TabsTrigger
                    key={evaluation.id}
                    value={evaluation.id}
                    className="flex-1"
                  >
                    {vendorNameFor(evaluation.response_id)}
                  </TabsTrigger>
                ))}
              </TabsList>

              {evaluations.map((evaluation) => {
                const vendorName = vendorNameFor(evaluation.response_id);
                return (
                  <TabsContent
                    key={evaluation.id}
                    value={evaluation.id}
                    className="mt-6 space-y-6"
                  >
                    {/* Vendor header + overall score */}
                    <div className="flex items-start justify-between gap-4 rounded-lg bg-muted p-6">
                      <div className="space-y-1">
                        <h2 className="text-xl font-bold text-foreground">
                          {vendorName}
                        </h2>
                        {evaluation.summary && (
                          <p className="max-w-2xl text-sm text-muted-foreground">
                            {evaluation.summary}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <div className="text-3xl font-bold text-primary">
                          {evaluation.overall_score != null
                            ? Number(evaluation.overall_score).toFixed(1)
                            : "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Overall Score
                        </div>
                      </div>
                    </div>

                    <Separator />

                    {/* Criterion breakdown */}
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-primary">
                        Criterion Breakdown
                      </h3>
                      {rubric && rubric.criteria.length > 0 ? (
                        rubric.criteria.map((criterion) => {
                          const scoreEntry = evaluation.scores[criterion.id];
                          if (!scoreEntry) return null;
                          return (
                            <CriterionCard
                              key={criterion.id}
                              criterion={criterion}
                              scoreEntry={scoreEntry}
                              evaluationId={evaluation.id}
                              onOverride={handleOverride}
                            />
                          );
                        })
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No rubric criteria found. Define a rubric to see
                          criterion breakdowns.
                        </p>
                      )}
                    </div>

                    <Separator />

                    {/* Strengths */}
                    {evaluation.strengths &&
                      evaluation.strengths.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="text-lg font-semibold text-primary">
                            Strengths
                          </h3>
                          <ul className="list-disc space-y-1 pl-6 text-sm text-foreground">
                            {evaluation.strengths.map((strength, idx) => (
                              <li key={idx}>{strength}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                    {/* Weaknesses */}
                    {evaluation.weaknesses &&
                      evaluation.weaknesses.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="text-lg font-semibold text-primary">
                            Weaknesses
                          </h3>
                          <ul className="list-disc space-y-1 pl-6 text-sm text-foreground">
                            {evaluation.weaknesses.map((weakness, idx) => (
                              <li key={idx}>{weakness}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                    <Separator />

                    {/* Model transparency */}
                    {evaluation.model_used && (
                      <p className="text-xs text-muted-foreground">
                        Model used: {evaluation.model_used}
                        {evaluation.prompt_version
                          ? ` · Prompt v${evaluation.prompt_version}`
                          : ""}
                      </p>
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>

            {/* Compare button */}
            {showCompareButton && (
              <div className="flex justify-center pt-4">
                <Link
                  href={`/rfp/${id}/comparison`}
                  className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-8 py-2 text-base font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
                >
                  Compare All Responses &rarr;
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
