"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;

/**
 * Rename an RFP or change its description.
 *
 * Runs with the caller's session, so row-level security decides whether they
 * may touch this row; nothing here needs to check ownership itself.
 */
export async function updateRfp(
  rfpId: string,
  input: { title: string; description: string }
): Promise<ActionResult> {
  const title = input.title.trim();
  const description = input.description.trim();

  if (!title) return { ok: false, error: "A title is required." };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `Title must be ${TITLE_MAX} characters or fewer.` };
  }
  if (description.length > DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `Description must be ${DESCRIPTION_MAX} characters or fewer.`,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rfps")
    .update({ title, description })
    .eq("id", rfpId)
    .select("id");

  if (error) {
    console.error("Failed to update RFP:", error.message);
    return { ok: false, error: "Couldn't save the changes. Please try again." };
  }
  // RLS filters silently: zero rows means this caller doesn't own the RFP.
  if (!data || data.length === 0) {
    return { ok: false, error: "This RFP could not be found." };
  }

  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Delete an RFP with everything under it.
 *
 * Rows cascade from the foreign keys (rubric, responses, evaluations,
 * comparison, audit log). Files do not: Storage is not part of the database
 * cascade, so the RFP document and every response document are removed
 * through the Storage API first. Files go before the row on purpose — if the
 * removal fails the RFP is still there to retry from, rather than the bytes
 * being orphaned under a user id with nothing pointing at them.
 */
export async function deleteRfp(rfpId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: rfp, error: rfpError } = await supabase
    .from("rfps")
    .select("id, rfp_file_path, responses(file_path)")
    .eq("id", rfpId)
    .maybeSingle();

  if (rfpError) {
    console.error("Failed to load RFP for deletion:", rfpError.message);
    return { ok: false, error: "Couldn't delete the RFP. Please try again." };
  }
  if (!rfp) return { ok: false, error: "This RFP could not be found." };

  const paths = [
    rfp.rfp_file_path,
    ...((rfp.responses as { file_path: string | null }[] | null) ?? []).map(
      (r) => r.file_path
    ),
  ].filter((p): p is string => Boolean(p));

  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from("rfp-files")
      .remove(paths);
    if (storageError) {
      console.error("Failed to remove RFP files:", storageError.message);
      return {
        ok: false,
        error: "Couldn't remove the uploaded files. Nothing was deleted — please try again.",
      };
    }
  }

  const { error: deleteError } = await supabase
    .from("rfps")
    .delete()
    .eq("id", rfpId);

  if (deleteError) {
    console.error("Failed to delete RFP:", deleteError.message);
    return {
      ok: false,
      error: "The files were removed but the RFP record could not be deleted. Please try again.",
    };
  }

  revalidatePath("/dashboard");
  return { ok: true };
}
