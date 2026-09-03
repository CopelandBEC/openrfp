import type { StorageError } from "@supabase/storage-js";

/**
 * True when Storage refused the object because a row-level security policy on
 * storage.objects said no — for this app, that is a guest at their file cap.
 *
 * storage-js surfaces the HTTP status as a string on StorageApiError and puts
 * Postgres' wording in the message; either is enough on its own, and checking
 * both keeps this stable across storage-js versions.
 */
export function isStorageDenied(error: StorageError): boolean {
  const statusCode = (error as { statusCode?: string | number }).statusCode;
  return (
    String(statusCode) === "403" ||
    /row-level security|not authorized|unauthorized/i.test(error.message)
  );
}
