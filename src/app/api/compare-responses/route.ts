import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  cacheAffinityOptions,
  createAIClient,
  getMaxCompletionTokens,
  getModelId,
  getReasoningEffort,
  parseModelJson,
} from "@/lib/ai/client";
import {
  buildComparisonPrompt,
  PROMPT_VERSION,
} from "@/lib/prompts/compare-responses";
import { rateLimitResponse, reserveAICall } from "@/lib/rate-limit";
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
      "id, response_id, rfp_id, scores, overall_score, summary, strengths, weaknesses, model_used"
    )
    .eq("rfp_id", rfp_id);

  if (evalError || !evaluations || evaluations.length === 0) {
    return NextResponse.json(
      { error: "No evaluations found. Evaluate responses first." },
      { status: 400 }
    );
  }

  // Fetch rubric
  const { data: rubric } = await supabase
    .from("rubrics")
    .select("criteria")
    .eq("rfp_id", rfp_id)
    .single();

  if (!rubric) {
    return NextResponse.json(
      { error: "No rubric found" },
      { status: 400 }
    );
  }

  // Fetch vendor names for each response
  const responseIds = evaluations.map((e: EvaluationRow) => e.response_id);
  const { data: responses } = await supabase
    .from("responses")
    .select("id, vendor_name")
    .in("id", responseIds);

  const vendorMap = new Map<string, string>(
    (responses || []).map((r: ResponseRow) => [r.id, r.vendor_name])
  );

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
        prompt_cache_key: rfp_id,
      },
      cacheAffinityOptions(rfp_id)
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("AI returned no content");
    }

    const comparison = parseModelJson(content);

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
          prompt_version: PROMPT_VERSION,
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
