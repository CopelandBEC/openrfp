import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { downloadDocument, validateOwnedPath } from "@/lib/storage-read";
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
 * The row is inserted before the file is read back, as the claim on the path;
 * see upload-response for why. If reading or parsing fails, row and object go.
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

  // Claim the path.
  const { data: rfp, error: claimError } = await supabase
    .from("rfps")
    .insert({
      owner_id: user.id,
      title,
      description,
      rfp_file_path: fileName,
      status: "draft",
    })
    .select("id")
    .single();

  if (claimError || !rfp) {
    if (claimError?.code === "23505") {
      return NextResponse.json(
        { error: "That file has already been used to create an RFP." },
        { status: 409 }
      );
    }
    await supabase.storage.from(BUCKET).remove([fileName]);

    // A guest who has hit their RFP cap trips the row-level security check on
    // insert. That is a limit, not a fault, and "Failed to create RFP" would
    // send them off looking for a broken upload.
    if (claimError?.code === "42501") {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few RFPs. Save your work to an " +
            "account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }
    console.error("Failed to create RFP:", claimError?.message);
    return NextResponse.json(
      { error: "Failed to create RFP" },
      { status: 500 }
    );
  }

  const dl = await downloadDocument(supabase, fileName);
  if (!dl.ok) {
    await supabase.from("rfps").delete().eq("id", rfp.id);
    await supabase.storage.from(BUCKET).remove([fileName]);
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
    await supabase.from("rfps").delete().eq("id", rfp.id);
    await supabase.storage.from(BUCKET).remove([fileName]);
    console.error("Failed to read PDF:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "That PDF could not be read. Try re-saving it and uploading again." },
      { status: 422 }
    );
  }
  const ocrStatus = likelyScanned ? "flagged" : "ok";

  const { error: fillError } = await supabase
    .from("rfps")
    .update({ rfp_text: extractedText })
    .eq("id", rfp.id);

  if (fillError) {
    await supabase.from("rfps").delete().eq("id", rfp.id);
    await supabase.storage.from(BUCKET).remove([fileName]);
    console.error("Failed to store RFP text:", fillError.message);
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
