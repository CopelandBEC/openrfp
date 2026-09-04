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
  truncateForModel,
  getServingHost,
} from "@/lib/ai/client";
import {
  buildEvaluationPrompt,
  PROMPT_VERSION,
} from "@/lib/prompts/evaluate-response";
import { rateLimitResponse, reserveAICall } from "@/lib/rate-limit";
import { hashClientIp } from "@/lib/client-ip";

// Model calls routinely run past the platform default; without this the
// function is killed mid-evaluation and the response is left at 'error'.
export const maxDuration = 300;


export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { response_id } = await request.json();

  if (!response_id) {
    return NextResponse.json(
      { error: "Response ID required" },
      { status: 400 }
    );
  }

  // Fetch response with RFP and rubric
  const { data: responseRecord, error: responseError } = await supabase
    .from("responses")
    .select(
      "id, rfp_id, vendor_name, extracted_text, ocr_status, file_path"
    )
    .eq("id", response_id)
    .single();

  if (responseError || !responseRecord) {
    return NextResponse.json({ error: "Response not found" }, { status: 404 });
  }

  // Verify ownership
  const { data: rfp } = await supabase
    .from("rfps")
    .select("owner_id")
    .eq("id", responseRecord.rfp_id)
    .single();

  if (!rfp || rfp.owner_id !== user.id) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  // Fetch rubric
  // `updated_at` is when the criteria last changed; it is stamped onto the
  // evaluation so every screen can tell scores made against this rubric from
  // scores made against an earlier one.
  const { data: rubric } = await supabase
    .from("rubrics")
    .select("criteria, updated_at, edited_by_user")
    .eq("rfp_id", responseRecord.rfp_id)
    .single();

  if (!rubric) {
    return NextResponse.json(
      { error: "No rubric found for this RFP" },
      { status: 400 }
    );
  }
  // Scoring is against a rubric a human has signed off on. Regenerating the
  // rubric resets that, and the screens stop offering scoring until it is
  // accepted again; this is the same rule for any caller.
  if (rubric.edited_by_user !== true) {
    return NextResponse.json(
      { error: "Review and accept the rubric before scoring against it." },
      { status: 409 }
    );
  }

  // Check OCR status
  if (
    !responseRecord.extracted_text ||
    responseRecord.extracted_text.length < 100
  ) {
    return NextResponse.json(
      {
        error:
          "This response has no extractable text. If it is a scanned PDF, it may need to be OCR'd first.",
      },
      { status: 400 }
    );
  }

  const rateLimit = await reserveAICall(supabase, "evaluate_response", {
    ipHash: hashClientIp(request),
  });
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  // Update status to evaluating
  await supabase
    .from("responses")
    .update({ status: "evaluating" })
    .eq("id", response_id);

  // Call AI
  const client = createAIClient();
  const model = getModelId();
  const { text: responseText, truncated } = truncateForModel(
    responseRecord.extracted_text
  );
  const { system, user: userPrompt } = buildEvaluationPrompt(
    JSON.stringify(rubric.criteria),
    responseText,
    responseRecord.vendor_name
  );

  const reasoningEffort = getReasoningEffort("evaluation");
  // Keyed on the RFP, not the response: every proposal under one RFP shares the
  // system-prompt-plus-rubric prefix, so they should share a cache and a replica.
  const cacheKey = responseRecord.rfp_id;

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
        ...promptCacheOptions(cacheKey),
      },
      cacheAffinityOptions(cacheKey)
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("AI returned no content");
    }

    const evaluation = parseModelJson(content);

    // Calculate weighted overall score
    const criteria = rubric.criteria?.criteria || [];
    let totalScore = 0;
    let totalWeight = 0;
    for (const criterion of criteria) {
      const score = evaluation.scores?.[criterion.id];
      if (score) {
        const normalizedScore = (score.score / score.max) * 100;
        totalScore += normalizedScore * criterion.weight;
        totalWeight += criterion.weight;
      }
    }
    const overallScore = totalWeight > 0 ? totalScore / totalWeight : 0;

    // Save evaluation
    const { data: savedEval, error: evalError } = await supabase
      .from("evaluations")
      .upsert(
        {
          response_id: response_id,
          rfp_id: responseRecord.rfp_id,
          scores: evaluation.scores,
          overall_score: overallScore,
          summary: evaluation.overall_summary,
          strengths: evaluation.strengths,
          weaknesses: evaluation.weaknesses,
          model_used: model,
          served_by: getServingHost(),
          prompt_version: PROMPT_VERSION,
          rubric_updated_at: rubric.updated_at,
        },
        { onConflict: "response_id" }
      )
      .select()
      .single();

    if (evalError) {
      throw new Error("Failed to save evaluation");
    }

    // Update response status
    await supabase
      .from("responses")
      .update({ status: "evaluated" })
      .eq("id", response_id);

    // Audit log
    await supabase.from("audit_log").insert({
      rfp_id: responseRecord.rfp_id,
      user_id: user.id,
      action: "evaluate_response",
      details: {
        response_id,
        vendor_name: responseRecord.vendor_name,
        model,
        overall_score: overallScore,
        truncated,
        reasoning_effort: reasoningEffort ?? null,
      },
    });

    return NextResponse.json({ evaluation: savedEval });
  } catch (error) {
    // Update status to error
    await supabase
      .from("responses")
      .update({ status: "error" })
      .eq("id", response_id);

    console.error("Evaluation error:", error);
    return NextResponse.json(
      { error: "Failed to evaluate response. Please try again." },
      { status: 500 }
    );
  }
}
