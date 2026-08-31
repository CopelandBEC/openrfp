import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth gate for every authenticated screen.
 *
 * The proxy does an optimistic redirect so signed-out visitors don't render a
 * broken shell, but that check reads a cookie and is not by itself an
 * authorization boundary. This layout is: it verifies the session against the
 * auth server before any child renders. It also forces these routes to be
 * server-rendered on demand — /rfp/new was previously prerendered as a static,
 * publicly reachable page.
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

  return <>{children}</>;
}
