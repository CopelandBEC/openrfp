import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { GuestBanner } from "@/components/guest-banner";
import { isGuest } from "@/lib/auth/guest";

/**
 * Auth gate for every authenticated screen.
 *
 * The proxy does an optimistic redirect so signed-out visitors don't render a
 * broken shell, but that check reads a cookie and is not by itself an
 * authorization boundary. This layout is: it verifies the session against the
 * auth server before any child renders. It also forces these routes to be
 * server-rendered on demand — /rfp/new was previously prerendered as a static,
 * publicly reachable page.
 *
 * "Signed in" here includes guests. A guest holds a genuine Supabase session,
 * so every RLS policy applies to them exactly as it does to a member; what
 * they lack is an email, and with it any way back to this work later. Hence
 * the banner.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <>
      {isGuest(user) && <GuestBanner />}
      {children}
    </>
  );
}
