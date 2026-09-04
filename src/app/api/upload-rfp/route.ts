import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { readOwnedDocument } from "@/lib/storage-read";
import { BUCKET } from "@/lib/storage-upload";

// Parsing a large PDF can outrun the platform default, and the file now
// arrives from storage rather than in the request, so the 25 MB the app
// promises actually reaches this code.
export const maxDuration = 120;

/**
 * Create an RFP from an uploaded document.
 *
 * The browser has already put the PDF in storage — see lib/storage-upload.ts
 * for why the file no longer travels in this request — and sends its path.
 * This reads it back, extracts the text, and creates the row; if the row
 * cannot be created the object is removed rather than left orphaned.
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
  const filePath = body?.file_path;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description =
    typeof body?.description === "string" ? body.description : "";

  if (!filePath || !title) {
    return NextResponse.json(
      { error: "File and title are required" },
      { status: 400 }
    );
  }

  // A path creates one RFP; see upload-response for why this is checked
  // before the read and backed by a unique index.
  const { data: existing } = await supabase
    .from("rfps")
    .select("id")
    .eq("rfp_file_path", filePath as string)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "That file has already been used to create an RFP." },
      { status: 409 }
    );
  }

  const read = await readOwnedDocument(supabase, user, filePath, null);
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
    if (rfpError.code === "23505") {
      return NextResponse.json(
        { error: "That file has already been used to create an RFP." },
        { status: 409 }
      );
    }
    await supabase.storage.from(BUCKET).remove([fileName]);

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
    details: {
      title,
      file_name: read.fileName,
      size_bytes: read.size,
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
