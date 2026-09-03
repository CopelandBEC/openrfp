/**
 * Where an evaluation has actually got to.
 *
 * `rfps.status` cannot answer this and never could. `generate-rubric` sets it
 * to `rubric_ready` the moment a rubric is generated — before anyone has read
 * the thing — accepting a rubric transitions nothing, and no code path in the
 * repo ever writes `evaluating` at all. So an RFP reads `rubric_ready` from
 * generation until the final comparison flips it to `complete`.
 *
 * The rows themselves are unambiguous, so the stage is derived from them: a
 * rubric exists or it doesn't, it has been accepted or it hasn't, proposals
 * are uploaded, scored, ranked. This stays correct however `status` drifts,
 * and needs no migration or backfill of existing rows.
 *
 * `status` is left alone as the coarse flag it already is — other code reads
 * it, and nothing here needs it.
 */

export interface StageInputs {
  hasRubric: boolean;
  /**
   * Whether the owner has been through the rubric screen and saved it.
   *
   * `rubrics.edited_by_user` is the signal: the generator writes it `false`
   * and the rubric page's Accept writes it `true`, whether or not anything was
   * actually edited. The column name undersells it — it means "a human has
   * signed off on this" — but it is the accurate bit and inventing a second
   * one would need a migration.
   */
  rubricAccepted: boolean;
  responseCount: number;
  evaluationCount: number;
  /** When the ranking was produced, or null if there isn't one. */
  comparisonAt: string | null;
  /**
   * The newest evaluation's timestamp.
   *
   * A comparison older than the newest score is a comparison that did not see
   * it — a proposal added and scored after the ranking ran leaves the ranking
   * in place but no longer describing the field.
   */
  latestEvaluationAt: string | null;
}

export interface Stage {
  /** 1-4, for the progress pips. */
  step: number;
  /** What is waiting on the owner, in their words. */
  label: string;
  /** The screen that action happens on. */
  next: "rubric" | "responses" | "evaluations" | "comparison";
  /** True only when there is nothing left to do. */
  done: boolean;
}

export const TOTAL_STAGES = 4;

export function deriveStage({
  hasRubric,
  rubricAccepted,
  responseCount,
  evaluationCount,
  comparisonAt,
  latestEvaluationAt,
}: StageInputs): Stage {
  // Prerequisites first, and "decided" last. Checked the other way round, an
  // existing comparison row shouted down every other fact: regenerating the
  // rubric on a finished RFP resets `edited_by_user` without deleting the
  // comparison, and adding a proposal leaves it in place too, so the card said
  // "Decided" and linked to a ranking that predated both.
  if (!hasRubric) {
    return { step: 1, label: "Needs a rubric", next: "rubric", done: false };
  }
  // The case the old mapping got wrong: a generated rubric nobody has read.
  if (!rubricAccepted) {
    return {
      step: 1,
      label: "Review the rubric",
      next: "rubric",
      done: false,
    };
  }
  if (responseCount === 0) {
    return {
      step: 2,
      label: "Needs proposals",
      next: "responses",
      done: false,
    };
  }
  if (evaluationCount < responseCount) {
    return { step: 2, label: "Needs scoring", next: "responses", done: false };
  }
  // Everything upstream is satisfied, so a ranking that has seen every score
  // is the finished article. One that predates a score has not.
  const comparisonIsCurrent =
    comparisonAt != null &&
    (latestEvaluationAt == null || latestEvaluationAt <= comparisonAt);
  if (comparisonIsCurrent) {
    return { step: 4, label: "Decided", next: "comparison", done: true };
  }
  return {
    step: 3,
    label: comparisonAt == null ? "Ready to rank" : "Needs re-ranking",
    next: "evaluations",
    done: false,
  };
}

/**
 * Read a PostgREST embedded relation that holds at most one row.
 *
 * `rubrics.rfp_id` and `comparisons.rfp_id` are unique, so PostgREST may embed
 * them as an object or as a one-element array depending on whether it detects
 * the relationship as to-one. Accept both rather than depend on which.
 */
export function firstEmbedded<T>(value: unknown): T | null {
  if (value == null) return null;
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  return value as T;
}

/** Read the `{ count }` shape PostgREST returns for an aggregated relation. */
export function embeddedCount(value: unknown): number {
  const row = firstEmbedded<{ count?: number }>(value);
  return row?.count ?? 0;
}
