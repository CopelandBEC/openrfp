import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
