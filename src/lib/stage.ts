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
  /**
   * Every scored proposal: which response it scores, and which rubric it was
   * scored against, as that rubric's `updated_at`.
   *
   * Ids rather than a count, because a saved ranking is a snapshot of a set,
   * and a count cannot tell one set from another of the same size. The rubric
   * stamp is recorded at scoring time by the evaluate route; see
   * `scoredAgainstCurrentRubric`.
   */
  evaluations: ScoredProposal[];
  /**
   * When the rubric's criteria last changed, or null if there is no rubric.
   *
   * Scores are made against a rubric, so a rubric edited after scoring leaves
   * every score describing criteria and weights that no longer exist, and
   * the ranking built on them along with it. `rubrics.updated_at` moves only
   * when `criteria` change — accepting a rubric unchanged does not count.
   */
  rubricUpdatedAt: string | null;
  /** Whether a saved ranking exists at all. */
  hasRanking: boolean;
  /**
   * Exactly which evaluation versions the saved ranking was built from:
   * `comparisons.evaluation_revisions`, a `{ response_id: updated_at }` map
   * of every row the compare route read before calling the model. Null if
   * there is no ranking, or if the row does not say — which reads as out of
   * date, and a re-rank fixes.
   *
   * Per row, not a watermark. The row's own `updated_at` is when the ranking
   * was *saved*, a model call later; and a single newest-input timestamp is
   * not safe either, since `now()` is a transaction's start time rather than
   * its commit order. Comparing each version read against each version now
   * makes no ordering assumption. `created_at` is out for the older reason:
   * a re-rank's upsert never moves it.
   */
  rankingSaw: Record<string, string | null> | null;
  /**
   * The `response_id` of every entry in the saved ranking, or null if there
   * isn't one.
   *
   * Timestamps cannot see a proposal being removed. Deleting a response
   * cascades its evaluation away, and nothing left behind is any newer than
   * the ranking — so on times alone an RFP reads "Decided" while its ranking
   * still lists a vendor who has left the field. The comparison screen catches
   * this by set difference, and the dashboard has to ask the same question or
   * the two disagree about the same RFP.
   */
  rankedResponseIds: string[] | null;
}

export interface ScoredProposal {
  responseId: string;
  /**
   * When the row was last written. An override edits `scores` in place and
   * re-scoring upserts, so creation time never moves; this does either way —
   * including for offsetting criterion edits that leave the total unchanged,
   * which no score comparison can see.
   */
  updatedAt: string | null;
  /** The `rubrics.updated_at` the scores were produced against. */
  rubricUpdatedAt: string | null;
}

export type StageName = "rubric" | "responses" | "evaluations" | "comparison";

export interface Stage {
  /** 1-4, for the progress pips. */
  step: number;
  /** What is waiting on the owner, in their words. */
  label: string;
  /** The screen that action happens on. */
  next: StageName;
  /** True only when there is nothing left to do. */
  done: boolean;
}

export const TOTAL_STAGES = 4;

export function deriveStage({
  hasRubric,
  rubricAccepted,
  responseCount,
  evaluations,
  rubricUpdatedAt,
  hasRanking,
  rankingSaw,
  rankedResponseIds,
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
  if (evaluations.length < responseCount) {
    return { step: 2, label: "Needs scoring", next: "responses", done: false };
  }
  // Scored, but against a rubric that has since changed. The scores describe
  // criteria that no longer exist, so this is a scoring problem before it is
  // a ranking one, and the proposals screen is where re-scoring happens.
  if (
    !evaluations.every((e) =>
      scoredAgainstCurrentRubric(e.rubricUpdatedAt, rubricUpdatedAt)
    )
  ) {
    return {
      step: 2,
      label: "Rubric changed — re-score",
      next: "responses",
      done: false,
    };
  }
  // A ranking needs something to rank against. With one proposal there is no
  // comparison to make, the evaluations screen offers no way on to the
  // decision and the compare route refuses, so say what is actually missing
  // rather than "Ready to rank" — or "Needs re-ranking", which is where a
  // ranked pair with one proposal since deleted landed, and is the same dead
  // end with a stale ranking behind it.
  if (responseCount < 2) {
    return {
      step: 2,
      label: "Needs a second proposal",
      next: "responses",
      done: false,
    };
  }
  // Everything upstream is satisfied, so a ranking built from exactly the
  // scores that exist now, as they are now, is the finished article. Three
  // things can make it not so: a score it read has since been written, a
  // scored proposal it never read exists, or a proposal it ranked no longer
  // does. The first two are the revision map; the third is the ranking's own
  // list of vendors against the scored set.
  const comparisonIsCurrent =
    hasRanking &&
    rankingSaw != null &&
    rankingSawExactly(rankingSaw, evaluations) &&
    rankedResponseIds != null &&
    sameSet(
      rankedResponseIds,
      evaluations.map((e) => e.responseId)
    );
  if (comparisonIsCurrent) {
    return { step: 4, label: "Decided", next: "comparison", done: true };
  }
  return {
    step: 3,
    label: hasRanking ? "Needs re-ranking" : "Ready to rank",
    next: "evaluations",
    done: false,
  };
}

/**
 * Which stages of an RFP have data behind them, and so can be navigated to.
 *
 * The progress rail inferred this from the URL — everything before the
 * current screen reachable, everything after it not — which made a finished
 * evaluation's Decision screen unreachable the moment its owner stepped back
 * to the rubric. The rows are the fact: a stage is reachable if what it shows
 * exists. The rubric screen always is; it is where an RFP starts.
 */
export function reachedStages({
  hasRubric,
  evaluationCount,
  hasRanking,
}: {
  hasRubric: boolean;
  evaluationCount: number;
  hasRanking: boolean;
}): Set<StageName> {
  const reached = new Set<StageName>(["rubric"]);
  if (hasRubric) reached.add("responses");
  if (evaluationCount > 0) reached.add("evaluations");
  if (hasRanking) reached.add("comparison");
  return reached;
}

/**
 * Whether an evaluation's scores were made against the rubric as it is now.
 *
 * `evaluationRubricAt` is the `rubrics.updated_at` the scoring route read
 * when it produced the scores; `rubricUpdatedAt` is that column now. They
 * are the same instant, or the rubric has changed in between. Compared as
 * instants rather than strings so a difference in rendering cannot read as a
 * difference in time.
 *
 * A rubric with no `updated_at` at all is the pre-migration schema, where the
 * question cannot be answered; that reads as current rather than sending
 * every owner to re-score everything. An evaluation with no stamp under a
 * rubric that has one is of unknown provenance, and reads as stale.
 */
export function scoredAgainstCurrentRubric(
  evaluationRubricAt: string | null | undefined,
  rubricUpdatedAt: string | null | undefined
): boolean {
  if (rubricUpdatedAt == null) return true;
  return sameInstant(evaluationRubricAt, rubricUpdatedAt);
}

/**
 * Whether a ranking's recorded inputs are exactly the evaluations as they are
 * now: the same set of proposals, each with the version the ranking read.
 */
export function rankingSawExactly(
  rankingSaw: Record<string, string | null>,
  evaluations: { responseId: string; updatedAt: string | null }[]
): boolean {
  const sawIds = Object.keys(rankingSaw);
  if (!sameSet(sawIds, evaluations.map((e) => e.responseId))) return false;
  return evaluations.every((e) =>
    sameInstant(rankingSaw[e.responseId], e.updatedAt)
  );
}

/**
 * Two timestamps from the database name the same instant.
 *
 * Compared as instants rather than strings so a difference in rendering —
 * `Z` against `+00:00`, trailing zeros — cannot read as a difference in
 * time. Null on either side is not an instant and never matches.
 */
export function sameInstant(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) return false;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  return Number.isFinite(pa) && Number.isFinite(pb) ? pa === pb : a === b;
}

function sameSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const id of setA) if (!setB.has(id)) return false;
  return true;
}

/**
 * Pull the response ids out of a saved `comparisons.ranking`.
 *
 * The column holds whatever the model emitted, straight from `parseModelJson`
 * into jsonb, so its shape is a convention rather than a guarantee. Anything
 * that is not an array of entries carrying a distinct string `response_id`
 * reads as "no usable ranking", which the stage then reports as needing a
 * re-rank rather than as decided. Distinct matters: a ranking of `A, A, B`
 * mentions every proposal, and a set comparison would call it complete while
 * the page showed one vendor twice.
 */
export function rankedResponseIdsOf(ranking: unknown): string[] | null {
  if (!Array.isArray(ranking)) return null;
  const ids: string[] = [];
  for (const entry of ranking) {
    const id = (entry as { response_id?: unknown } | null)?.response_id;
    if (typeof id !== "string" || ids.includes(id)) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * Whether a ranking is exactly one entry per scored proposal — the shape the
 * compare route asks the model for, checked before the row is saved so that
 * a duplicated or invented vendor never reaches the screens. Model JSON is
 * stored as emitted, so this is the only place its shape is enforced.
 */
export function rankingDescribesField(
  ranking: unknown,
  evaluatedResponseIds: string[]
): boolean {
  const ids = rankedResponseIdsOf(ranking);
  return ids != null && sameSet(ids, evaluatedResponseIds);
}

/**
 * Read `comparisons.evaluation_revisions` as the map it is meant to be.
 *
 * Written by the compare route, so its shape is dependable in a way the
 * model-emitted `ranking` is not — but it is still jsonb, and anything that is
 * not an object of string-or-null values reads as "does not say", which the
 * stage reports as needing a re-rank rather than as decided.
 */
export function evaluationRevisionsOf(
  value: unknown
): Record<string, string | null> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, string | null> = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (at !== null && typeof at !== "string") return null;
    out[id] = at;
  }
  return out;
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
