import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  cacheAffinityOptions,
  promptCacheOptions,
  createAIClient,
  getMaxCompletionTokens,
  getModelId,
  getReasoningEffort,
  parseModelJson,
  getServingHost,
} from "@/lib/ai/client";
import {
  buildComparisonPrompt,
  PROMPT_VERSION,
} from "@/lib/prompts/compare-responses";
import { rateLimitResponse, reserveAICall } from "@/lib/rate-limit";
import { rankingDescribesField, scoredAgainstCurrentRubric } from "@/lib/stage";
import { hashClientIp } from "@/lib/client-ip";

// Model calls routinely run past the platform default; without this the
// function is killed mid-evaluation and the response is left at 'error'.
export const maxDuration = 300;

/** Shape of the `evaluations` select below. */
interface EvaluationRow {
  id: string;
  response_id: string;
  rfp_id: string;
  scores: Record<string, unknown> | null;
  overall_score: number | null;
  summary: string | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  model_used: string | null;
  updated_at: string | null;
  rubric_updated_at: string | null;
}

/** Shape of the `responses` select below. */
interface ResponseRow {
  id: string;
  vendor_name: string;
}


export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { rfp_id } = await request.json();

  if (!rfp_id) {
    return NextResponse.json({ error: "RFP ID required" }, { status: 400 });
  }

  // Verify ownership
  const { data: rfp } = await supabase
    .from("rfps")
    .select("owner_id, status")
    .eq("id", rfp_id)
    .single();

  if (!rfp || rfp.owner_id !== user.id) {
    return NextResponse.json({ error: "RFP not found" }, { status: 404 });
  }

  // Fetch all evaluations for this RFP
  const { data: evaluations, error: evalError } = await supabase
    .from("evaluations")
    .select(
      "id, response_id, rfp_id, scores, overall_score, summary, strengths, weaknesses, model_used, updated_at, rubric_updated_at"
    )
    .eq("rfp_id", rfp_id);

  if (evalError || !evaluations || evaluations.length === 0) {
    return NextResponse.json(
      { error: "No evaluations found. Evaluate responses first." },
      { status: 400 }
    );
  }

  // Exactly which evaluation versions this ranking is built from, saved with
  // it so freshness is judged against what the model saw rather than when
  // the row was written. The model call below takes a while, and an override
  // made in another tab during it changes a row this ranking has already
  // read. Recorded per row rather than as a newest-timestamp watermark: see
  // the column's note in schema.sql.
  const evaluationRevisions: Record<string, string | null> =
    Object.fromEntries(
      (evaluations as EvaluationRow[]).map((e) => [e.response_id, e.updated_at])
    );

  // Fetch rubric
  const { data: rubric } = await supabase
    .from("rubrics")
    .select("criteria, updated_at, edited_by_user")
    .eq("rfp_id", rfp_id)
    .single();

  if (!rubric) {
    return NextResponse.json(
      { error: "No rubric found" },
      { status: 400 }
    );
  }
  // Same rule as scoring: the rubric a ranking is made against has to have
  // been accepted by a human.
  if (rubric.edited_by_user !== true) {
    return NextResponse.json(
      { error: "Review and accept the rubric before ranking against it." },
      { status: 409 }
    );
  }

  // Every proposal in the RFP, not just the scored ones: the field the
  // ranking has to describe is all of them.
  const { data: responses, error: responsesError } = await supabase
    .from("responses")
    .select("id, vendor_name")
    .eq("rfp_id", rfp_id);

  // Fail closed. Read as an empty set, a failed lookup would pass the guard
  // below as "nothing unscored" and rank a field of unknown vendors.
  if (responsesError) {
    return NextResponse.json(
      { error: "Failed to load proposals. Please try again." },
      { status: 500 }
    );
  }

  const vendorMap = new Map<string, string>(
    (responses || []).map((r: ResponseRow) => [r.id, r.vendor_name])
  );

  // Refuse a field the ranking could not describe. A proposal not yet scored,
  // or scored against a rubric that has since changed, makes the ranking out
  // of date the moment it is saved — and it costs a model call and a rate
  // limit reservation to produce. The screens guard their buttons the same
  // way; this is the guard that holds whatever the caller is.
  const scoredIds = new Set(
    (evaluations as EvaluationRow[]).map((e) => e.response_id)
  );
  const unscored = ((responses || []) as ResponseRow[]).filter(
    (r) => !scoredIds.has(r.id)
  );
  const staleScores = (evaluations as EvaluationRow[]).filter(
    (e) => !scoredAgainstCurrentRubric(e.rubric_updated_at, rubric.updated_at)
  );
  if (unscored.length > 0 || staleScores.length > 0) {
    const parts: string[] = [];
    if (unscored.length > 0) {
      parts.push(
        `${unscored.length} proposal${unscored.length === 1 ? " is" : "s are"} not scored yet`
      );
    }
    if (staleScores.length > 0) {
      parts.push(
        `${staleScores.length} ${staleScores.length === 1 ? "was" : "were"} scored against an earlier rubric`
      );
    }
    return NextResponse.json(
      { error: `Score every proposal first: ${parts.join(", and ")}.` },
      { status: 409 }
    );
  }
  // The same threshold the evaluations screen applies before it offers the
  // decision: one proposal is nothing to rank against.
  if (evaluations.length < 2) {
    return NextResponse.json(
      { error: "A ranking needs at least two scored proposals." },
      { status: 409 }
    );
  }

  // Build evaluations JSON with vendor names
  const evaluationsWithVendors = evaluations.map((e: EvaluationRow) => ({
    ...e,
    vendor_name: vendorMap.get(e.response_id) || "Unknown",
  }));

  const rateLimit = await reserveAICall(supabase, "compare_responses", {
    ipHash: hashClientIp(request),
  });
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  // Call AI
  const client = createAIClient();
  const model = getModelId();
  const { system, user: userPrompt } = buildComparisonPrompt(
    JSON.stringify(evaluationsWithVendors),
    JSON.stringify(rubric.criteria)
  );

  const reasoningEffort = getReasoningEffort("comparison");

  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: getMaxCompletionTokens(),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...promptCacheOptions(rfp_id),
      },
      cacheAffinityOptions(rfp_id)
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("AI returned no content");
    }

    const comparison = parseModelJson(content);

    // The model was asked for one entry per proposal. Anything else — a vendor
    // listed twice, one missing, one invented — would render as a ranking and
    // read as decided, so it is refused here rather than repaired downstream.
    if (!rankingDescribesField(comparison.ranking, [...scoredIds])) {
      console.error("Comparison ranking does not match the field", {
        rfp_id,
        ranked: Array.isArray(comparison.ranking)
          ? comparison.ranking.length
          : null,
        scored: scoredIds.size,
      });
      return NextResponse.json(
        {
          error:
            "The model returned a ranking that does not match the proposals. Please try again.",
        },
        { status: 502 }
      );
    }

    // Save comparison
    const { data: savedComparison, error: comparisonError } = await supabase
      .from("comparisons")
      .upsert(
        {
          rfp_id,
          ranking: comparison.ranking,
          comparative_analysis: comparison.comparative_analysis,
          close_calls: comparison.close_calls || [],
          interview_focus_areas: comparison.interview_focus_areas || [],
          model_used: model,
          served_by: getServingHost(),
          prompt_version: PROMPT_VERSION,
          evaluation_revisions: evaluationRevisions,
        },
        { onConflict: "rfp_id" }
      )
      .select()
      .single();

    if (comparisonError) {
      throw new Error("Failed to save comparison");
    }

    // Update RFP status
    await supabase
      .from("rfps")
      .update({ status: "complete" })
      .eq("id", rfp_id);

    // Audit log
    await supabase.from("audit_log").insert({
      rfp_id,
      user_id: user.id,
      action: "compare_responses",
      details: {
        model,
        evaluation_count: evaluations.length,
        reasoning_effort: reasoningEffort ?? null,
      },
    });

    return NextResponse.json({ comparison: savedComparison });
  } catch (error) {
    console.error("Comparison error:", error);
    return NextResponse.json(
      { error: "Failed to generate comparison. Please try again." },
      { status: 500 }
    );
  }
}
