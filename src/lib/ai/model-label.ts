/**
 * How a model is named to the owner, and where their documents went.
 *
 * `model_used` is stored as the provider's raw id, and the id
 * `accounts/fireworks/models/kimi-k3` answers a question nobody asked and
 * skips the one they do: who read the proposals. The answer is that Kimi K3
 * is an open-weight model served by Fireworks AI, a US company, which does not
 * retain prompts or outputs or use them for training; the model's developer
 * never receives anything. That is worth saying wherever the model is named,
 * because a bidding vendor's proposal is commercially sensitive and "a Chinese
 * model" is the reading it would otherwise get.
 *
 * Deliberately no claim about *where* the servers are. Fireworks' standard
 * serverless tier does not document its routing, and it sells a US-only tier
 * separately, so "US servers" is not a statement this app can stand behind.
 * "A US company" is.
 *
 * The hosting claim is made from `served_by` — the host the route actually
 * called, recorded on the row — and never from the model id. The same
 * `accounts/fireworks/models/...` id routed through a custom gateway ran
 * somewhere else, and a row that did not record its host gets the model's
 * name and no claim.
 *
 * Client-safe: no SDK import, so the pages and the exported report can use it.
 * Source for the retention and training statements: Fireworks' data-handling
 * guide and privacy policy (no logging of prompts or generations, and no
 * training on inputs, without explicit opt-in).
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
const FIREWORKS_HOST = "api.fireworks.ai";

const FIREWORKS_HOSTING = "served by Fireworks AI, a US company";

const FIREWORKS_PROVENANCE =
  "Served by Fireworks AI, a US company. Fireworks does not store prompts or " +
  "outputs and does not use them for training.";

/** Names for ids the app has shipped with; anything else is derived. */
const KNOWN: Record<string, { name: string; developer: string }> = {
  "kimi-k3": { name: "Kimi K3", developer: "Moonshot AI" },
  "gpt-oss-120b": { name: "gpt-oss-120b", developer: "OpenAI" },
  "nemotron-3-ultra-nvfp4": { name: "Nemotron 3 Ultra", developer: "NVIDIA" },
};

/**
 * @param modelId  `model_used` on the row.
 * @param servedBy `served_by` on the row: the host the call went to, or null
 *                 if the row predates recording it.
 */
export function describeModel(
  modelId: string,
  servedBy: string | null | undefined
): ModelDescription {
  // The name is a reading of the id and claims nothing.
  const slug = modelId.startsWith(FIREWORKS_PREFIX)
    ? modelId.slice(FIREWORKS_PREFIX.length)
    : null;
  const known = slug ? KNOWN[slug] : undefined;
  const name = known?.name ?? slug ?? modelId;

  // The hosting is a fact about the row, and only the row can supply it.
  if (servedBy !== FIREWORKS_HOST) {
    return { name, hosting: "", provenance: "" };
  }
  const openWeight = known
    ? ` An open-weight model developed by ${known.developer}; the developer never receives your documents.`
    : "";
  return {
    name,
    hosting: FIREWORKS_HOSTING,
    provenance: `${FIREWORKS_PROVENANCE}${openWeight}`,
  };
}

/** "Kimi K3, served by Fireworks AI, a US company" — or just the name. */
export function modelLabel(
  modelId: string,
  servedBy: string | null | undefined
): string {
  const { name, hosting } = describeModel(modelId, servedBy);
  return hosting ? `${name}, ${hosting}` : name;
}
