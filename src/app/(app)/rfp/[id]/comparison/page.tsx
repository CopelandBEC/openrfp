"use client";

import { use, useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  DownloadIcon,
  FileJsonIcon,
  RotateCcwIcon,
  SheetIcon,
  TriangleAlertIcon,
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
  evaluationRevisionsOf,
  rankedResponseIdsOf,
  sameInstant,
  scoredAgainstCurrentRubric,
} from "@/lib/stage";
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
  updated_at?: string | null;
  /** Exactly which evaluation versions this ranking saw; see lib/stage.ts. */
  evaluation_revisions?: unknown;
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
  /** When the criteria last changed. */
  updated_at?: string | null;
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
  updated_at: string | null;
  /** The rubric these scores were made against; see lib/stage.ts. */
  rubric_updated_at?: string | null;
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

  /**
   * Whether the saved ranking has the shape the route asked for: one entry
   * per proposal, each with a response id. The route refuses anything else
   * before saving, so this is only true of rows from before it did — but a
   * ranking that lists a vendor twice must not render that vendor twice, or
   * call the duplicate its own runner-up.
   */
  const rankingMalformed =
    comparison != null && rankedResponseIdsOf(comparison.ranking) == null;

  const sortedRanking = useMemo(() => {
    if (!Array.isArray(comparison?.ranking)) return [];
    const seen = new Set<string>();
    return [...comparison.ranking]
      .sort((a, b) => a.rank - b.rank)
      .filter((entry) => {
        // First occurrence by rank wins; the malformed-ranking notice says
        // the rest.
        if (typeof entry?.response_id !== "string" || seen.has(entry.response_id)) {
          return false;
        }
        seen.add(entry.response_id);
        return true;
      });
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

  /**
   * The ranked field, with live scores.
   *
   * `comparisons.ranking` is a snapshot taken when the comparison ran. An
   * override on the evaluations screen writes `evaluations.scores` and
   * `evaluations.overall_score` and never touches that snapshot, so reading
   * the overall from one place and the criterion scores from the other — which
   * is what the exports did — could show criterion scores whose weighted total
   * did not equal the stated overall.
   *
   * Everything on this page and in every export now reads the overall from
   * here: the live evaluation where there is one, the snapshot only as a
   * fallback. The rank stays as ranked, because re-sorting silently would
   * present an order the model never actually justified — so where the numbers
   * have moved, we say so instead.
   */
  const rankedVendors = useMemo(
    () =>
      sortedRanking.map((entry) => {
        const evaluation = evalByResponseId.get(entry.response_id);
        const rankedScore = entry.overall_score;
        const score = evaluation?.overall_score ?? rankedScore;
        return {
          responseId: entry.response_id,
          name: nameFor(entry),
          rank: entry.rank,
          rationale: entry.rationale,
          summary: evaluation?.summary,
          evaluation,
          score,
          rankedScore,
          // Half a point of drift is a real edit, not float noise.
          moved:
            score != null &&
            rankedScore != null &&
            Math.abs(score - rankedScore) > 0.05,
        };
      }),
    [sortedRanking, evalByResponseId, nameFor]
  );

  /**
   * Every way the saved ranking can have stopped describing the field.
   *
   * The first version of this checked one of them — a score moved on a vendor
   * already in the ranking — which missed the two that matter more. The
   * ranking is a snapshot of a set as well as of some numbers: a proposal
   * added and scored afterwards is absent from it entirely, and one deleted
   * leaves an entry behind with nothing under it. Neither showed up as drift,
   * so a new bidder could be missing from the exported decision document with
   * nothing on the page saying so.
   */
  const rankedIds = useMemo(
    () => new Set(sortedRanking.map((e) => e.response_id)),
    [sortedRanking]
  );

  /** Scored proposals the ranking never saw. */
  const addedSinceRanking = useMemo(
    () => evaluatedResponses.filter((r) => !rankedIds.has(r.id)),
    [evaluatedResponses, rankedIds]
  );

  /**
   * Proposals uploaded since the ranking and not yet scored.
   *
   * The field is every proposal, not every scored one. An unscored addition
   * is absent from `evaluatedResponses`, so without this the page went on
   * calling the old winner recommended and exporting a report with a bidder
   * missing, while the dashboard for the same RFP said scoring was still to
   * do. Re-ranking does not fix it — the ranking still would not see the
   * proposal — so the owner is sent to score it first.
   */
  const awaitingScoreSinceRanking = useMemo(
    () =>
      responses.filter(
        (r) => !rankedIds.has(r.id) && !evalByResponseId.has(r.id)
      ),
    [responses, rankedIds, evalByResponseId]
  );

  /** Ranked entries whose evaluation is gone. */
  const removedSinceRanking = useMemo(
    () => rankedVendors.filter((v) => !v.evaluation),
    [rankedVendors]
  );

  const scoresMoved = useMemo(
    () => rankedVendors.some((v) => v.moved),
    [rankedVendors]
  );

  /**
   * Whether any evaluation the ranking read has been written since.
   *
   * This is the authoritative signal, and it supersedes comparing overall
   * scores. Two offsetting criterion edits — one up, one down, same weighted
   * effect — leave the overall identical, so `scoresMoved` cannot see them,
   * while the exported criterion values no longer match the rationale and
   * close calls the model wrote. The row's update time moved either way.
   *
   * The ranking side is `evaluation_revisions`: the version of each row the
   * compare route read before it called the model, compared row by row with
   * the version now. Not the row's `updated_at`, which is when the ranking was
   * saved, a model call later; and not a newest-input watermark, which assumes
   * timestamps commit in order — see lib/stage.ts. A ranking that does not say
   * what it saw reads as out of date. Added and removed proposals are reported
   * separately, so only rows on both sides are compared here.
   */
  const rankingSaw = useMemo(
    () =>
      comparison ? evaluationRevisionsOf(comparison.evaluation_revisions) : null,
    [comparison]
  );
  const evaluationsEditedSinceRanking = useMemo(() => {
    if (!comparison) return false;
    if (rankingSaw == null) return evaluations.length > 0;
    return evaluations.some(
      (e) =>
        e.response_id in rankingSaw &&
        !sameInstant(rankingSaw[e.response_id], e.updated_at ?? e.created_at)
    );
  }, [comparison, rankingSaw, evaluations]);

  /**
   * Whether live scores would put the field in a different order.
   *
   * This is the difference between "the numbers shifted a little" and "the
   * ranking now names the wrong leader", and it decides whether this page is
   * still allowed to recommend anyone.
   */
  const orderChanged = useMemo(() => {
    const live = [...rankedVendors].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return live.some((v, i) => v.responseId !== rankedVendors[i]?.responseId);
  }, [rankedVendors]);

  /**
   * Scored proposals whose scores were made against an earlier rubric.
   *
   * The other checks on this page compare the ranking with the scores. This
   * one is a level down: a rubric edited after scoring leaves the scores
   * themselves describing criteria that no longer exist, and no re-rank fixes
   * that — the proposals have to be scored again first.
   */
  const scoredAgainstOldRubric = useMemo(
    () =>
      evaluatedResponses.filter((r) => {
        const evaluation = evalByResponseId.get(r.id);
        return !scoredAgainstCurrentRubric(
          evaluation?.rubric_updated_at,
          rubric?.updated_at
        );
      }),
    [evaluatedResponses, evalByResponseId, rubric]
  );
  const rubricChangedSinceScoring = scoredAgainstOldRubric.length > 0;

  const rankingStale =
    rankingMalformed ||
    rubricChangedSinceScoring ||
    awaitingScoreSinceRanking.length > 0 ||
    evaluationsEditedSinceRanking ||
    scoresMoved ||
    addedSinceRanking.length > 0 ||
    removedSinceRanking.length > 0;

  /** Whether re-ranking now would still leave something out. */
  const needsScoringFirst =
    rubricChangedSinceScoring || awaitingScoreSinceRanking.length > 0;

  /**
   * Whether every score shown is a live, current one. False when a proposal
   * is unscored or scored against an old rubric, and also when a ranked
   * proposal has been removed: it stays in the list with the score it had
   * when ranked, because that is all there is.
   */
  const scoresCurrent = !needsScoringFirst && removedSinceRanking.length === 0;

  /**
   * Where a re-rank has to be redirected, if anywhere. Scoring comes first;
   * then the count, since the compare route refuses fewer than two scored
   * proposals and re-ranking a field of one is nothing to rank against. Null
   * means re-ranking is the right next action.
   */
  const rerankBlockedBy: "scoring" | "count" | null = needsScoringFirst
    ? "scoring"
    : evaluations.length < 2
      ? "count"
      : null;
  const rerankRedirectLabel =
    rerankBlockedBy === "scoring"
      ? rubricChangedSinceScoring
        ? "Re-score proposals"
        : "Score proposals"
      : "Add another proposal";

  /** Said in one line each, on the page and in the exported report. */
  const stalenessReasons = useMemo(() => {
    const reasons: string[] = [];
    if (rankingMalformed) {
      reasons.push(
        "This ranking lists a proposal twice or has an entry with no proposal behind it; only the first mention of each is shown."
      );
    }
    if (scoredAgainstOldRubric.length > 0) {
      reasons.push(
        `The rubric changed after ${scoredAgainstOldRubric.length} proposal${
          scoredAgainstOldRubric.length === 1 ? " was" : "s were"
        } scored: ${scoredAgainstOldRubric
          .map((r) => r.vendor_name)
          .join(", ")}.`
      );
    }
    if (awaitingScoreSinceRanking.length > 0) {
      reasons.push(
        `${awaitingScoreSinceRanking.length} proposal${
          awaitingScoreSinceRanking.length === 1 ? "" : "s"
        } added since this ranking and not yet scored: ${awaitingScoreSinceRanking
          .map((r) => r.vendor_name)
          .join(", ")}.`
      );
    }
    if (addedSinceRanking.length > 0) {
      reasons.push(
        `${addedSinceRanking.length} proposal${
          addedSinceRanking.length === 1 ? "" : "s"
        } scored since this ranking and not in it: ${addedSinceRanking
          .map((r) => r.vendor_name)
          .join(", ")}`
      );
    }
    if (removedSinceRanking.length > 0) {
      reasons.push(
        `${removedSinceRanking.length} ranked proposal${
          removedSinceRanking.length === 1 ? "" : "s"
        } no longer scored: ${removedSinceRanking
          .map((v) => v.name)
          .join(", ")}`
      );
    }
    if (orderChanged) {
      reasons.push("A changed score has reordered the field.");
    } else if (scoresMoved) {
      reasons.push("A score has changed, but the order still holds.");
    } else if (evaluationsEditedSinceRanking) {
      // The overall did not move, so say what did rather than nothing.
      reasons.push(
        rankingSaw == null
          ? "This ranking does not record which scores it saw."
          : "A criterion score was changed after this ranking without moving the total."
      );
    }
    return reasons;
  }, [
    rankingMalformed,
    rankingSaw,
    scoredAgainstOldRubric,
    awaitingScoreSinceRanking,
    addedSinceRanking,
    removedSinceRanking,
    orderChanged,
    scoresMoved,
    evaluationsEditedSinceRanking,
  ]);

  const winner = rankedVendors[0] ?? null;
  const runnerUp = rankedVendors[1] ?? null;

  /**
   * The gap between first and second.
   *
   * This is the single most decision-relevant number on the page and the old
   * layout never computed it: a two-point win and a thirty-point win looked
   * identical in a ranked table.
   */
  const margin = winner && runnerUp ? winner.score - runnerUp.score : null;
  const tooCloseToCall = margin != null && margin < CLOSE_MARGIN;

  // -- the export payload ---------------------------------------------------

  const reportData = useMemo<ReportData | null>(() => {
    if (!comparison) return null;

    const vendors: ReportVendor[] = rankedVendors.map((entry) => {
      const evaluation = entry.evaluation;
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
        responseId: entry.responseId,
        vendorName: entry.name,
        rank: entry.rank,
        // The live overall, so it agrees with the criterion scores beside it.
        overallScore: entry.score,
        rankRationale: entry.rationale,
        summary: evaluation?.summary,
        strengths: evaluation?.strengths ?? [],
        weaknesses: evaluation?.weaknesses ?? [],
        scores,
      };
    });

    return {
      rfpTitle,
      // The ranking's own date. A re-rank upserts the row, so `created_at`
      // is when the first ranking ran and would date every later report to
      // an order that no longer exists.
      generatedAt: new Date(
        comparison.updated_at ?? comparison.created_at
      ).toLocaleDateString(
        undefined,
        { year: "numeric", month: "long", day: "numeric" }
      ),
      // Two different facts. The comparison row names the model that ranked;
      // each evaluation names the model that scored it, and AI_MODEL can
      // change between the two.
      rankingModel: comparison.model_used ?? null,
      scoringModels: [
        ...new Set(
          evaluations.map((e) => e.model_used).filter((m): m is string => !!m)
        ),
      ],
      criteria: criteriaList.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        weight: c.weight,
      })),
      vendors,
      comparativeAnalysis: comparison.comparative_analysis,
      rankingStale,
      scoresCurrent,
      stalenessReasons,
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
    evaluations,
    rankedVendors,
    rankingStale,
    scoresCurrent,
    stalenessReasons,
    criteriaList,
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
        ) : error && !comparison ? (
          // A failed read is not an empty RFP. Every empty state below reads
          // "nothing here yet", which is the wrong thing to tell someone whose
          // ranking exists and did not load.
          <ErrorState
            message={error}
            action={
              <Button variant="outline" onClick={() => fetchData()}>
                Try again
              </Button>
            }
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
        ) : !comparison && evaluations.length < 2 && !needsScoringFirst ? (
          // The same threshold as the evaluations screen and the API: one
          // proposal is nothing to rank against.
          <EmptyState
            title="Nothing to compare yet"
            action={
              <Button render={<Link href={`/rfp/${id}/responses`} />}>
                Add another proposal
              </Button>
            }
          >
            A ranking needs at least two scored proposals. Add and score a
            second one, and this step ranks them against the weighted rubric
            and writes up what to ask at interview.
          </EmptyState>
        ) : !comparison ? (
          <EmptyState
            title={needsScoringFirst ? "Not ready to rank" : "Ready to rank"}
            action={
              needsScoringFirst ? (
                <Button render={<Link href={`/rfp/${id}/responses`} />}>
                  Score the proposals first
                </Button>
              ) : (
                <Button onClick={generateComparison} disabled={generating}>
                  Rank the proposals
                </Button>
              )
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
                    {/* "Recommended" is a claim about the current scores, so
                        it is only made when the current scores still support
                        it. Once an edit has reordered the field, this says
                        what it can defend — who the model put first when it
                        ran — and the notice below says the rest. */}
                    <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {!rankingStale && (
                        <TrophyIcon
                          className="size-3.5 text-primary"
                          aria-hidden="true"
                        />
                      )}
                      {rankingStale
                        ? "Ranked first when this ran"
                        : "Recommended"}
                    </p>
                    <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
                      {winner.name}
                    </h2>
                    {winner.rationale && (
                      <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground">
                        {winner.rationale}
                      </p>
                    )}
                  </div>
                  <ScoreMeter
                    value={winner.score}
                    label={`Weighted across ${criteriaList.length} criteria`}
                    className="w-52 shrink-0"
                  />
                </div>

                {/* A margin is a claim about the field as it stands, so it is
                    only made while the ranking still describes the field.
                    Reordering makes the subtraction negative; a newly scored
                    bidder above both makes the old runner-up the wrong one to
                    measure against; a removed one has no live score at all.
                    Any of those is worse than saying nothing. */}
                {margin != null && runnerUp && !rankingStale && (
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
                        {runnerUp.name}. Treat this as where to start the
                        interviews, not as the answer.
                      </>
                    ) : (
                      <>
                        <span className="font-medium">
                          {formatScore(margin)} points clear
                        </span>{" "}
                        of {runnerUp.name}.
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
            {/* A changed score does not re-sort the list — the model justified
                the order it gave — so the drift is stated instead, both here
                and in the exported report. */}
            {rankingStale && (
              <div
                role="note"
                className="animate-reveal mt-8 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-4 py-3"
              >
                <p className="flex items-start gap-2 text-sm text-foreground">
                  <TriangleAlertIcon
                    className="mt-0.5 size-4 shrink-0"
                    style={{ color: "var(--status-warning)" }}
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-medium">
                      This ranking is out of date.
                    </span>{" "}
                    {rubricChangedSinceScoring
                      ? "Some scores below were made against an earlier rubric, so they need scoring again before a re-rank means anything."
                      : awaitingScoreSinceRanking.length > 0
                        ? "A proposal has been added that this ranking has not seen. Score it first; re-ranking now would still leave it out."
                        : removedSinceRanking.length > 0
                          ? `A ranked proposal is no longer scored. Its number below is the one it had when ranked, and the order is the one the model gave then.${
                              rerankBlockedBy === "count"
                                ? " A ranking needs at least two scored proposals, so add another before re-ranking."
                                : ""
                            }`
                          : "The scores below are current; the order is the one the model gave before the change."}
                    <span className="mt-1.5 block text-muted-foreground">
                      {stalenessReasons.join(" ")}
                    </span>
                  </span>
                </p>
                {rerankBlockedBy ? (
                  <Button
                    size="sm"
                    render={<Link href={`/rfp/${id}/responses`} />}
                  >
                    {rerankRedirectLabel}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={generateComparison}
                    disabled={generating}
                  >
                    {generating ? "Re-ranking…" : "Re-rank"}
                  </Button>
                )}
              </div>
            )}

            <h2 className="mt-10 text-sm font-semibold text-foreground">
              Ranking
            </h2>
            <Accordion className="mt-3 gap-2.5">
              {rankedVendors.map((entry, index) => (
                <AccordionItem
                  key={entry.responseId}
                  value={entry.responseId}
                  className="animate-reveal"
                  style={{ ["--reveal-i" as string]: index }}
                >
                  <AccordionTrigger>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-primary">
                      {entry.rank}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {entry.name}
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <ScoreBar
                          percent={entry.score}
                          index={index}
                          thickness="thin"
                          className="max-w-48"
                        />
                        <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                          {formatScore(entry.score)}
                        </span>
                      </span>
                    </span>
                    <TierChip
                      tier={scoreTier(entry.score)}
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
                      {entry.summary && (
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          {entry.summary}
                        </p>
                      )}
                      {entry.moved && (
                        <p className="text-sm text-foreground">
                          Scored {formatScore(entry.rankedScore)} when this
                          ranking was produced, {formatScore(entry.score)} now.
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

            {/* A proposal scored after the ranking ran has no rank to sit at,
                and dropping it would mean the decision document quietly
                omitted a bidder. It gets listed, unranked and labelled. */}
            {addedSinceRanking.length > 0 && (
              <ul className="mt-2.5 space-y-2.5">
                {addedSinceRanking.map((response, index) => {
                  const evaluation = evalByResponseId.get(response.id);
                  return (
                    <li
                      key={response.id}
                      className="animate-reveal flex items-center gap-3 rounded-xl bg-muted/40 px-4 py-3 ring-1 ring-foreground/5"
                      style={{ ["--reveal-i" as string]: index }}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                        —
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {response.vendor_name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Scored after this ranking — not included in it
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">
                        {formatScore(evaluation?.overall_score)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

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
              {/* Every way to start a re-rank is guarded the same way: a
                  ranking of a field with unscored or old-rubric proposals in
                  it is out of date the moment it is saved, and costs a model
                  call to find that out. */}
              {rerankBlockedBy ? (
                <Button
                  variant="ghost"
                  render={<Link href={`/rfp/${id}/responses`} />}
                  className="ml-auto text-muted-foreground"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  {rerankBlockedBy === "scoring"
                    ? "Score proposals first"
                    : "Add another proposal"}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={generateComparison}
                  disabled={generating}
                  className="ml-auto text-muted-foreground"
                >
                  <RotateCcwIcon aria-hidden="true" />
                  {generating ? "Re-ranking…" : "Re-rank"}
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The report opens in a browser and prints to PDF, with the decision
              first and every score, quote and page reference behind a
              disclosure.
              {comparison.model_used && (
                <> Ranked by {comparison.model_used}.</>
              )}
            </p>
          </>
        )}
      </main>
    </div>
  );
}
