"use client";

import { use, useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  DownloadIcon,
  FileJsonIcon,
  RotateCcwIcon,
  SheetIcon,
  TrophyIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
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
import { AppHeader, PageIntro } from "@/components/app-shell";
import { EmptyState, ErrorState, WorkingState } from "@/components/stage-state";
import { ScoreMeter } from "@/components/viz/score-meter";
import { ScoreBar } from "@/components/viz/score-bar";
import { TierChip } from "@/components/viz/tier-chip";
import { ScoreGrid } from "@/components/viz/score-grid";
import { formatScore, scoreTier, toPercent } from "@/lib/score";
import {
  exportCsv,
  exportJson,
  exportReport,
  type ReportData,
  type ReportVendor,
} from "@/lib/export/report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RankingEntry {
  response_id: string;
  vendor_name: string;
  rank: number;
  overall_score: number;
  rationale: string;
}

interface CloseCallResponse {
  response_id: string;
  vendor_name: string;
  score: number;
}

interface CloseCall {
  criterion_id: string;
  criterion_name: string;
  responses: CloseCallResponse[];
  note: string;
}

interface Comparison {
  id: string;
  rfp_id: string;
  ranking: RankingEntry[];
  comparative_analysis: string;
  close_calls: CloseCall[];
  model_used?: string;
  prompt_version?: string;
  created_at: string;
  interview_focus_areas?: string[];
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

interface ScoreEntry {
  score: number;
  max: number;
  rationale: string;
  evidence_quote: string;
  page_ref: string | null;
  overridden?: boolean;
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
  model_used: string;
  prompt_version: string;
  created_at: string;
}

interface Response {
  id: string;
  rfp_id: string;
  vendor_name: string;
  file_path: string | null;
  extracted_text: string | null;
  ocr_status: string | null;
  page_count: number | null;
  status: string;
  created_at: string;
}

/** How close two scores have to be before the ranking stops being decisive. */
const CLOSE_MARGIN = 3;

const COMPARISON_NOTES = [
  "Reading every evaluation side by side.",
  "Ranking the proposals against the weighted rubric.",
  "Looking for criteria where the field is too close to call.",
  "Drafting what to ask each vendor at interview.",
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ComparisonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const supabase = useMemo(() => createClient(), []);

  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [responses, setResponses] = useState<Response[]>([]);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [rfpTitle, setRfpTitle] = useState("RFP evaluation");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -- fetch all data -------------------------------------------------------

  // No synchronous setState ahead of the first await — this runs from an
  // effect. (The old `silent` option existed only to suppress the eager
  // setLoading, so it no longer has anything to suppress.)
  const fetchData = useCallback(async () => {
    try {
      const [comparisonRes, evaluationsRes, responsesRes, rubricRes, rfpRes] =
        await Promise.all([
          supabase
            .from("comparisons")
            .select("*")
            .eq("rfp_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase.from("evaluations").select("*").eq("rfp_id", id),
          supabase.from("responses").select("*").eq("rfp_id", id),
          supabase
            .from("rubrics")
            .select("*")
            .eq("rfp_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          // Only for the exported report's title — a file called
          // "comparison.csv" tells its recipient nothing.
          supabase.from("rfps").select("title").eq("id", id).maybeSingle(),
        ]);

      if (comparisonRes.error) throw comparisonRes.error;
      if (evaluationsRes.error) throw evaluationsRes.error;
      if (responsesRes.error) throw responsesRes.error;
      if (rubricRes.error) throw rubricRes.error;

      setComparison((comparisonRes.data as Comparison) ?? null);
      setEvaluations((evaluationsRes.data as Evaluation[]) ?? []);
      setResponses((responsesRes.data as Response[]) ?? []);
      setRubric((rubricRes.data as Rubric) ?? null);
      const title = (rfpRes.data as { title?: string } | null)?.title;
      if (title) setRfpTitle(title);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load comparison data"
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
    fetchData();
  }, [fetchData]);

  // -- generate comparison --------------------------------------------------

  const generateComparison = useCallback(async () => {
    setGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/compare-responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfp_id: id }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      await fetchData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate comparison"
      );
    } finally {
      setGenerating(false);
    }
  }, [id, fetchData]);

  // -- derived data ---------------------------------------------------------

  const sortedRanking = useMemo(() => {
    if (!comparison?.ranking) return [];
    return [...comparison.ranking].sort((a, b) => a.rank - b.rank);
  }, [comparison]);

  const criteriaList = useMemo<RubricCriterion[]>(() => {
    if (!rubric?.criteria) return [];
    if (Array.isArray(rubric.criteria)) return rubric.criteria;
    const maybe = rubric.criteria as unknown as {
      criteria?: RubricCriterion[];
    };
    return maybe.criteria ?? [];
  }, [rubric]);

  // Map response_id → vendor_name from responses table (fallback)
  const vendorByResponseId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of responses) {
      map.set(r.id, r.vendor_name);
    }
    return map;
  }, [responses]);

  // Map response_id → evaluation
  const evalByResponseId = useMemo(() => {
    const map = new Map<string, Evaluation>();
    for (const e of evaluations) {
      map.set(e.response_id, e);
    }
    return map;
  }, [evaluations]);

  const nameFor = useCallback(
    (entry: { response_id: string; vendor_name?: string }) =>
      entry.vendor_name ??
      vendorByResponseId.get(entry.response_id) ??
      "Unknown vendor",
    [vendorByResponseId]
  );

  // All vendor responses that have evaluations (for per-criterion columns)
  const evaluatedResponses = useMemo(() => {
    return responses
      .filter((r) => evalByResponseId.has(r.id))
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  }, [responses, evalByResponseId]);

  // Interview focus areas
  const interviewFocusAreas = useMemo<string[]>(() => {
    if (comparison?.interview_focus_areas?.length) {
      return comparison.interview_focus_areas;
    }
    // Derive from close calls notes
    if (comparison?.close_calls?.length) {
      return comparison.close_calls.map(
        (cc) => cc.note || `Review ${cc.criterion_name}`
      );
    }
    return [];
  }, [comparison]);

  const winner = sortedRanking[0] ?? null;
  const runnerUp = sortedRanking[1] ?? null;

  /**
   * The gap between first and second.
   *
   * This is the single most decision-relevant number on the page and the old
   * layout never computed it: a two-point win and a thirty-point win looked
   * identical in a ranked table.
   */
  const margin =
    winner && runnerUp ? winner.overall_score - runnerUp.overall_score : null;
  const tooCloseToCall = margin != null && margin < CLOSE_MARGIN;

  // -- the export payload ---------------------------------------------------

  const reportData = useMemo<ReportData | null>(() => {
    if (!comparison) return null;

    const vendors: ReportVendor[] = sortedRanking.map((entry) => {
      const evaluation = evalByResponseId.get(entry.response_id);
      const scores: ReportVendor["scores"] = {};
      for (const criterion of criteriaList) {
        const raw = evaluation?.scores?.[criterion.id];
        if (!raw) continue;
        scores[criterion.id] = {
          score: raw.score,
          max: raw.max,
          percent: toPercent(raw.score, raw.max),
          rationale: raw.rationale,
          evidence_quote: raw.evidence_quote,
          page_ref: raw.page_ref,
          overridden: raw.overridden,
        };
      }
      return {
        responseId: entry.response_id,
        vendorName: nameFor(entry),
        rank: entry.rank,
        overallScore: entry.overall_score,
        rankRationale: entry.rationale,
        summary: evaluation?.summary,
        strengths: evaluation?.strengths ?? [],
        weaknesses: evaluation?.weaknesses ?? [],
        scores,
      };
    });

    return {
      rfpTitle,
      generatedAt: new Date(comparison.created_at).toLocaleDateString(
        undefined,
        { year: "numeric", month: "long", day: "numeric" }
      ),
      modelUsed: comparison.model_used ?? null,
      criteria: criteriaList.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        weight: c.weight,
      })),
      vendors,
      comparativeAnalysis: comparison.comparative_analysis,
      closeCalls: (comparison.close_calls ?? []).map((cc) => ({
        criterionName: cc.criterion_name,
        note: cc.note,
        contenders: (cc.responses ?? []).map((r) => ({
          vendorName: r.vendor_name,
          score: r.score,
        })),
      })),
      interviewFocusAreas,
    };
  }, [
    comparison,
    sortedRanking,
    evalByResponseId,
    criteriaList,
    nameFor,
    rfpTitle,
    interviewFocusAreas,
  ]);

  // -- render ---------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <AppHeader rfpId={id} current="comparison" />

      <main className="container mx-auto max-w-4xl px-4 py-10">
        {loading ? (
          <WorkingState
            title="Loading the comparison"
            notes={["Fetching the ranking and every score behind it."]}
          />
        ) : !evaluations.length ? (
          <EmptyState
            title="Nothing to compare yet"
            action={
              <Button render={<Link href={`/rfp/${id}/evaluations`} />}>
                Go to evaluations
              </Button>
            }
          >
            Score at least two proposals and the ranking, the close calls and
            the interview questions land here.
          </EmptyState>
        ) : generating && !comparison ? (
          <WorkingState
            title="Working out the ranking"
            notes={COMPARISON_NOTES}
            expected="15–45 seconds"
          />
        ) : !comparison ? (
          <EmptyState
            title="Ready to rank"
            action={
              <Button onClick={generateComparison} disabled={generating}>
                Rank the proposals
              </Button>
            }
          >
            {evaluations.length} proposals are scored. This last step ranks
            them against the weighted rubric and writes up what to ask at
            interview.
          </EmptyState>
        ) : (
          <>
            <PageIntro
              eyebrow="Step 4 of 4"
              title="The decision"
              action={
                reportData && (
                  <Button
                    onClick={() => exportReport(reportData)}
                    size="lg"
                  >
                    <DownloadIcon aria-hidden="true" />
                    Download report
                  </Button>
                )
              }
            >
              Ranked against your weighted rubric, with the passage behind every
              score.
            </PageIntro>

            {error && (
              <div className="mt-6">
                <ErrorState message={error} />
              </div>
            )}

            {/* ------------------------------------------------------------
             * The recommendation
             *
             * One vendor, one score, one sentence of why, and how far clear
             * of second place it is. A ranked table alone made the reader do
             * the subtraction that decides whether this is a decision or a
             * coin toss.
             * --------------------------------------------------------- */}
            {winner && (
              <section className="animate-reveal mt-8 rounded-xl bg-card p-6 ring-1 ring-foreground/10">
                <div className="flex flex-wrap items-start justify-between gap-6">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      <TrophyIcon
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                      />
                      Recommended
                    </p>
                    <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
                      {nameFor(winner)}
                    </h2>
                    {winner.rationale && (
                      <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground">
                        {winner.rationale}
                      </p>
                    )}
                  </div>
                  <ScoreMeter
                    value={winner.overall_score}
                    label={`Weighted across ${criteriaList.length} criteria`}
                    className="w-52 shrink-0"
                  />
                </div>

                {margin != null && runnerUp && (
                  <p
                    className="mt-5 border-t border-border/60 pt-4 text-sm text-foreground"
                    // The close-call warning is a genuine caution about the
                    // result, so it is announced rather than only coloured.
                    role={tooCloseToCall ? "note" : undefined}
                  >
                    {tooCloseToCall ? (
                      <>
                        <span className="font-medium">Too close to call:</span>{" "}
                        only {formatScore(margin)} points clear of{" "}
                        {nameFor(runnerUp)}. Treat this as where to start the
                        interviews, not as the answer.
                      </>
                    ) : (
                      <>
                        <span className="font-medium">
                          {formatScore(margin)} points clear
                        </span>{" "}
                        of {nameFor(runnerUp)}.
                      </>
                    )}
                  </p>
                )}
              </section>
            )}

            {/* ------------------------------------------------------------
             * The ranking
             *
             * Rows carry the comparison; the reasoning behind each placing
             * opens on demand. The old table put a paragraph of rationale in
             * a cell, which made every row four lines tall and the ranking
             * itself hard to see.
             * --------------------------------------------------------- */}
            <h2 className="mt-10 text-sm font-semibold text-foreground">
              Ranking
            </h2>
            <Accordion className="mt-3 gap-2.5">
              {sortedRanking.map((entry, index) => (
                <AccordionItem
                  key={entry.response_id}
                  value={entry.response_id}
                  className="animate-reveal"
                  style={{ ["--reveal-i" as string]: index }}
                >
                  <AccordionTrigger>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-primary">
                      {entry.rank}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {nameFor(entry)}
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <ScoreBar
                          percent={entry.overall_score}
                          index={index}
                          thickness="thin"
                          className="max-w-48"
                        />
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                          {formatScore(entry.overall_score)}
                        </span>
                      </span>
                    </span>
                    <TierChip
                      tier={scoreTier(entry.overall_score)}
                      size="sm"
                      className="shrink-0"
                    />
                  </AccordionTrigger>
                  <AccordionPanel>
                    <div className="space-y-3">
                      {entry.rationale && (
                        <p className="text-sm leading-relaxed text-foreground">
                          {entry.rationale}
                        </p>
                      )}
                      {evalByResponseId.get(entry.response_id)?.summary && (
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {evalByResponseId.get(entry.response_id)?.summary}
                        </p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        render={
                          <Link href={`/rfp/${id}/evaluations`} />
                        }
                      >
                        See every score for this proposal
                      </Button>
                    </div>
                  </AccordionPanel>
                </AccordionItem>
              ))}
            </Accordion>

            {/* ------------------------------------------------------------
             * What to do next
             *
             * The most actionable output in the app, previously the fourth
             * card down as a bulleted list. As a checklist it is something
             * you take into a room.
             * --------------------------------------------------------- */}
            {interviewFocusAreas.length > 0 && (
              <>
                <h2 className="mt-10 text-sm font-semibold text-foreground">
                  Ask at interview
                </h2>
                <ul className="mt-3 divide-y divide-border/60 rounded-xl bg-card ring-1 ring-foreground/10">
                  {interviewFocusAreas.map((area, i) => (
                    <li
                      key={i}
                      className="animate-reveal flex gap-3 px-4 py-3"
                      style={{ ["--reveal-i" as string]: i }}
                    >
                      <span
                        className="mt-0.5 size-3.5 shrink-0 rounded-[3px] ring-1 ring-muted-foreground/50"
                        aria-hidden="true"
                      />
                      <span className="text-sm leading-snug text-foreground">
                        {area}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* ------------------------------------------------------------
             * Detail, folded away
             * --------------------------------------------------------- */}
            <h2 className="mt-10 text-sm font-semibold text-foreground">
              Behind the ranking
            </h2>
            <div className="mt-3 space-y-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
              {comparison.comparative_analysis && (
                <Collapsible>
                  <CollapsibleTrigger>
                    Full comparative analysis
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <p className="pt-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                      {comparison.comparative_analysis}
                    </p>
                  </CollapsiblePanel>
                </Collapsible>
              )}

              <Collapsible>
                <CollapsibleTrigger>
                  {comparison.close_calls?.length
                    ? `Close calls (${comparison.close_calls.length})`
                    : "Close calls — none"}
                </CollapsibleTrigger>
                <CollapsiblePanel>
                  <div className="space-y-3 pt-3">
                    {comparison.close_calls?.length ? (
                      comparison.close_calls.map((cc, idx) => (
                        <div
                          key={`${cc.criterion_id}-${idx}`}
                          className="rounded-lg bg-muted/50 p-3"
                        >
                          <h4 className="text-sm font-semibold text-foreground">
                            {cc.criterion_name}
                          </h4>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {cc.responses?.map((r) => (
                              <Badge
                                key={r.response_id}
                                variant="outline"
                                className="tabular-nums"
                              >
                                {r.vendor_name} {formatScore(r.score)}
                              </Badge>
                            ))}
                          </div>
                          {cc.note && (
                            <p className="mt-2 text-sm text-muted-foreground">
                              {cc.note}
                            </p>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Every criterion separated the field cleanly.
                      </p>
                    )}
                  </div>
                </CollapsiblePanel>
              </Collapsible>

              {criteriaList.length > 0 && evaluatedResponses.length > 0 && (
                <Collapsible>
                  <CollapsibleTrigger>
                    Score grid — every criterion, every vendor
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="pt-3">
                      <ScoreGrid
                        columns={evaluatedResponses.map((r) => ({
                          id: r.id,
                          label: r.vendor_name,
                        }))}
                        rows={criteriaList.map((c) => ({
                          id: c.id,
                          label: c.name,
                          weight: c.weight,
                        }))}
                        cell={(criterionId, responseId) => {
                          const entry =
                            evalByResponseId.get(responseId)?.scores?.[
                              criterionId
                            ];
                          if (!entry) return null;
                          return {
                            percent: toPercent(entry.score, entry.max),
                            raw: `${formatScore(entry.score)} of ${entry.max}`,
                            note: entry.rationale,
                          };
                        }}
                      />
                    </div>
                  </CollapsiblePanel>
                </Collapsible>
              )}
            </div>

            {/* ------------------------------------------------------------
             * Take it with you
             * --------------------------------------------------------- */}
            <h2 className="mt-10 text-sm font-semibold text-foreground">
              Take it with you
            </h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {reportData && (
                <>
                  <Button onClick={() => exportReport(reportData)}>
                    <DownloadIcon aria-hidden="true" />
                    Report
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => exportCsv(reportData)}
                  >
                    <SheetIcon aria-hidden="true" />
                    Spreadsheet
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => exportJson(reportData)}
                  >
                    <FileJsonIcon aria-hidden="true" />
                    JSON
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                onClick={generateComparison}
                disabled={generating}
                className="ml-auto text-muted-foreground"
              >
                <RotateCcwIcon aria-hidden="true" />
                {generating ? "Re-ranking…" : "Re-rank"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The report opens in a browser and prints to PDF, with the decision
              first and every score, quote and page reference behind a
              disclosure.
              {comparison.model_used && (
                <> Scored by {comparison.model_used}.</>
              )}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
