import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Actions that spend money on the AI provider. */
export type AIAction =
  | "generate_rubric"
  | "evaluate_response"
  | "compare_responses";

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Per-user cap on AI calls per rolling hour. The API key is held server-side
 * and signup is self-serve, so without this any account can spend the
 * project's provider budget. Set AI_RATE_LIMIT_PER_HOUR=0 to disable.
 */
export function getHourlyLimit(): number {
  const raw = process.env.AI_RATE_LIMIT_PER_HOUR;
  if (raw === undefined || raw === "") return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  used: number;
  retryAfterSeconds: number;
}

/**
 * Reserve one AI call for this user, or report that they're over the limit.
 *
 * The reservation row is written before the model call rather than after, so
 * two requests racing contend over an INSERT instead of over the many seconds
 * an evaluation takes. This is a spend guard, not a security control: without
 * row locking a small burst can still slip through, which is an acceptable
 * trade for keeping the check to one round trip.
 */
export async function reserveAICall(
  supabase: SupabaseClient,
  userId: string,
  action: AIAction
): Promise<RateLimitResult> {
  const limit = getHourlyLimit();
  if (limit === 0) {
    return { allowed: true, limit, used: 0, retryAfterSeconds: 0 };
  }

  const windowStart = new Date(Date.now() - WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("ai_usage")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true });

  if (error) {
    // Fail open. A read failure here means the database is unhealthy, in which
    // case the route is about to fail on its own writes anyway — it is not an
    // abuse vector, and blocking legitimate users on it trades a real outage
    // for a hypothetical one.
    console.error("Rate limit check failed:", error.message);
    return { allowed: true, limit, used: 0, retryAfterSeconds: 0 };
  }

  const used = data?.length ?? 0;

  if (used >= limit) {
    const oldest = new Date(data[0].created_at).getTime();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + WINDOW_MS - Date.now()) / 1000)
    );
    return { allowed: false, limit, used, retryAfterSeconds };
  }

  const { error: insertError } = await supabase
    .from("ai_usage")
    .insert({ user_id: userId, action });

  if (insertError) {
    console.error("Rate limit reservation failed:", insertError.message);
  }

  return { allowed: true, limit, used: used + 1, retryAfterSeconds: 0 };
}

/** Standard 429 for a caller who is over their hourly AI budget. */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const minutes = Math.ceil(result.retryAfterSeconds / 60);
  return NextResponse.json(
    {
      error:
        `You've used all ${result.limit} AI evaluations available this hour. ` +
        `Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    },
    {
      status: 429,
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    }
  );
}
