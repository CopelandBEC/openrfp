import OpenAI from "openai";

export interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL: string;
}

export function getAIConfig(): AIConfig {
  return {
    provider: process.env.AI_PROVIDER || "fireworks",
    model: process.env.AI_MODEL || "accounts/fireworks/models/kimi-k3",
    apiKey: process.env.FIREWORKS_API_KEY || process.env.AI_API_KEY || "",
    baseURL: process.env.AI_BASE_URL || "https://api.fireworks.ai/inference/v1",
  };
}

export function createAIClient(): OpenAI {
  const config = getAIConfig();
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

export function getModelId(): string {
  return getAIConfig().model;
}

/**
 * Completion budget for the structured-output calls.
 *
 * The default model reasons before it answers, and on some prompts that
 * reasoning lands in `content` rather than in a separate field. A 4k budget
 * was exhausted mid-thought on a two-page RFP, so the JSON never started and
 * every rubric request failed. Reasoning plus a full rubric measured about
 * 4.5k tokens; this leaves headroom for longer documents and is bounded by
 * the model, not by us.
 */
export function getMaxCompletionTokens(): number {
  const raw = process.env.AI_MAX_COMPLETION_TOKENS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16_000;
}

/**
 * Parse the model's JSON answer, tolerating reasoning text around it.
 *
 * `response_format: json_object` is a request, not a guarantee: a reasoning
 * model may prefix its answer with prose. If the whole string is not JSON,
 * take the outermost `{ … }` and try that. Anything else is a real failure
 * and throws, with the start of the content in the message for the log.
 */
// Defaults to `any` to match JSON.parse, which is what every call site used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseModelJson<T = any>(content: string): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1)) as T;
      } catch {
        // fall through to the descriptive error below
      }
    }
    throw new Error(
      `Model returned non-JSON content (${content.length} chars): ` +
        JSON.stringify(content.slice(0, 120))
    );
  }
}

/**
 * Cap on extracted document text sent to the model in a single call.
 *
 * The default model has a very large context window, but AI_MODEL is meant to
 * be swapped freely — an unbounded document would fail hard against a smaller
 * one. Truncating degrades the evaluation; silently exceeding the window
 * breaks it.
 */
export function getMaxDocChars(): number {
  const raw = process.env.AI_MAX_DOC_CHARS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 400_000;
}

/** Truncate document text to the configured cap, flagging that it happened. */
export function truncateForModel(text: string): {
  text: string;
  truncated: boolean;
} {
  const max = getMaxDocChars();
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      text.slice(0, max) +
      "\n\n[Document truncated — exceeded the configured length limit.]",
    truncated: true,
  };
}
