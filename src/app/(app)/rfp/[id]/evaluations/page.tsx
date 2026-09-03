"use client";

import { useEffect, useState, use, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  ArrowRightIcon,
  MinusIcon,
  PlusIcon,
  QuoteIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AppHeader, PageIntro } from "@/components/app-shell";
import { EmptyState, ErrorState, WorkingState } from "@/components/stage-state";
import { ScoreMeter } from "@/components/viz/score-meter";
import { ScoreBar } from "@/components/viz/score-bar";
import { TierChip } from "@/components/viz/tier-chip";
import { formatScore, scoreTier, toPercent } from "@/lib/score";
import { scoredAgainstCurrentRubric } from "@/lib/stage";

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
  /** When the criteria last changed. */
  updated_at?: string | null;
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
  /** Last written: a re-score or an override. Re-scoring upserts the row. */
  updated_at?: string | null;
  /** The rubric these scores were made against; see lib/stage.ts. */
  rubric_updated_at?: string | null;
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
// Clamped prose
// ---------------------------------------------------------------------------

/**
 * A paragraph that shows its opening and hides the rest.
 *
 * The model's summaries run long. Three lines is enough to know whether the
 * rest is worth reading, which is the whole point of a summary — and the full
 * text is one press away, never lost.
 */
function ClampText({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  // Roughly the point at which clamping actually hides something; below it the
  // toggle would be a control that does nothing.
  const clampable = text.length > 220;

  const clamped = clampable && !open;

  return (
    <div>
      {/* The clamp is an inline style rather than a utility class because the
          line count is a prop, and Tailwind only emits classes it can see. */}
      <p
        className="text-sm leading-relaxed text-foreground"
        style={
          clamped
            ? {
                display: "-webkit-box",
                WebkitLineClamp: lines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
            : undefined
        }
      >
        {text}
      </p>
      {clampable && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1.5 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          {open ? "Show less" : "Read the full summary"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Strengths / weaknesses
// ---------------------------------------------------------------------------

/**
 * A findings list, showing the first few and folding the tail away.
 *
 * The model routinely returns six or eight of each, and eight bullets under
 * "Weaknesses" reads as noise rather than as eight findings. The first three
 * are the ones a reader acts on.
 */
function FindingList({
  items,
  tone,
  label,
  limit = 3,
}: {
  items: string[];
  tone: "good" | "critical";
  label: string;
  limit?: number;
}) {
  if (!items?.length) return null;
  const visible = items.slice(0, limit);
  const rest = items.slice(limit);
  const Icon = tone === "good" ? PlusIcon : MinusIcon;
  const dot =
    tone === "good" ? "var(--status-good)" : "var(--status-critical)";

  const row = (text: string, index: number) => (
    <li key={index} className="flex gap-2">
      <Icon
        className="mt-0.5 size-3.5 shrink-0"
        style={{ color: dot }}
        aria-hidden="true"
      />
      <span className="text-sm leading-snug text-foreground">{text}</span>
    </li>
  );

  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      <ul className="mt-2 space-y-1.5">{visible.map(row)}</ul>
      {rest.length > 0 && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger>
            {rest.length} more
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="space-y-1.5 pt-1.5">
              {rest.map((text, i) => row(text, i + limit))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criterion row
// ---------------------------------------------------------------------------

/**
 * One criterion, collapsed to a score and a bar.
 *
 * Everything that used to be on screen at once — the description, the
 * reasoning, the quoted evidence, the override form — is still here, behind
 * the row. Eight criteria across four vendors was previously about two
 * thousand words of prose with no way to skim it.
 */
function CriterionRow({
  criterion,
  scoreEntry,
  evaluationId,
  index,
  onOverride,
}: {
  criterion: RubricCriterion;
  scoreEntry: ScoreEntry;
  evaluationId: string;
  index: number;
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

  const percent = toPercent(scoreEntry.score, scoreEntry.max);
  const tier = scoreTier(percent);

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
    <AccordionItem
      value={criterion.id}
      className="animate-reveal"
      style={{ ["--reveal-i" as string]: index }}
    >
      <AccordionTrigger>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {criterion.name}
            </span>
            {scoreEntry.overridden && (
              <Badge variant="secondary" className="shrink-0">
                Yours
              </Badge>
            )}
          </span>
          <span className="mt-1.5 flex items-center gap-2">
            <ScoreBar
              percent={percent}
              index={index}
              thickness="thin"
              className="max-w-40"
            />
            <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
              {formatScore(scoreEntry.score)}
              <span className="font-normal text-muted-foreground">
                /{scoreEntry.max}
              </span>
            </span>
          </span>
        </span>
        <TierChip tier={tier} size="sm" className="shrink-0" />
      </AccordionTrigger>

      <AccordionPanel>
        <div className="space-y-4">
          {criterion.description && (
            <p className="text-xs text-muted-foreground">
              {criterion.description}
            </p>
          )}

          <div>
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Why this score
            </h4>
            <p className="mt-1.5 text-sm leading-relaxed text-foreground">
              {scoreEntry.rationale}
            </p>
          </div>

          {scoreEntry.evidence_quote && (
            <figure className="rounded-lg bg-muted/60 p-3">
              <QuoteIcon
                className="size-3.5 text-primary"
                aria-hidden="true"
              />
              <blockquote className="mt-1.5 text-sm leading-relaxed text-foreground italic">
                {scoreEntry.evidence_quote}
              </blockquote>
              {scoreEntry.page_ref && (
                <figcaption className="mt-2 text-xs text-muted-foreground">
                  Page {scoreEntry.page_ref} of the proposal
                </figcaption>
              )}
            </figure>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {!overriding ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOverrideValue(String(scoreEntry.score));
                  setOverriding(true);
                }}
              >
                <SlidersHorizontalIcon aria-hidden="true" />
                Change this score
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={scoreEntry.max}
                  step="0.5"
                  value={overrideValue}
                  onChange={(e) => setOverrideValue(e.target.value)}
                  className="w-20"
                  aria-label={`Override score for ${criterion.name}`}
                />
                <span className="text-xs text-muted-foreground">
                  / {scoreEntry.max}
                </span>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
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
        </div>
      </AccordionPanel>
    </AccordionItem>
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
            "id, response_id, rfp_id, scores, overall_score, summary, strengths, weaknesses, model_used, prompt_version, created_at, updated_at, rubric_updated_at"
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
            "id, rfp_id, criteria, ai_generated, edited_by_user, locked, created_at, updated_at"
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

  // Memoised because `weakSpotsFor` closes over it: a fresh [] each render
  // would rebuild that callback on every keystroke in an override field.
  const criteria = useMemo(() => rubric?.criteria ?? [], [rubric]);

  /**
   * Vendors whose scores were made against an earlier rubric. Those scores
   * and the quotes behind them describe criteria that may no longer exist,
   * so the page says so before showing them.
   */
  const scoredAgainstOldRubric = useMemo(() => {
    const nameFor = new Map(responses.map((r) => [r.id, r.vendor_name]));
    return evaluations
      .filter(
        (ev) =>
          !scoredAgainstCurrentRubric(ev.rubric_updated_at, rubric?.updated_at)
      )
      .map((ev) => nameFor.get(ev.response_id) ?? "Unknown vendor");
  }, [evaluations, responses, rubric]);
  const hasEvaluations = evaluations.length > 0;
  const showCompareButton = evaluations.length >= 2;

  /**
   * The criteria where a proposal is thin, per evaluation.
   *
   * This is the answer to the question a reader opens the page with — "where
   * is the risk?" — and it was previously only reachable by reading every
   * criterion's prose in turn.
   */
  const weakSpotsFor = useCallback(
    (evaluation: Evaluation) =>
      criteria.filter((c) => {
        const entry = evaluation.scores?.[c.id];
        if (!entry) return false;
        return scoreTier(toPercent(entry.score, entry.max)) === "weak";
      }),
    [criteria]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <AppHeader rfpId={id} current="evaluations" />

      <main className="container mx-auto max-w-4xl px-4 py-10">
        {loading ? (
          <WorkingState
            title="Loading evaluations"
            notes={["Fetching the scores and the evidence behind them."]}
          />
        ) : error && !hasEvaluations ? (
          <ErrorState message={error} />
        ) : !hasEvaluations ? (
          <EmptyState
            title="Nothing scored yet"
            action={
              <Button render={<Link href={`/rfp/${id}/responses`} />}>
                Go to proposals
              </Button>
            }
          >
            Upload the vendor proposals and run the evaluation — the scores and
            the quotes behind them land here.
          </EmptyState>
        ) : (
          <>
            <PageIntro eyebrow="Step 3 of 4" title="How each proposal scored">
              Every score cites the passage it came from, and you can change any
              of them.
            </PageIntro>

            {error && (
              <div className="mt-6">
                <ErrorState message={error} />
              </div>
            )}

            {scoredAgainstOldRubric.length > 0 && (
              <div
                role="note"
                className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3"
              >
                <p className="flex items-start gap-2 text-sm text-foreground">
                  <TriangleAlertIcon
                    className="mt-0.5 size-4 shrink-0"
                    style={{ color: "var(--status-warning)" }}
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium">
                      The rubric changed after scoring.
                    </span>{" "}
                    {scoredAgainstOldRubric.join(", ")}{" "}
                    {scoredAgainstOldRubric.length === 1 ? "was" : "were"} scored
                    against earlier criteria, so the scores and quotes below may
                    not line up with the rubric as it is now.
                  </span>
                </p>
                <Button
                  size="sm"
                  render={<Link href={`/rfp/${id}/responses`} />}
                >
                  Re-score proposals
                </Button>
              </div>
            )}

            <Tabs
              defaultValue={evaluations[0]?.id ?? ""}
              className="mt-8 w-full"
            >
              {/* Each tab carries its own score, so the comparison starts in
                  the tab bar rather than requiring four clicks. */}
              <TabsList className="flex h-auto w-full flex-wrap gap-1 p-1">
                {evaluations.map((evaluation) => (
                  <TabsTrigger
                    key={evaluation.id}
                    value={evaluation.id}
                    className="h-auto flex-1 flex-col items-start gap-0.5 px-2.5 py-1.5"
                  >
                    <span className="max-w-full truncate text-xs font-medium">
                      {vendorNameFor(evaluation.response_id)}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatScore(evaluation.overall_score)}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {evaluations.map((evaluation) => {
                const vendorName = vendorNameFor(evaluation.response_id);
                const weakSpots = weakSpotsFor(evaluation);

                return (
                  <TabsContent
                    key={evaluation.id}
                    value={evaluation.id}
                    className="mt-6 space-y-6"
                  >
                    {/* ----------------------------------------------------
                     * The verdict
                     *
                     * Score, summary and where the risk is, above the fold
                     * and in that order. Everything else on the page is
                     * supporting detail for this card.
                     * ------------------------------------------------- */}
                    <section className="animate-reveal rounded-xl bg-card p-6 ring-1 ring-foreground/10">
                      <div className="flex flex-wrap items-start justify-between gap-6">
                        <div className="min-w-0">
                          <h2 className="text-xl font-bold text-foreground">
                            {vendorName}
                          </h2>
                          {evaluation.summary && (
                            <div className="mt-2 max-w-xl">
                              <ClampText text={evaluation.summary} />
                            </div>
                          )}
                        </div>
                        <ScoreMeter
                          value={evaluation.overall_score}
                          label="Weighted across all criteria"
                          className="w-52 shrink-0"
                        />
                      </div>

                      {weakSpots.length > 0 && (
                        <p className="mt-5 border-t border-border/60 pt-4 text-sm text-foreground">
                          <span className="font-medium">Watch out:</span>{" "}
                          thin on{" "}
                          {weakSpots.map((c, i) => (
                            <span key={c.id}>
                              {i > 0 && (i === weakSpots.length - 1 ? " and " : ", ")}
                              <span className="font-medium">{c.name}</span>
                            </span>
                          ))}
                          .
                        </p>
                      )}
                    </section>

                    {/* Strengths and weaknesses, side by side and folded. */}
                    {((evaluation.strengths?.length ?? 0) > 0 ||
                      (evaluation.weaknesses?.length ?? 0) > 0) && (
                      <section className="grid gap-6 sm:grid-cols-2">
                        <FindingList
                          items={evaluation.strengths ?? []}
                          tone="good"
                          label="Strengths"
                        />
                        <FindingList
                          items={evaluation.weaknesses ?? []}
                          tone="critical"
                          label="Weaknesses"
                        />
                      </section>
                    )}

                    {/* Criterion by criterion. */}
                    <section>
                      <h3 className="text-sm font-semibold text-foreground">
                        Criterion by criterion
                      </h3>
                      {criteria.length > 0 ? (
                        <Accordion className="mt-3 gap-2.5">
                          {criteria.map((criterion, index) => {
                            const scoreEntry = evaluation.scores[criterion.id];
                            if (!scoreEntry) return null;
                            return (
                              <CriterionRow
                                key={criterion.id}
                                criterion={criterion}
                                scoreEntry={scoreEntry}
                                evaluationId={evaluation.id}
                                index={index}
                                onOverride={handleOverride}
                              />
                            );
                          })}
                        </Accordion>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          No rubric criteria found, so there is nothing to break
                          the score down against.
                        </p>
                      )}
                    </section>

                    {/* Provenance, available but not in the way. */}
                    {evaluation.model_used && (
                      <Collapsible>
                        <CollapsibleTrigger>
                          How this was produced
                        </CollapsibleTrigger>
                        <CollapsiblePanel>
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
                            <dt>Model</dt>
                            <dd className="text-foreground">
                              {evaluation.model_used}
                            </dd>
                            {evaluation.prompt_version && (
                              <>
                                <dt>Prompt</dt>
                                <dd className="text-foreground">
                                  v{evaluation.prompt_version}
                                </dd>
                              </>
                            )}
                            {/* Re-scoring upserts the row, so `created_at`
                                is the first score's time for ever; the update
                                time is when these numbers were last written,
                                by the model or by hand. */}
                            <dt>Last scored or edited</dt>
                            <dd className="text-foreground">
                              {new Date(
                                evaluation.updated_at ?? evaluation.created_at
                              ).toLocaleString()}
                            </dd>
                          </dl>
                        </CollapsiblePanel>
                      </Collapsible>
                    )}
                  </TabsContent>
                );
              })}
            </Tabs>

            {showCompareButton && (
              <div className="sticky bottom-0 -mx-4 mt-10 border-t border-border/70 bg-background/90 px-4 py-3 backdrop-blur-sm">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-xs text-muted-foreground">
                    {evaluations.length} proposals scored.
                  </p>
                  <Button
                    render={<Link href={`/rfp/${id}/comparison`} />}
                    size="lg"
                  >
                    See the decision
                    <ArrowRightIcon aria-hidden="true" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
