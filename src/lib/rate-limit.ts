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
 * replayed with a larger number.
 *
 * Unset, empty, 0 or garbage all mean "defer to the database". Defaulting to
 * a number here would silently pin every deployment below whatever an operator
 * later raises `member_hourly_limit` to, which is exactly the confusion the
 * table exists to avoid.
 */
export function getHourlyLimit(): number {
  const raw = process.env.AI_RATE_LIMIT_PER_HOUR;
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export interface RateLimitResult {
  allowed: boolean;
  /**
   * Which ceiling was hit: the caller's own, or the per-IP guest ceiling.
   * "error" means the reservation could not be recorded at all.
   */
  scope: "user" | "ip" | "guest" | "member" | "error";
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
    // Fail closed. This previously allowed the call through on the reasoning
    // that a database failure would sink the request anyway — but that made
    // "make the reservation fail" a way to buy unlimited AI calls, and a caller
    // who could write to ai_usage could arrange exactly that. The spend guard
    // cannot treat its own failure as permission.
    //
    // The cost is small: every one of these routes needs the same database to
    // read the RFP and store the result, so a caller who cannot reserve is
    // almost never a caller who could have completed.
    console.error("Rate limit reservation failed:", error?.message);
    return {
      allowed: false,
      scope: "error",
      limit: clientLimit,
      used: 0,
      retryAfterSeconds: 30,
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

/** Standard refusal for a caller who could not be granted an AI call. */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  // Not a quota refusal — nothing is known about this caller's usage, so any
  // "you've used N of M" wording would be invented.
  if (result.scope === "error") {
    return NextResponse.json(
      {
        error:
          "Couldn't reserve this evaluation just now. Please try again in a moment.",
      },
      {
        status: 503,
        headers: { "Retry-After": String(result.retryAfterSeconds) },
      }
    );
  }

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
