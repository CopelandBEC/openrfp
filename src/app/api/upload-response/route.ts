import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { isGuest } from "@/lib/auth/guest";
import {
  claimUpload,
  completeUpload,
  downloadDocument,
  releaseUpload,
  validateOwnedPath,
} from "@/lib/storage-read";
import { BUCKET } from "@/lib/storage-upload";

// Parsing a large PDF can outrun the platform default, and the file now
// arrives from storage rather than in the request, so the 25 MB the app
// promises actually reaches this code. The claim functions treat anything in
// flight longer than 3 minutes as abandoned; keep this below that.
export const maxDuration = 120;

/**
 * Attach an uploaded proposal to an RFP.
 *
 * The browser has already put the PDF in storage — see lib/storage-upload.ts
 * for why the file no longer travels in this request — and sends its path.
 *
 * Order matters. The path is claimed first, in a table the caller cannot
 * touch, so a second request for the same path is refused before a byte is
 * read; then the file is read back and parsed; then the row is written, with
 * its text, so a row exists only for a finished upload; then the claim is
 * marked complete so the path can never be reused. Any failure in between
 * releases the claim and removes the object, so a retry is possible and
 * nothing is left that no row references.
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
    vendor_name?: unknown;
    rfp_id?: unknown;
  } | null;
  const vendorName =
    typeof body?.vendor_name === "string" ? body.vendor_name.trim() : "";
  const rfpId = typeof body?.rfp_id === "string" ? body.rfp_id : "";

  if (!body?.file_path || !vendorName || !rfpId) {
    return NextResponse.json(
      { error: "File, vendor name, and RFP ID are required" },
      { status: 400 }
    );
  }

  const check = validateOwnedPath(user, body.file_path, rfpId);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  const fileName = body.file_path as string;

  const claim = await claimUpload(supabase, fileName);
  if (claim.state === "error") {
    console.error("Failed to claim upload:", claim.error);
    return NextResponse.json(
      { error: "Failed to start processing the file. Please try again." },
      { status: 500 }
    );
  }
  if (claim.state === "completed") {
    return NextResponse.json(
      { error: "That file has already been added to this RFP." },
      { status: 409 }
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

  // From here on, every failure hands the path back and removes the object.
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

  const { data: responseRecord, error: responseError } = await supabase
    .from("responses")
    .insert({
      rfp_id: rfpId,
      vendor_name: vendorName,
      file_path: fileName,
      extracted_text: extractedText,
      ocr_status: ocrStatus,
      page_count: pageCount,
      status: "pending",
    })
    .select("id")
    .single();

  if (responseError || !responseRecord) {
    // The unique index is a backstop behind the claim; a row for this path
    // means the object is referenced and must stay.
    if (responseError?.code === "23505") {
      await completeUpload(supabase, fileName, claim.token);
      return NextResponse.json(
        { error: "That file has already been added to this RFP." },
        { status: 409 }
      );
    }
    await abandon();

    // A guest at their response cap trips the row-level security check on
    // insert. That is a limit, not a fault.
    if (responseError?.code === "42501" && isGuest(user)) {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few vendor responses. Save your " +
            "work to an account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }
    console.error("Failed to create response:", responseError?.message);
    return NextResponse.json(
      { error: "Failed to create response record" },
      { status: 500 }
    );
  }

  await completeUpload(supabase, fileName, claim.token);

  // Audit log
  await supabase.from("audit_log").insert({
    rfp_id: rfpId,
    user_id: user.id,
    action: "upload_response",
    details: {
      vendor_name: vendorName,
      file_name: check.fileName,
      size_bytes: dl.size,
      ocr_status: ocrStatus,
    },
  });

  return NextResponse.json({
    response_id: responseRecord.id,
    file_path: fileName,
    ocr_status: ocrStatus,
    page_count: pageCount,
    message:
      ocrStatus === "flagged"
        ? "This PDF appears to lack OCR text. Please OCR it and re-upload for best results."
        : "Response uploaded successfully",
  });
}
