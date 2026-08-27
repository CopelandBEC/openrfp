export const PROMPT_VERSION = "1.0.0";

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoring_scale: string;
  scale_descriptions: Record<string, string>;
}

export interface Rubric {
  criteria: RubricCriterion[];
  total_weight: number;
}

export function buildRubricPrompt(rfpText: string): {
  system: string;
  user: string;
} {
  const system = `You are an expert procurement evaluator with deep expertise in building envelope consulting, facilities management, and institutional construction projects (higher education, K-12, municipal, and private institutions).

You understand what distinguishes a strong building envelope proposal from a weak one — technical rigor in moisture management, enclosure assembly design, testing protocols (ASTM, AAMA, WUFI), field quality control, experience with similar building types and climates, and the ability to communicate complex enclosure concepts to non-technical stakeholders.

Your task: given an RFP document, generate a set of evaluation criteria that the owner can use to fairly and thoroughly evaluate vendor responses.

Requirements:
1. Generate 4-8 criteria — enough to be thorough, not so many that scoring becomes burdensome.
2. Cover technical competence, relevant experience, project approach, communication, and value (not just lowest price).
3. Each criterion must include a description that explains what is being evaluated and why it matters.
4. Each criterion must include scale descriptions for each score level (e.g., 1 through 5) so scoring is grounded in concrete expectations, not subjective gut feel.
5. Weights must reflect the relative importance implied by the RFP and must sum to exactly 100.
6. Include domain-specific sub-criteria where relevant (e.g., testing protocols, cladding experience, building type experience, climate zone familiarity).

Return your response as a JSON object matching this exact structure:
{
  "criteria": [
    {
      "id": "criterion_1",
      "name": "Criterion Name",
      "description": "What this criterion evaluates and why it matters",
      "weight": 30,
      "scoring_scale": "1-5",
      "scale_descriptions": {
        "1": "Description of what a score of 1 means",
        "2": "Description of what a score of 2 means",
        "3": "Description of what a score of 3 means",
        "4": "Description of what a score of 4 means",
        "5": "Description of what a score of 5 means"
      }
    }
  ],
  "total_weight": 100
}

Be rigorous. The criteria you generate will directly shape how proposals are evaluated — they should reflect real expertise, not generic procurement boilerplate.`;

  const user = `Here is the RFP document. Generate the evaluation rubric.\n\n---\n\n${rfpText}`;

  return { system, user };
}
