import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Actions that spend money on the AI provider. */
export type AIAction =
  | "generate_rubric"
  | "evaluate_response"
  | "compare_responses";

/**
 * Optional app-side cap on AI calls per caller per rolling hour.
 *
 * This is only ever a TIGHTENING of the limits held in `public.ai_limits`;
 * `reserve_ai_call` takes the stricter of the two. The database has to be the
 * authority because the reservation function is reachable over PostgREST by
 * any signed-in caller, so a limit travelling from here could otherwise be
 * replayed with a larger number. Set AI_RATE_LIMIT_PER_HOUR=0 to defer
 * entirely to the database.
 */
export function getHourlyLimit(): number {
  const raw = process.env.AI_RATE_LIMIT_PER_HOUR;
  if (raw === undefined || raw === "") return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Which ceiling was hit: the caller's own, or the per-IP guest ceiling. */
  scope: "user" | "ip" | "guest" | "member";
  limit: number;
  used: number;
  retryAfterSeconds: number;
}

interface ReserveResponse {
  allowed: boolean;
  scope: RateLimitResult["scope"];
  limit: number;
  used: number;
  retry_after_seconds: number;
}

/**
 * Reserve one AI call for the caller, or report that they are over the limit.
 *
 * The count and the insert happen together inside `public.reserve_ai_call`,
 * behind an advisory lock, so a burst of concurrent requests cannot each read
 * the same under-limit count and all proceed. The caller is identified by
 * auth.uid() inside that function rather than by an argument, so a user id
 * cannot be supplied from outside.
 */
export async function reserveAICall(
  supabase: SupabaseClient,
  action: AIAction,
  options: { ipHash?: string | null } = {}
): Promise<RateLimitResult> {
  const clientLimit = getHourlyLimit();

  const { data, error } = await supabase.rpc("reserve_ai_call", {
    p_action: action,
    p_ip_hash: options.ipHash ?? null,
    p_client_limit: clientLimit > 0 ? clientLimit : null,
  });

  if (error || !data) {
    // Fail open. A failure here means the database is unhealthy, in which case
    // the route is about to fail on its own writes anyway — it is not an abuse
    // vector, and blocking legitimate users on it trades a real outage for a
    // hypothetical one.
    console.error("Rate limit reservation failed:", error?.message);
    return {
      allowed: true,
      scope: "user",
      limit: clientLimit,
      used: 0,
      retryAfterSeconds: 0,
    };
  }

  const result = data as ReserveResponse;

  return {
    allowed: result.allowed,
    scope: result.scope,
    limit: result.limit,
    used: result.used,
    retryAfterSeconds: result.retry_after_seconds,
  };
}

/** Standard 429 for a caller who is over their hourly AI budget. */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  const wait = `Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;

  // The per-IP ceiling counts calls across every guest session from one
  // address, so "you've used all N of yours" would be wrong and confusing —
  // this caller may have made none of them.
  const error =
    result.scope === "ip"
      ? `This network has used all ${result.limit} guest evaluations available ` +
        `this hour. Saving your work to an account raises this limit. ${wait}`
      : `You've used all ${result.limit} AI evaluations available this hour. ${wait}`;

  return NextResponse.json(
    { error },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    }
  );
}
