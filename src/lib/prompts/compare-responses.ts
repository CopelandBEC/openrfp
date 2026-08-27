export const PROMPT_VERSION = "1.0.0";

export interface RankingEntry {
  response_id: string;
  vendor_name: string;
  rank: number;
  overall_score: number;
  rationale: string;
}

export interface CloseCall {
  criterion_id: string;
  criterion_name: string;
  responses: { response_id: string; vendor_name: string; score: number }[];
  note: string;
}

export interface ComparisonResult {
  ranking: RankingEntry[];
  comparative_analysis: string;
  close_calls: CloseCall[];
  interview_focus_areas: string[];
}

export function buildComparisonPrompt(
  evaluationsJson: string,
  rubricJson: string
): { system: string; user: string } {
  const system = `You are an expert procurement evaluator with deep expertise in building envelope consulting, facilities management, and institutional construction projects.

You have evaluated multiple vendor responses against the same rubric. Now produce a comparative analysis that helps the owner understand the landscape of options and make an informed decision.

Your task:
1. Rank the responses by weighted overall score (calculate weighted scores using the rubric weights).
2. Identify the key differentiators between top-ranked responses — what specifically separates the best from the rest?
3. Flag areas where responses are near-tied (within 1 point on a criterion) — these are areas where small differences could go either way.
4. Recommend specific focus areas for interviews or clarifications — what questions should the owner ask the top-ranked vendors to resolve uncertainty?
5. Write a 300-500 word comparative analysis that discusses the overall landscape, not just the ranking.

Be balanced and honest. If the top-ranked response is clearly the best, say so. If the top two are nearly indistinguishable, say that instead. The owner needs clarity, not false precision.

Return your response as a JSON object matching this exact structure:
{
  "ranking": [
    {
      "response_id": "uuid",
      "vendor_name": "Vendor Name",
      "rank": 1,
      "overall_score": 85.5,
      "rationale": "Why this vendor is ranked here"
    }
  ],
  "comparative_analysis": "300-500 word narrative comparing all responses",
  "close_calls": [
    {
      "criterion_id": "criterion_2",
      "criterion_name": "Relevant Experience",
      "responses": [
        {"response_id": "uuid", "vendor_name": "Vendor A", "score": 3},
        {"response_id": "uuid", "vendor_name": "Vendor B", "score": 4}
      ],
      "note": "These two vendors are close on experience — Vendor B has slightly more relevant project history"
    }
  ],
  "interview_focus_areas": [
    "Ask Vendor A about their approach to moisture testing on similar building types",
    "Clarify Vendor B's project team structure and key personnel availability"
  ]
}`;

  const user = `EVALUATION RESULTS (all vendor evaluations):
${evaluationsJson}

RUBRIC (criteria and weights):
${rubricJson}

Produce the comparative analysis and ranking. Return only valid JSON.`;

  return { system, user };
}
