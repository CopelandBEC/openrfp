import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/** Link shapes Supabase can send here, depending on the email template. */
const OTP_TYPES: readonly EmailOtpType[] = [
  "magiclink",
  "signup",
  "invite",
  "recovery",
  "email",
  "email_change",
];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Only accept a same-origin path. A leading "//" or a scheme would let a
  // crafted link bounce the user off-site after a successful sign-in.
  const requestedNext = searchParams.get("next");
  const next =
    requestedNext &&
    requestedNext.startsWith("/") &&
    !requestedNext.startsWith("//")
      ? requestedNext
      : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("Auth callback: code exchange failed:", error.message);
    return NextResponse.redirect(`${origin}/login?error=auth`);
  }

  // Templates that use {{ .TokenHash }} rather than {{ .ConfirmationURL }}
  // land here instead. The "save my work" flow depends on this path: the
  // default Change Email Address template is one of them, and without it a
  // guest could confirm their address and still not be converted.
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (tokenHash && isOtpType(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("Auth callback: OTP verification failed:", error.message);
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
