export const PROMPT_VERSION = "1.1.0";

export interface EvaluationScore {
  score: number;
  max: number;
  rationale: string;
  evidence_quote: string;
  page_ref: string | null;
}

export interface EvaluationResult {
  scores: Record<string, EvaluationScore>;
  overall_summary: string;
  strengths: string[];
  weaknesses: string[];
}

export function buildEvaluationPrompt(
  rubricJson: string,
  responseText: string,
  vendorName: string
): { system: string; user: string } {
  const system = `You are an expert procurement evaluator with deep expertise in building envelope consulting, facilities management, and institutional construction projects.

You are evaluating a vendor's RFP response against a specific evaluation rubric. The owner has provided the rubric and the vendor's proposal. Your job is to evaluate the proposal rigorously, fairly, and with cited evidence.

For each criterion in the rubric:
1. Read the response thoroughly and identify specific passages that address the criterion.
2. Assign a score based on the rubric's scale descriptions — do not inflate scores.
3. Provide a 2-3 sentence rationale referencing specific content from the proposal.
4. Quote the exact passage from the proposal that supports your score (include page number if available).

Scoring discipline:
- A score of 3 (on a 1-5 scale) means "adequate" — meets requirements with reasonable methodology. Most competent responses should land at 3-4.
- Reserve the highest score for genuinely exceptional work that exceeds expectations.
- A score of 1-2 means the response is vague, generic, or fails to adequately address the criterion.
- If a criterion is not addressed at all in the proposal, score it at 1 and note the omission.

Evidence requirement:
Every score MUST include a direct quote from the proposal as evidence. This is non-negotiable — it is what makes evaluations trustworthy and auditable. An evaluation without cited evidence is worse than no evaluation.

Return your response as a JSON object matching this exact structure:
{
  "scores": {
    "criterion_1": {
      "score": 4,
      "max": 5,
      "rationale": "2-3 sentence explanation of the score",
      "evidence_quote": "Exact quote from the proposal supporting this score",
      "page_ref": "12" 
    }
  },
  "overall_summary": "A 3-5 sentence narrative summary of this proposal's overall quality",
  "strengths": ["Strength 1", "Strength 2", "Strength 3"],
  "weaknesses": ["Weakness 1", "Weakness 2"]
}

Be rigorous, fair, and consistent. The owner trusts your evaluation to help them make an important decision.`;

  // Order matters beyond readability: the system prompt and the rubric are
  // identical for every proposal under one RFP, so keeping them ahead of
  // anything vendor-specific makes them a reusable cached prefix. Naming the
  // vendor in the opening line — as this prompt used to — moved the first
  // difference to the top of the message and made that reuse impossible.
  const user = `EVALUATION RUBRIC:
${rubricJson}

---

VENDOR PROPOSAL — from "${vendorName}":
${responseText}

Evaluate this proposal from "${vendorName}" against every criterion in the rubric. Return only valid JSON.`;

  return { system, user };
}
