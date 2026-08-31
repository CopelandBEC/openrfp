import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createAIClient,
  getModelId,
  truncateForModel,
} from "@/lib/ai/client";
import {
  buildRubricPrompt,
  PROMPT_VERSION,
} from "@/lib/prompts/generate-rubric";
import { rateLimitResponse, reserveAICall } from "@/lib/rate-limit";

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

  const { rfp_id } = await request.json();

  if (!rfp_id) {
    return NextResponse.json({ error: "RFP ID required" }, { status: 400 });
  }

  // Fetch RFP
  const { data: rfp, error: rfpError } = await supabase
    .from("rfps")
    .select("id, rfp_text, title, owner_id")
    .eq("id", rfp_id)
    .single();

  if (rfpError || !rfp || rfp.owner_id !== user.id) {
    return NextResponse.json({ error: "RFP not found" }, { status: 404 });
  }

  if (!rfp.rfp_text || rfp.rfp_text.length < 100) {
    return NextResponse.json(
      {
        error:
          "RFP text could not be extracted. The PDF may need to be OCR'd first.",
      },
      { status: 400 }
    );
  }

  const rateLimit = await reserveAICall(supabase, user.id, "generate_rubric");
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  // Call AI to generate rubric
  const client = createAIClient();
  const model = getModelId();
  const { text: rfpText, truncated } = truncateForModel(rfp.rfp_text);
  const { system, user: userPrompt } = buildRubricPrompt(rfpText);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return NextResponse.json(
        { error: "AI returned no content" },
        { status: 500 }
      );
    }

    const rubric = JSON.parse(content);

    // Save rubric to database
    const { data: savedRubric, error: rubricError } = await supabase
      .from("rubrics")
      .upsert(
        {
          rfp_id: rfp.id,
          criteria: rubric,
          ai_generated: true,
          edited_by_user: false,
          locked: false,
        },
        { onConflict: "rfp_id" }
      )
      .select()
      .single();

    if (rubricError) {
      return NextResponse.json(
        { error: "Failed to save rubric" },
        { status: 500 }
      );
    }

    // Update RFP status
    await supabase
      .from("rfps")
      .update({ status: "rubric_ready" })
      .eq("id", rfp.id);

    // Audit log
    await supabase.from("audit_log").insert({
      rfp_id: rfp.id,
      user_id: user.id,
      action: "generate_rubric",
      details: { model, prompt_version: PROMPT_VERSION, truncated },
    });

    return NextResponse.json({ rubric: savedRubric });
  } catch (error) {
    console.error("Rubric generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate rubric. Please try again." },
      { status: 500 }
    );
  }
}
