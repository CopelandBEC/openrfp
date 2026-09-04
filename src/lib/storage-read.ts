import type { SupabaseClient, User } from "@supabase/supabase-js";
import { BUCKET, MAX_UPLOAD_BYTES } from "@/lib/storage-upload";

/**
 * Read back a document the browser put in storage, on the server.
 *
 * The route used to receive the file itself; see `storage-upload.ts` for why
 * it now receives a path. Two steps, because the route claims the path with a
 * row *between* them: the path is checked first, cheaply, so nothing is
 * written for a path that is not the caller's; the download happens only once
 * the row exists, so a second request for the same path is refused by the
 * unique index before any bytes move.
 */
export type PathCheck =
  | { ok: true; fileName: string }
  | { ok: false; status: number; error: string };

/**
 * The path has to sit in the caller's own folder and, for a proposal, in the
 * folder of the RFP it is being attached to, so a path supplied for one RFP
 * cannot attach a file uploaded for another. Traversal is a *segment* of `.`
 * or `..`, not the substring: "bid..final.pdf" is a legitimate name.
 */
export function validateOwnedPath(
  user: User,
  path: unknown,
  expectedFolder: string | null
): PathCheck {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, status: 400, error: "A file path is required." };
  }
  const segments = path.split("/");
  const expected = expectedFolder ? 3 : 2;
  if (
    segments.length !== expected ||
    segments.some((s) => s === "" || s === "." || s === "..") ||
    segments[0] !== user.id ||
    (expectedFolder && segments[1] !== expectedFolder)
  ) {
    return {
      ok: false,
      status: 400,
      error: "That file was not uploaded for this request.",
    };
  }
  return {
    ok: true,
    fileName: segments[segments.length - 1].replace(/^\d+-/, ""),
  };
}

export type DownloadOutcome =
  | { ok: true; bytes: Uint8Array; size: number }
  | { ok: false; status: number; error: string };

/**
 * Size and type are checked again here because the browser's checks are the
 * browser's; the bucket enforces both too, so this is the last line, not the
 * only one.
 */
export async function downloadDocument(
  supabase: SupabaseClient,
  path: string
): Promise<DownloadOutcome> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error || !data) {
    return {
      ok: false,
      status: 404,
      error: "The uploaded file could not be read back. Please try the upload again.",
    };
  }
  if (data.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 400, error: "File too large. Maximum 25MB." };
  }
  if (data.type && data.type !== "application/pdf") {
    return {
      ok: false,
      status: 400,
      error:
        "Only PDF files are supported right now. If you have a Word document, export it to PDF and upload that.",
    };
  }
  return {
    ok: true,
    bytes: new Uint8Array(await data.arrayBuffer()),
    size: data.size,
  };
}

/** Both steps together, for callers that have nothing to do in between. */
export type ReadOutcome =
  | { ok: true; bytes: Uint8Array; fileName: string; size: number }
  | { ok: false; status: number; error: string };

export async function readOwnedDocument(
  supabase: SupabaseClient,
  user: User,
  path: unknown,
  expectedFolder: string | null
): Promise<ReadOutcome> {
  const check = validateOwnedPath(user, path, expectedFolder);
  if (!check.ok) return check;
  const dl = await downloadDocument(supabase, path as string);
  if (!dl.ok) return dl;
  return { ok: true, bytes: dl.bytes, size: dl.size, fileName: check.fileName };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Take, complete or release the claim on a path. See the `upload_claims`
 * section of schema.sql for why claims are separate rows that callers cannot
 * mutate without the token the claim was minted with — the route runs with
 * the caller's own JWT, so the token is what separates the route from a
 * caller reaching for the function directly.
 */
export type Claim =
  | { state: "claimed"; token: string }
  | { state: "busy" }
  | { state: "completed" }
  /** No such object in the caller's folder. */
  | { state: "missing" }
  /** The caller's hourly parsing budget is spent. */
  | { state: "limited"; retryAfterSeconds: number }
  | { state: "error"; error: string };

export async function claimUpload(
  supabase: SupabaseClient,
  path: string,
  ipHash: string | null
): Promise<Claim> {
  const { data, error } = await supabase.rpc("claim_upload", {
    p_path: path,
    p_ip_hash: ipHash,
  });
  if (error) return { state: "error", error: error.message };
  const d = data as {
    state?: unknown;
    token?: unknown;
    retry_after_seconds?: unknown;
  } | null;
  if (d?.state === "claimed" && typeof d.token === "string") {
    return { state: "claimed", token: d.token };
  }
  if (d?.state === "limited") {
    return {
      state: "limited",
      retryAfterSeconds:
        typeof d.retry_after_seconds === "number" ? d.retry_after_seconds : 60,
    };
  }
  if (d?.state === "busy" || d?.state === "completed" || d?.state === "missing") {
    return { state: d.state };
  }
  return { state: "error", error: `unexpected claim state ${JSON.stringify(data)}` };
}

export async function completeUpload(
  supabase: SupabaseClient,
  path: string,
  token: string
): Promise<void> {
  await supabase.rpc("complete_upload", { p_path: path, p_token: token });
}

export async function releaseUpload(
  supabase: SupabaseClient,
  path: string,
  token: string
): Promise<void> {
  await supabase.rpc("release_upload", { p_path: path, p_token: token });
}
