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
