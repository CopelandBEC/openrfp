import { createHash } from "crypto";
import type { NextRequest } from "next/server";

/**
 * Best-effort client IP, read from the headers the hosting platform sets.
 *
 * Order matters: Vercel's `x-vercel-forwarded-for` and Cloudflare's
 * `cf-connecting-ip` are written by the edge and cannot be spoofed by the
 * caller, so they are preferred over `x-forwarded-for`, whose left-most entry
 * is whatever the client sent.
 */
function getClientIp(request: NextRequest): string | null {
  const trusted =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("cf-connecting-ip");
  if (trusted) return trusted.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Right-most entry is the one appended by the closest proxy.
    const parts = forwarded.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }

  return request.headers.get("x-real-ip")?.trim() ?? null;
}

/**
 * A salted hash of the caller's IP, for the per-IP guest ceiling enforced in
 * `public.reserve_ai_call`. The raw address is never stored or sent to the
 * database — only this digest.
 *
 * Returns null when IP_HASH_SECRET is unset, which disables the per-IP layer.
 * An unsalted hash would be pointless: the whole IPv4 space is small enough to
 * enumerate in seconds, so a digest without a secret is not anonymized at all.
 */
export function hashClientIp(request: NextRequest): string | null {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret) return null;

  const ip = getClientIp(request);
  if (!ip) return null;

  return createHash("sha256").update(`${secret}:${ip}`).digest("hex");
}
