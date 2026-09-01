import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";

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
  const title = formData.get("title") as string;
  const description = (formData.get("description") as string) || "";

  if (!file || !title) {
    return NextResponse.json(
      { error: "File and title are required" },
      { status: 400 }
    );
  }

  // Validate file size (25MB max)
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

  // Upload to Supabase Storage
  const fileName = `${user.id}/${Date.now()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from("rfp-files")
    .upload(fileName, file);

  if (uploadError) {
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

  // Create RFP record
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
    .select()
    .single();

  if (rfpError) {
    // The file is already in storage at this point, so drop it rather than
    // leave an object no row will ever reference.
    await supabase.storage.from("rfp-files").remove([fileName]);

    // A guest who has hit their RFP cap trips the row-level security check on
    // insert. That is a limit, not a fault, and "Failed to create RFP" would
    // send them off looking for a broken upload.
    if (rfpError.code === "42501") {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few RFPs. Save your work to an " +
            "account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }

    console.error("Failed to create RFP:", rfpError.message);
    return NextResponse.json(
      { error: "Failed to create RFP" },
      { status: 500 }
    );
  }

  // Log to audit trail
  await supabase.from("audit_log").insert({
    rfp_id: rfp.id,
    user_id: user.id,
    action: "upload_rfp",
    details: { title, file_name: file.name, ocr_status: ocrStatus },
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
