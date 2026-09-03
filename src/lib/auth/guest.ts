import type { User } from "@supabase/supabase-js";

/**
 * A guest is a Supabase anonymous user: a real row in auth.users with a real
 * JWT, but no email attached yet. Attaching one (see SaveToAccountForm)
 * converts the SAME user id in place, so nothing has to be copied over — the
 * flag below simply stops being true.
 */
export function isGuest(user: User | null | undefined): boolean {
  return Boolean(user?.is_anonymous);
}

/**
 * Cloudflare Turnstile site key, when configured.
 *
 * This is the gate that makes open guest access affordable: without it anyone
 * can mint unlimited anonymous sessions, and each session carries its own
 * allowance of calls against the server-held AI key. Supabase verifies the
 * token at its auth endpoint, so the check holds even against a caller who
 * skips this UI entirely.
 *
 * Unset in local development, where the extra round trip is just friction.
 */
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
