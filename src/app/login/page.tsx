import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">OpenRFP</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to evaluate RFP responses
          </p>
        </div>

        <form
          action={async (formData: FormData) => {
            "use server";
            const email = formData.get("email") as string;
            const password = formData.get("password") as string;
            const supabase = await createClient();
            const { error } = await supabase.auth.signInWithPassword({
              email,
              password,
            });
            if (error) {
              redirect("/login?error=1");
            }
            redirect("/dashboard");
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="you@institution.org"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Sign in
          </button>
        </form>

        <div className="space-y-3">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                Or
              </span>
            </div>
          </div>

          <form
            action={async (formData: FormData) => {
              "use server";
              const email = formData.get("email") as string;
              const supabase = await createClient();
              const { error } = await supabase.auth.signInWithOtp({
                email,
                options: {
                  emailRedirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
                },
              });
              if (error) {
                redirect("/login?error=2");
              }
              redirect("/login?sent=1");
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <label htmlFor="magic-email" className="text-sm font-medium">
                Sign in with a magic link
              </label>
              <input
                id="magic-email"
                name="email"
                type="email"
                required
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder="you@institution.org"
              />
            </div>
            <button
              type="submit"
              className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Send magic link
            </button>
          </form>
        </div>

        <div className="text-center">
          <span className="text-sm text-muted-foreground">
            New here? Use the magic link to sign up instantly — no separate
            registration needed.
          </span>
        </div>
      </div>
    </div>
  );
}
