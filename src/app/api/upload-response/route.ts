import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { isGuest } from "@/lib/auth/guest";
import { isStorageDenied } from "@/lib/storage-errors";

// Parsing a large PDF can outrun the platform default.
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File;
  const vendorName = formData.get("vendor_name") as string;
  const rfpId = formData.get("rfp_id") as string;

  if (!file || !vendorName || !rfpId) {
    return NextResponse.json(
      { error: "File, vendor name, and RFP ID are required" },
      { status: 400 }
    );
  }

  // Validate file size
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File too large. Maximum 25MB." },
      { status: 400 }
    );
  }

  // Validate file type. DOCX is deliberately rejected rather than accepted:
  // extraction below is PDF-only, so a DOCX upload used to succeed, store an
  // empty rfp_text, and then fail a step later with a misleading "needs OCR"
  // message. Native DOCX parsing is a roadmap item (SPEC section 13).
  if (file.type !== "application/pdf") {
    return NextResponse.json(
      {
        error:
          "Only PDF files are supported right now. If you have a Word " +
          "document, export it to PDF and upload that.",
      },
      { status: 400 }
    );
  }

  // Upload to storage
  const fileName = `${user.id}/${rfpId}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from("rfp-files")
    .upload(fileName, file);

  if (uploadError) {
    // A guest at their file cap is refused by the storage insert policy. That
    // is a limit, not a fault, and it deserves an explanation.
    if (isGuest(user) && isStorageDenied(uploadError)) {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few uploaded files. Save your " +
            "work to an account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }
    console.error("Failed to upload response file:", uploadError.message);
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }

  // Extract text and flag PDFs that appear to lack an OCR layer
  const {
    text: extractedText,
    pageCount,
    likelyScanned,
  } = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
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
    // The file is already in storage, and for a guest it now occupies one of
    // their capped slots. Remove it rather than leave an object no row will
    // ever reference and no UI can delete.
    await supabase.storage.from("rfp-files").remove([fileName]);

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
    details: { vendor_name: vendorName, file_name: file.name, ocr_status: ocrStatus },
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
