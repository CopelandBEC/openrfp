import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractPdfText } from "@/lib/pdf/extract-text";

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

  // Validate file type
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: "Only PDF and DOCX files are supported." },
      { status: 400 }
    );
  }

  // Upload to storage
  const fileName = `${user.id}/${rfpId}/${Date.now()}-${file.name}`;
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from("rfp-files")
    .upload(fileName, file);

  if (uploadError) {
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }

  // Extract text and check OCR
  let extractedText = "";
  let ocrStatus = "unknown";
  let pageCount = 0;

  if (file.type === "application/pdf") {
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    const tempPath = `/tmp/${Date.now()}-${file.name}`;
    const fs = await import("fs");
    fs.writeFileSync(tempPath, buffer);

    const result = await extractPdfText(tempPath);
    extractedText = result.text;
    pageCount = result.pageCount;
    ocrStatus = result.likelyScanned ? "flagged" : "ok";

    fs.unlinkSync(tempPath);
  }

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
    ocr_status: ocrStatus,
    page_count: pageCount,
    message:
      ocrStatus === "flagged"
        ? "This PDF appears to lack OCR text. Please OCR it and re-upload for best results."
        : "Response uploaded successfully",
  });
}
