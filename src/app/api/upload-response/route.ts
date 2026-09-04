import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";
import { isGuest } from "@/lib/auth/guest";
import { downloadDocument, validateOwnedPath } from "@/lib/storage-read";
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
 *
 * The row is the claim. It is inserted *before* the file is read back, with
 * the text still to come, so that a second request for the same path is
 * refused by the unique index on `file_path` before a byte is downloaded or
 * parsed. Checked after the parse, one stored object could be turned into
 * many concurrent 25 MB reads and parses by cheap repeated requests. If
 * reading or parsing then fails, the row and the object both go.
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

  // Claim the path.
  const { data: claimed, error: claimError } = await supabase
    .from("responses")
    .insert({
      rfp_id: rfpId,
      vendor_name: vendorName,
      file_path: fileName,
      status: "pending",
    })
    .select("id")
    .single();

  if (claimError || !claimed) {
    // Another request already holds this path; its row references the
    // object, so the object stays.
    if (claimError?.code === "23505") {
      return NextResponse.json(
        { error: "That file has already been added to this RFP." },
        { status: 409 }
      );
    }
    // Nothing references the object from here on. Remove it rather than leave
    // it with no row and, for a guest, occupying one of their capped slots.
    await supabase.storage.from(BUCKET).remove([fileName]);

    // A guest at their response cap trips the row-level security check on
    // insert. That is a limit, not a fault.
    if (claimError?.code === "42501" && isGuest(user)) {
      return NextResponse.json(
        {
          error:
            "Guest sessions are limited to a few vendor responses. Save your " +
            "work to an account from the banner above to keep going.",
        },
        { status: 403 }
      );
    }
    console.error("Failed to create response:", claimError?.message);
    return NextResponse.json(
      { error: "Failed to create response record" },
      { status: 500 }
    );
  }

  // Read the file back and extract text, now that the path is ours alone.
  const dl = await downloadDocument(supabase, fileName);
  if (!dl.ok) {
    await supabase.from("responses").delete().eq("id", claimed.id);
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
    await supabase.from("responses").delete().eq("id", claimed.id);
    await supabase.storage.from(BUCKET).remove([fileName]);
    console.error("Failed to read PDF:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "That PDF could not be read. Try re-saving it and uploading again." },
      { status: 422 }
    );
  }
  const ocrStatus = likelyScanned ? "flagged" : "ok";

  const { error: fillError } = await supabase
    .from("responses")
    .update({
      extracted_text: extractedText,
      ocr_status: ocrStatus,
      page_count: pageCount,
    })
    .eq("id", claimed.id);

  if (fillError) {
    await supabase.from("responses").delete().eq("id", claimed.id);
    await supabase.storage.from(BUCKET).remove([fileName]);
    console.error("Failed to store extracted text:", fillError.message);
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
      file_name: check.fileName,
      size_bytes: dl.size,
      ocr_status: ocrStatus,
    },
  });

  return NextResponse.json({
    response_id: claimed.id,
    file_path: fileName,
    ocr_status: ocrStatus,
    page_count: pageCount,
    message:
      ocrStatus === "flagged"
        ? "This PDF appears to lack OCR text. Please OCR it and re-upload for best results."
        : "Response uploaded successfully",
  });
}
