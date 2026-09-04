import type { SupabaseClient } from "@supabase/supabase-js";
import type { StorageError } from "@supabase/storage-js";
import { isStorageDenied } from "@/lib/storage-errors";

/**
 * Put a document into the owner's folder of the `rfp-files` bucket, from the
 * browser.
 *
 * The file used to travel inside the API request and the route stored it. The
 * hosting platform stops any request body at 4.5 MB, before the route runs,
 * and the app promises 25 MB — so every proposal with drawings in it failed
 * with a platform error page the client could not read. Storage has no such
 * limit, the bucket's row-level policies already scope the owner to their own
 * folder (`<user id>/...`), and the routes now take the path and read the
 * object back server-side, where outbound fetches are not capped.
 *
 * The path layout is the one the routes always used, so nothing downstream
 * changes: `<user id>/<rfp id>/<timestamp>-<name>` for a proposal and
 * `<user id>/<timestamp>-<name>` for an RFP.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const BUCKET = "rfp-files";

export type UploadOutcome =
  | { ok: true; path: string }
  /**
   * `orphanPath` is set when the request failed but the object may exist and
   * could not be removed; the caller remembers it so a later visit can settle
   * it. See `rememberPending`.
   */
  | { ok: false; error: string; orphanPath?: string };

export async function uploadDocument(
  supabase: SupabaseClient,
  file: File,
  folder: string | null
): Promise<UploadOutcome> {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "File is too large. Maximum size is 25MB." };
  }
  if (file.type !== "application/pdf") {
    return {
      ok: false,
      error:
        "Only PDF files are supported right now. If you have a Word document, export it to PDF and upload that.",
    };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      error: "Your session has expired. Reload the page and sign in again.",
    };
  }

  const path = [user.id, folder, `${Date.now()}-${file.name}`]
    .filter((part): part is string => !!part)
    .join("/");

  let error: StorageError | null = null;
  try {
    ({ error } = await supabase.storage.from(BUCKET).upload(path, file, {
      contentType: "application/pdf",
      upsert: false,
    }));
  } catch (thrown) {
    // The request itself failed — but the server may have accepted the object
    // before the connection dropped. Nothing references it yet, so remove it
    // if it is there; removing what is not there is harmless. If even that
    // fails (connectivity is probably still down) the path goes back to the
    // caller to remember.
    const removed = await discardDocument(supabase, path);
    return {
      ok: false,
      error: `Failed to upload file: ${
        thrown instanceof Error ? thrown.message : "the connection dropped"
      }`,
      ...(removed ? {} : { orphanPath: path }),
    };
  }

  if (error) {
    // A guest at their file cap is refused by the storage insert policy. That
    // is a limit, not a fault, and it deserves an explanation.
    if (user.is_anonymous && isStorageDenied(error)) {
      return {
        ok: false,
        error:
          "Guest sessions are limited to a few uploaded files. Save your work to an account from the banner above to keep going.",
      };
    }
    return { ok: false, error: `Failed to upload file: ${error.message}` };
  }
  return { ok: true, path };
}

/**
 * Remove an object the caller could not make use of. Returns whether the
 * removal is known to have succeeded: a returned error or a thrown request
 * both mean the object may still be there, and callers keep the path until
 * a removal is confirmed rather than assume it is gone.
 */
export async function discardDocument(
  supabase: SupabaseClient,
  path: string
): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(BUCKET).remove([path]);
    return !error;
  } catch {
    return false;
  }
}

/**
 * After a request that did not clearly succeed, find out what became of the
 * object before deciding its fate.
 *
 * A request can fail ambiguously: the connection dropped, and the route may
 * have finished, may still be parsing, or may never have been reached. Rows
 * are written only for finished uploads, so a row referencing the path means
 * success, and the caller carries on to it. A claim on the path with no row
 * yet means the route is still working (or was killed and will be taken over
 * by the next attempt); the object must stay. Only when there is neither is
 * the object nobody's, and it is removed. When the tables cannot be read the
 * object is left alone: an orphan is recoverable, a deleted document is not.
 */
export type Reconciliation =
  | { state: "referenced"; id: string }
  | { state: "processing" }
  /** A claim older than a route could still be running: retry the same path. */
  | { state: "stale" }
  | { state: "reclaimed" }
  | { state: "unknown" };

/** Matches `v_stale` in `claim_upload`; a route cannot run this long. */
export const CLAIM_STALE_MS = 3 * 60 * 1000;

export async function reconcileAfterFailure(
  supabase: SupabaseClient,
  ref: { table: "responses" | "rfps"; column: "file_path" | "rfp_file_path" },
  path: string
): Promise<Reconciliation> {
  const row = await supabase
    .from(ref.table)
    .select("id")
    .eq(ref.column, path)
    .maybeSingle();
  if (row.error) return { state: "unknown" };
  if (row.data?.id) return { state: "referenced", id: String(row.data.id) };

  const claim = await supabase
    .from("upload_claims")
    .select("claimed_at, completed_at")
    .eq("path", path)
    .maybeSingle();
  if (claim.error) return { state: "unknown" };
  if (claim.data?.completed_at) {
    // Processed, and its row since deleted by its owner (the delete removes
    // the object too). Nothing to wait for and nothing to reclaim.
    return { state: "reclaimed" };
  }
  if (claim.data) {
    const claimedAt = Date.parse(String(claim.data.claimed_at));
    // A claim this old with no row was left by a killed function. Posting the
    // same path again takes it over and finishes the job; a fresh upload
    // would leave this object and claim behind for good.
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt > CLAIM_STALE_MS) {
      return { state: "stale" };
    }
    return { state: "processing" };
  }

  // Only a confirmed removal is "reclaimed"; otherwise the caller keeps the
  // path and tries again later.
  return (await discardDocument(supabase, path))
    ? { state: "reclaimed" }
    : { state: "unknown" };
}

/**
 * Wait for an in-flight upload to resolve one way or the other.
 *
 * A route killed at its maximum duration leaves a claim that reads as
 * "processing" until the lease expires, so an immediate reconcile cannot tell
 * a slow parse from a dead one. This polls until a row appears (success), the
 * claim is gone with no row (the route gave up and removed the object), or the
 * claim goes stale (retry the same path). It gives up after the lease plus a
 * margin, which a route cannot outlive.
 */
export async function waitForUpload(
  supabase: SupabaseClient,
  ref: { table: "responses" | "rfps"; column: "file_path" | "rfp_file_path" },
  path: string,
  onTick?: (elapsedMs: number) => void
): Promise<Reconciliation> {
  const started = Date.now();
  const deadline = started + CLAIM_STALE_MS + 15_000;
  for (;;) {
    const outcome = await reconcileAfterFailure(supabase, ref, path);
    if (outcome.state !== "processing") return outcome;
    if (Date.now() > deadline) return { state: "stale" };
    onTick?.(Date.now() - started);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/**
 * Remember an upload whose outcome is not yet known, so that if the page is
 * left before it resolves the same path is retried rather than a fresh
 * upload made — a fresh upload would leave the first object and its claim
 * behind. Per browser, best effort; storage may be unavailable.
 */
export interface PendingUpload {
  path: string;
  startedAt: number;
  fields: Record<string, string>;
}

function pendingKey(scope: string): string {
  return `openrfp:pending-upload:${scope}`;
}

export function rememberPending(scope: string, pending: PendingUpload): void {
  try {
    window.localStorage.setItem(pendingKey(scope), JSON.stringify(pending));
  } catch {
    // Nothing to do; the in-session flow still works.
  }
}

export function forgetPending(scope: string): void {
  try {
    window.localStorage.removeItem(pendingKey(scope));
  } catch {
    // ignore
  }
}

export function readPending(scope: string): PendingUpload | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingUpload;
    if (typeof parsed?.path !== "string" || typeof parsed?.startedAt !== "number") {
      return null;
    }
    // No age cutoff: however old, the remembered path is settled by asking
    // the tables. Past the claims sweep it finds no claim and no row, and
    // the object is reclaimed — which is exactly what would otherwise be
    // left behind for good.
    return parsed;
  } catch {
    return null;
  }
}
