import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAIClient, getModelId } from "@/lib/ai/client";
import {
  buildComparisonPrompt,
  PROMPT_VERSION,
} from "@/lib/prompts/compare-responses";

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
  const responseIds = evaluations.map((e: any) => e.response_id);
  const { data: responses } = await supabase
    .from("responses")
    .select("id, vendor_name")
    .in("id", responseIds);

  const vendorMap = new Map(
    (responses || []).map((r: any) => [r.id, r.vendor_name])
  );

  // Build evaluations JSON with vendor names
  const evaluationsWithVendors = evaluations.map((e: any) => ({
    ...e,
    vendor_name: vendorMap.get(e.response_id) || "Unknown",
  }));

  // Call AI
  const client = createAIClient();
  const model = getModelId();
  const { system, user: userPrompt } = buildComparisonPrompt(
    JSON.stringify(evaluationsWithVendors),
    JSON.stringify(rubric.criteria)
  );

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 6000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("AI returned no content");
    }

    const comparison = JSON.parse(content);

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
      details: { model, evaluation_count: evaluations.length },
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
