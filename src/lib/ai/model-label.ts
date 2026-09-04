/**
 * How a model is named to the owner, and where their documents went.
 *
 * `model_used` is stored as the provider's raw id, and the id
 * `accounts/fireworks/models/kimi-k3` answers a question nobody asked and
 * skips the one they do: whose servers read the proposals. The answer is that
 * Kimi K3 is an open-weight model that Fireworks AI, a US company, runs on its
 * own US servers, without retaining prompts or outputs or using them for
 * training; the model's developer never receives anything. That is worth
 * saying wherever the model is named, because a bidding vendor's proposal is
 * commercially sensitive and "a Chinese model" is the reading it would
 * otherwise get.
 *
 * Client-safe: no SDK import, so the pages and the exported report can use it.
 * Sources: Fireworks' privacy policy ("we have servers for the Service in the
 * US") and data-handling guide (no logging of prompts or generations without
 * opt-in; no training on inputs without opt-in).
 */

export interface ModelDescription {
  /** Short display name, e.g. "Kimi K3". */
  name: string;
  /** One clause on where it ran, for a footer or a meta line. */
  hosting: string;
  /** A sentence or two on provenance, for a details panel. */
  provenance: string;
}

const FIREWORKS_PREFIX = "accounts/fireworks/models/";

const FIREWORKS_HOSTING = "run on Fireworks AI's US servers";

const FIREWORKS_PROVENANCE =
  "Served by Fireworks AI, a US company, from its US servers. Fireworks does " +
  "not store prompts or outputs and does not use them for training.";

/** Names for ids the app has shipped with; anything else is derived. */
const KNOWN: Record<string, { name: string; developer: string }> = {
  "kimi-k3": { name: "Kimi K3", developer: "Moonshot AI" },
  "gpt-oss-120b": { name: "gpt-oss-120b", developer: "OpenAI" },
  "nemotron-3-ultra-nvfp4": { name: "Nemotron 3 Ultra", developer: "NVIDIA" },
};

export function describeModel(modelId: string): ModelDescription {
  if (modelId.startsWith(FIREWORKS_PREFIX)) {
    const slug = modelId.slice(FIREWORKS_PREFIX.length);
    const known = KNOWN[slug];
    const name = known?.name ?? slug;
    const openWeight = known
      ? ` An open-weight model developed by ${known.developer}; the developer never receives your documents.`
      : "";
    return {
      name,
      hosting: FIREWORKS_HOSTING,
      provenance: `${FIREWORKS_PROVENANCE}${openWeight}`,
    };
  }
  // Another endpoint entirely: say only what is known, which is the id.
  return { name: modelId, hosting: "", provenance: "" };
}

/** "Kimi K3, run on Fireworks AI's US servers" — or just the name. */
export function modelLabel(modelId: string): string {
  const { name, hosting } = describeModel(modelId);
  return hosting ? `${name}, ${hosting}` : name;
}
