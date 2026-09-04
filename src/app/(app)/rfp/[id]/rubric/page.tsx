"use client";

import { useEffect, useState, use, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AppHeader, PageIntro } from "@/components/app-shell";
import {
  EmptyState,
  ErrorState,
  WorkingState,
} from "@/components/stage-state";
import { ScoreBar } from "@/components/viz/score-bar";

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

/**
 * The `rubrics.criteria` column holds the model's whole answer —
 * `{ criteria: [...], total_weight }` — while this page works on the array.
 * Accept either shape (the comparison page does the same), so a row written by
 * the generator and one written by this page's own save both load.
 */
function normalizeRubric(row: Record<string, unknown>): Rubric {
  const raw = row.criteria as
    | Criterion[]
    | { criteria?: Criterion[]; total_weight?: number }
    | null
    | undefined;
  const criteria = Array.isArray(raw) ? raw : raw?.criteria ?? [];
  const total_weight =
    (row.total_weight as number | undefined) ??
    (Array.isArray(raw) ? undefined : raw?.total_weight);
  return { ...(row as Omit<Rubric, "criteria">), criteria, total_weight };
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

/** What the model is actually doing, for the wait. */
const RUBRIC_NOTES = [
  "Reading the RFP end to end.",
  "Working out what this owner is actually buying.",
  "Drafting criteria, then weighting them against each other.",
  "Writing a description of each score level, so scoring isn't a gut feel.",
];

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
        setRubric(normalizeRubric(data));
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
      setRubric(normalizeRubric(data.rubric));
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

  /** The criterion this RFP leans on hardest — the one line worth surfacing. */
  const heaviest = useMemo(() => {
    if (!rubric?.criteria.length) return null;
    return rubric.criteria.reduce((top, c) =>
      (c.weight || 0) > (top.weight || 0) ? c : top
    );
  }, [rubric]);

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
  // Render
  // -----------------------------------------------------------------------

  const criteria = rubric?.criteria ?? [];

  return (
    <div className="min-h-screen bg-background">
      <AppHeader rfpId={id} current="rubric" />

      <main className="container mx-auto max-w-3xl px-4 py-10">
        {loading ? (
          <WorkingState
            title="Building your rubric"
            notes={RUBRIC_NOTES}
            expected="15–60 seconds"
          />
        ) : error && !rubric ? (
          <ErrorState
            message={error}
            action={
              <Button size="sm" onClick={regenerate}>
                Try again
              </Button>
            }
          />
        ) : noRubric || !rubric ? (
          <EmptyState
            title="No rubric yet"
            action={<Button onClick={regenerate}>Generate rubric</Button>}
          >
            OpenRFP will read your RFP and propose the criteria to score
            proposals against. You can change all of it.
          </EmptyState>
        ) : (
          <>
            <PageIntro
              eyebrow="Step 1 of 4"
              title="How you'll score the proposals"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={regenerate}
                  className="text-muted-foreground"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  Regenerate
                </Button>
              }
            >
              {criteria.length} criteria, drawn from your RFP.{" "}
              {heaviest && (
                <>
                  It leans hardest on{" "}
                  <span className="font-medium text-foreground">
                    {heaviest.name}
                  </span>{" "}
                  at {heaviest.weight}%.
                </>
              )}{" "}
              Open any row to change it.
            </PageIntro>

            {error && (
              <div className="mt-6">
                <ErrorState message={error} />
              </div>
            )}

            {/* --------------------------------------------------------------
             * Weight summary
             *
             * The weights are the rubric's real content — they decide the
             * ranking — so they get the top of the page as bars rather than
             * being buried as a number in each of eight open forms. Bars are
             * comparable at a glance in a way "30%… 25%… 20%" is not.
             * ----------------------------------------------------------- */}
            <div className="mt-8 flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-foreground">
                Weighting
              </h2>
              <WeightTotal sum={weightSum} valid={weightsValid} />
            </div>

            <div className="mt-3 space-y-2.5">
              {criteria.map((criterion, index) => (
                <div
                  key={criterion.id || index}
                  className="animate-reveal grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1"
                  style={{ ["--reveal-i" as string]: index }}
                >
                  <span className="truncate text-xs text-foreground">
                    {criterion.name}
                  </span>
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {criterion.weight}%
                  </span>
                  <ScoreBar
                    percent={criterion.weight}
                    index={index}
                    thickness="thin"
                    className="col-span-2"
                  />
                </div>
              ))}
            </div>

            {/* --------------------------------------------------------------
             * The criteria themselves
             *
             * Collapsed, each row is the summary a reader needs; the full
             * editor — description, weight, and one input per score level —
             * only appears when they ask for it. Every criterion open at once
             * was roughly sixty form fields on one screen.
             * ----------------------------------------------------------- */}
            <div className="mt-10 flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-foreground">
                Criteria
              </h2>
              {hasEdits && <Badge variant="secondary">Unsaved changes</Badge>}
            </div>

            <Accordion className="mt-3 gap-2.5">
              {criteria.map((criterion, index) => {
                const scores = parseScaleRange(criterion.scoring_scale);
                return (
                  <AccordionItem
                    key={criterion.id || index}
                    value={criterion.id || String(index)}
                    className="animate-reveal"
                    style={{ ["--reveal-i" as string]: index }}
                  >
                    <AccordionTrigger>
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-primary">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {criterion.name}
                        </span>
                        {criterion.description && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {criterion.description}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                        {criterion.weight}%
                      </span>
                    </AccordionTrigger>

                    <AccordionPanel>
                      <div className="space-y-4">
                        <div className="space-y-1.5">
                          <Label htmlFor={`name-${index}`}>Name</Label>
                          <Input
                            id={`name-${index}`}
                            value={criterion.name}
                            onChange={(e) =>
                              updateCriterion(index, { name: e.target.value })
                            }
                          />
                        </div>

                        <div className="space-y-1.5">
                          <Label htmlFor={`desc-${index}`}>
                            What this criterion measures
                          </Label>
                          <Textarea
                            id={`desc-${index}`}
                            value={criterion.description}
                            rows={3}
                            onChange={(e) =>
                              updateCriterion(index, {
                                description: e.target.value,
                              })
                            }
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label htmlFor={`weight-${index}`}>
                              Weight (%)
                            </Label>
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
                            <Label>Scale</Label>
                            <div className="flex h-9 items-center rounded-md bg-muted px-3 text-sm text-muted-foreground">
                              {criterion.scoring_scale}
                            </div>
                          </div>
                        </div>

                        {scores.length > 0 && (
                          <div className="space-y-2">
                            <Label className="text-sm font-medium">
                              What each score means
                            </Label>
                            <div className="space-y-2">
                              {scores.map((score) => (
                                <div
                                  key={score}
                                  className="flex items-start gap-3"
                                >
                                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold text-primary">
                                    {score}
                                  </div>
                                  <Input
                                    value={
                                      criterion.scale_descriptions?.[
                                        String(score)
                                      ] || ""
                                    }
                                    placeholder={`A ${score} looks like…`}
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

                        <div className="flex justify-end pt-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeCriterion(index)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2Icon aria-hidden="true" />
                            Remove criterion
                          </Button>
                        </div>
                      </div>
                    </AccordionPanel>
                  </AccordionItem>
                );
              })}
            </Accordion>

            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={addCriterion}>
                <PlusIcon aria-hidden="true" />
                Add criterion
              </Button>
            </div>

            {/* --------------------------------------------------------------
             * The one action, kept in reach
             *
             * A rubric runs long enough to scroll, and Accept used to sit at
             * the very bottom past every open form. Sticky means the way
             * forward — and why it is disabled — is always visible.
             * ----------------------------------------------------------- */}
            <div className="sticky bottom-0 -mx-4 mt-10 border-t border-border/70 bg-background/90 px-4 py-3 backdrop-blur-sm">
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">
                  {weightsValid
                    ? "Weights total 100%. Ready to score proposals."
                    : `Weights total ${weightSum}% — adjust to 100% to continue.`}
                </p>
                <Button
                  onClick={acceptRubric}
                  disabled={!weightsValid || saving}
                >
                  {saving ? "Saving…" : "Accept & add proposals"}
                </Button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * The weight total, as a status rather than a banner.
 *
 * It is only interesting when it is wrong, so when it is right it says so in
 * one quiet line instead of a full-width green bar.
 */
function WeightTotal({ sum, valid }: { sum: number; valid: boolean }) {
  return (
    <span
      className="flex items-center gap-1.5 text-xs font-medium"
      role={valid ? undefined : "alert"}
    >
      <span
        className="size-2 rounded-full"
        style={{
          backgroundColor: valid
            ? "var(--status-good)"
            : "var(--status-critical)",
        }}
        aria-hidden="true"
      />
      <span className={valid ? "text-muted-foreground" : "text-destructive"}>
        {valid ? "Totals 100%" : `Totals ${sum}% — should be 100%`}
      </span>
    </span>
  );
}
