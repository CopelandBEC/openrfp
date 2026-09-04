import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { isGuest } from "@/lib/auth/guest";
import { readOwnedDocument } from "@/lib/storage-read";
import { BUCKET } from "@/lib/storage-upload";

// Parsing a large PDF can outrun the platform default, and the file now
// arrives from storage rather than in the request, so the 25 MB the app
// promises actually reaches this code.
export const maxDuration = 120;

/**
 * Attach an uploaded proposal to an RFP.
 *
 * The browser has already put the PDF in storage — see lib/storage-upload.ts
 * for why the file no longer travels in this request — and sends its path.
 * This reads it back, extracts the text, and creates the row. If anything
 * after the read fails, the object is removed rather than left with no row
 * referencing it and, for a guest, occupying one of their capped slots.
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
  const filePath = body?.file_path;
  const vendorName =
    typeof body?.vendor_name === "string" ? body.vendor_name.trim() : "";
  const rfpId = typeof body?.rfp_id === "string" ? body.rfp_id : "";

  if (!filePath || !vendorName || !rfpId) {
    return NextResponse.json(
      { error: "File, vendor name, and RFP ID are required" },
      { status: 400 }
    );
  }

  const read = await readOwnedDocument(supabase, user, filePath, rfpId);
  if (!read.ok) {
    return NextResponse.json({ error: read.error }, { status: read.status });
  }
  const fileName = filePath as string;

  // Extract text and flag PDFs that appear to lack an OCR layer
  const {
    text: extractedText,
    pageCount,
    likelyScanned,
  } = await extractPdfText(read.bytes);
  const ocrStatus = likelyScanned ? "flagged" : "ok";

  // Create response record
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
    .select()
    .single();

  if (responseError) {
    await supabase.storage.from(BUCKET).remove([fileName]);

    // A guest at their response cap trips the row-level security check on
    // insert. That is a limit, not a fault.
    if (responseError.code === "42501" && isGuest(user)) {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few vendor responses. Save your " +
            "work to an account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }

    console.error("Failed to create response:", responseError.message);
    return NextResponse.json(
      { error: "Failed to create response record" },
      { status: 500 }
    );
  }

  // Audit log
  await supabase.from("audit_log").insert({
    rfp_id: rfpId,
    user_id: user.id,
    action: "upload_response",
    details: {
      vendor_name: vendorName,
      file_name: read.fileName,
      size_bytes: read.size,
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
