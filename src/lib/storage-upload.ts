import type { SupabaseClient } from "@supabase/supabase-js";
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
  | { ok: false; error: string };

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

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: "application/pdf",
    upsert: false,
  });

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

/** Best-effort removal of an object the caller could not make use of. */
export async function discardDocument(
  supabase: SupabaseClient,
  path: string
): Promise<void> {
  await supabase.storage.from(BUCKET).remove([path]).catch(() => undefined);
}

/**
 * After a request that did not clearly succeed, find out whether a row now
 * references the object before deciding its fate.
 *
 * A request can fail ambiguously: the route inserted the row and the
 * connection dropped before the answer arrived. Deleting the object then
 * leaves a committed row pointing at nothing. So the browser asks the table
 * — its own rows, by path — and only removes the object when no row claims
 * it. Returns the referencing row's id when there is one, so the caller can
 * carry on as if the answer had arrived.
 */
export async function reclaimUnlessReferenced(
  supabase: SupabaseClient,
  ref: { table: "responses" | "rfps"; column: "file_path" | "rfp_file_path" },
  path: string
): Promise<{ referencedId: string | null }> {
  const { data, error } = await supabase
    .from(ref.table)
    .select("id")
    .eq(ref.column, path)
    .maybeSingle();
  if (error) {
    // Cannot tell. Leaving an object is recoverable; deleting a referenced
    // one is not.
    return { referencedId: null };
  }
  if (data?.id) return { referencedId: String(data.id) };
  await discardDocument(supabase, path);
  return { referencedId: null };
}
