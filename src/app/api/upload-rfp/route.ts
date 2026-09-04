import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import {
  claimUpload,
  completeUpload,
  downloadDocument,
  releaseUpload,
  validateOwnedPath,
} from "@/lib/storage-read";
import { BUCKET } from "@/lib/storage-upload";
import { hashClientIp } from "@/lib/client-ip";

// Parsing a large PDF can outrun the platform default, and the file now
// arrives from storage rather than in the request. Kept below the claim
// functions' 3-minute abandonment threshold.
export const maxDuration = 120;

/**
 * Create an RFP from an uploaded document.
 *
 * The browser has already put the PDF in storage — see lib/storage-upload.ts
 * for why the file no longer travels in this request — and sends its path.
 * Claim, read, parse, write the row with its text, complete the claim; any
 * failure in between releases the claim and removes the object. See
 * upload-response for the reasoning.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    file_path?: unknown;
    title?: unknown;
    description?: unknown;
  } | null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description : "";

  if (!body?.file_path || !title) {
    return NextResponse.json(
      { error: "File and title are required" },
      { status: 400 }
    );
  }

  const check = validateOwnedPath(user, body.file_path, null);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  const fileName = body.file_path as string;

  const claim = await claimUpload(supabase, fileName, hashClientIp(request));
  if (claim.state === "error") {
    console.error("Failed to claim upload:", claim.error);
    return NextResponse.json(
      { error: "Failed to start processing the file. Please try again." },
      { status: 500 }
    );
  }
  if (claim.state === "completed") {
    return NextResponse.json(
      { error: "That file has already been used to create an RFP." },
      { status: 409 }
    );
  }
  if (claim.state === "limited") {
    const minutes = Math.max(1, Math.ceil(claim.retryAfterSeconds / 60));
    return NextResponse.json(
      {
        error: `You've reached this hour's limit on document uploads. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      { status: 429, headers: { "Retry-After": String(claim.retryAfterSeconds) } }
    );
  }
  if (claim.state === "missing") {
    return NextResponse.json(
      { error: "The uploaded file could not be found. Please try the upload again." },
      { status: 404 }
    );
  }
  if (claim.state === "busy") {
    return NextResponse.json(
      {
        error:
          "That file is still being processed, or too many uploads are in progress. Give it a moment.",
      },
      { status: 409 }
    );
  }

  const abandon = async () => {
    await supabase.storage.from(BUCKET).remove([fileName]);
    await releaseUpload(supabase, fileName, claim.token);
  };

  const dl = await downloadDocument(supabase, fileName);
  if (!dl.ok) {
    await abandon();
    return NextResponse.json({ error: dl.error }, { status: dl.status });
  }

  let extractedText: string;
  let pageCount: number;
  let likelyScanned: boolean;
  try {
    ({ text: extractedText, pageCount, likelyScanned } = await extractPdfText(
      dl.bytes
    ));
  } catch (err) {
    await abandon();
    console.error("Failed to read PDF:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "That PDF could not be read. Try re-saving it and uploading again." },
      { status: 422 }
    );
  }
  const ocrStatus = likelyScanned ? "flagged" : "ok";

  const { data: rfp, error: rfpError } = await supabase
    .from("rfps")
    .insert({
      owner_id: user.id,
      title,
      description,
      rfp_file_path: fileName,
      rfp_text: extractedText,
      status: "draft",
    })
    .select("id")
    .single();

  if (rfpError || !rfp) {
    // See upload-response: the insert may have committed and its answer been
    // lost. Ask by path before treating the object as unreferenced.
    const { data: committed, error: lookupError } = await supabase
      .from("rfps")
      .select("id")
      .eq("rfp_file_path", fileName)
      .maybeSingle();
    if (committed) {
      await completeUpload(supabase, fileName, claim.token);
      return NextResponse.json({
        rfp_id: committed.id,
        ocr_status: ocrStatus,
        page_count: pageCount,
        message: "RFP uploaded successfully",
      });
    }
    if (lookupError) {
      // See upload-response: unknown is not "absent". Leave object and claim.
      console.error("Could not confirm RFP insert:", lookupError.message);
      return NextResponse.json(
        { error: "The database did not answer. The upload will be settled on your next attempt." },
        { status: 503 }
      );
    }
    await abandon();

    // A guest who has hit their RFP cap trips the row-level security check on
    // insert. That is a limit, not a fault, and "Failed to create RFP" would
    // send them off looking for a broken upload.
    if (rfpError?.code === "42501") {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few RFPs. Save your work to an " +
            "account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }
    console.error("Failed to create RFP:", rfpError?.message);
    return NextResponse.json(
      { error: "Failed to create RFP" },
      { status: 500 }
    );
  }

  await completeUpload(supabase, fileName, claim.token);

  // Log to audit trail
  await supabase.from("audit_log").insert({
    rfp_id: rfp.id,
    user_id: user.id,
    action: "upload_rfp",
    details: {
      title,
      file_name: check.fileName,
      size_bytes: dl.size,
      ocr_status: ocrStatus,
    },
  });

  return NextResponse.json({
    rfp_id: rfp.id,
    ocr_status: ocrStatus,
    page_count: pageCount,
    message:
      ocrStatus === "flagged"
        ? "This PDF appears to lack OCR text. Please OCR it and re-upload for best results."
        : "RFP uploaded successfully",
  });
}
