"use client";

import { useState } from "react";
import Link from "next/link";
import { SaveToAccountForm } from "@/components/save-to-account";

/**
 * Standing reminder, on every signed-in screen, that a guest's work is not yet
 * durable — and the one-step way to make it so.
 *
 * Rendered from the (app) layout rather than per page so the offer follows the
 * visitor through the whole flow, and appears at the moment it matters most:
 * once they are looking at results worth keeping.
 */
export function GuestBanner() {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-primary/30 bg-primary/5">
      <div className="container mx-auto px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-foreground">
            <span className="font-medium">You&apos;re working as a guest.</span>{" "}
            <span className="text-muted-foreground">
              Your evaluations live in this browser session only — add an email
              to keep them.
            </span>
          </p>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 self-start rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground sm:self-auto"
            aria-expanded={open}
          >
            {open ? "Not now" : "Save to an account"}
          </button>
        </div>

        {open && (
          <div className="mt-3 max-w-xl space-y-2">
            <SaveToAccountForm />
            <p className="text-xs text-muted-foreground">
              No password to set — we email you a link. Already have an account?{" "}
              <Link href="/login" className="underline underline-offset-2">
                Sign in
              </Link>{" "}
              (this guest work won&apos;t carry over).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
