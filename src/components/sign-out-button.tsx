"use client";

import { useState, useTransition } from "react";

/**
 * Sign out, with a confirmation step for guests.
 *
 * Signing out of a guest session is destructive in a way signing out of a real
 * account is not: the anonymous user is the only handle on that work, and
 * there is no way back into it afterwards. A member signing out just needs to
 * request another link.
 */
export function SignOutButton({
  isGuest,
  action,
}: {
  isGuest: boolean;
  action: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    if (isGuest && !confirming) {
      setConfirming(true);
      return;
    }
    startTransition(() => action());
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">Discard this guest work?</span>
        <button
          type="button"
          onClick={handleClick}
          disabled={isPending}
          className="font-medium text-destructive hover:underline disabled:opacity-50"
        >
          {isPending ? "Discarding…" : "Discard"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {isGuest ? "Exit guest session" : "Sign out"}
    </button>
  );
}
