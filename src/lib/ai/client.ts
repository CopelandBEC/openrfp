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
