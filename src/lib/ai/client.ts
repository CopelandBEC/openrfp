import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";

export interface AIConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseURL: string;
}

const DEFAULT_MODEL = "accounts/fireworks/models/kimi-k3";
const DEFAULT_BASE_URL = "https://api.fireworks.ai/inference/v1";

export function getAIConfig(): AIConfig {
  return {
    provider: process.env.AI_PROVIDER || "fireworks",
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    apiKey: process.env.FIREWORKS_API_KEY || process.env.AI_API_KEY || "",
    baseURL: process.env.AI_BASE_URL || DEFAULT_BASE_URL,
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

/** The three structured-output call sites, which want different tuning. */
export type AITask = "rubric" | "evaluation" | "comparison";

const REASONING_EFFORT_DEFAULTS: Record<AITask, string> = {
  // Drafting criteria from a bare RFP is the one call worth thinking hard about.
  rubric: "high",
  // Scoring against a rubric that already exists is not.
  evaluation: "low",
  // One call per RFP over the finished evaluations, and the ranking is what the
  // owner acts on — small input, so thinking hard here costs little wall clock.
  comparison: "high",
};

/**
 * How hard the model should think before it answers, per call site.
 *
 * The default model reasons first and its own default effort is the maximum —
 * thousands of tokens of thought before the JSON starts, which is the latency
 * described on `getMaxCompletionTokens` below. Left unset, every call paid for
 * that, including the ones that are just applying an existing rubric.
 *
 * The defaults were tuned for the default model and are applied only to it.
 * Not every model accepts this parameter — an OpenAI-compatible endpoint that
 * does not rejects the whole request — and AI_MODEL is meant to be swapped
 * freely, so a deployment that has set it keeps working as it did: nothing is
 * sent unless the matching AI_REASONING_EFFORT_* variable says what to send.
 * A value is sent as given, so a model with its own vocabulary of effort levels
 * needs no code change here; an empty string omits the parameter for the
 * default model too.
 */
export function getReasoningEffort(task: AITask): ReasoningEffort | undefined {
  const raw =
    task === "rubric"
      ? process.env.AI_REASONING_EFFORT_RUBRIC
      : task === "evaluation"
        ? process.env.AI_REASONING_EFFORT_EVALUATION
        : process.env.AI_REASONING_EFFORT_COMPARISON;
  const fallback =
    getModelId() === DEFAULT_MODEL ? REASONING_EFFORT_DEFAULTS[task] : "";
  const value = (raw ?? fallback).trim();
  return value === "" ? undefined : (value as ReasoningEffort);
}

/**
 * The request-body half of the prompt-cache hint: names the cache entry.
 *
 * Sent only to the default endpoint. A body field is not a header — a strict
 * OpenAI-compatible endpoint that does not implement `prompt_cache_key`
 * rejects the whole request rather than ignoring it, and AI_BASE_URL is meant
 * to be pointed anywhere. A deployment that has pointed it elsewhere keeps
 * working as it did before this branch; it can opt in with
 * AI_PROMPT_CACHE_KEY=1 if its endpoint takes the field.
 */
export function promptCacheOptions(key: string): { prompt_cache_key?: string } {
  const raw = process.env.AI_PROMPT_CACHE_KEY?.trim();
  const enabled =
    raw === undefined || raw === ""
      ? getAIConfig().baseURL === DEFAULT_BASE_URL
      : raw !== "0" && raw.toLowerCase() !== "false";
  return enabled ? { prompt_cache_key: key } : {};
}

/**
 * Per-request options that keep a repeated prompt prefix warm.
 *
 * The provider caches prompt prefixes automatically, but the cache lives on
 * whichever replica served the request. Without an affinity hint the proposals
 * in one RFP scatter across replicas and each re-reads the whole rubric from
 * cold. Keying on the RFP id sends them all to the same place, so the shared
 * system-prompt-plus-rubric prefix is read once.
 *
 * Pair this with `promptCacheOptions` in the request body — the header routes
 * the request, the body field names the cache entry. An unknown header is
 * ignored by any HTTP server, so this half is safe to send anywhere; the body
 * half is not, and is gated.
 *
 * The key is sanitised because it becomes an HTTP header value and, in
 * compare-responses, originates in the request body. Nothing exploitable
 * reaches here today: an id with a newline in it fails the uuid comparison in
 * the ownership check long before this, and undici rejects CRLF in a header
 * value regardless. But both of those are somebody else's guarantee, and the
 * one place that can cheaply not depend on them is here.
 */
export function cacheAffinityOptions(key: string): {
  headers: Record<string, string>;
} {
  const safe = key.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
  // An unusable key is better dropped than sent: affinity is an optimisation,
  // and a partial key would route to the wrong replica rather than no replica.
  return safe.length === key.length && safe.length > 0
    ? { headers: { "x-session-affinity": safe } }
    : { headers: {} };
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
