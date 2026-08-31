"use client";

import { useEffect, useState, use, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Response {
  id: string;
  rfp_id: string;
  vendor_name: string;
  file_path: string;
  extracted_text: string | null;
  ocr_status: "ok" | "flagged" | "unknown";
  page_count: number;
  status: "pending" | "evaluating" | "evaluated" | "error";
  created_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const ALLOWED_EXTENSIONS = [".pdf"];
const ALLOWED_MIME_TYPES = ["application/pdf"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return "File is too large. Maximum size is 25MB.";
  }
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_MIME_TYPES.includes(file.type)) {
    return "Only PDF files are supported right now. Export Word documents to PDF first.";
  }
  return null;
}

function statusBadge(status: Response["status"]) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary">Pending</Badge>;
    case "evaluating":
      return <Badge variant="default">Evaluating</Badge>;
    case "evaluated":
      return (
        <Badge className="bg-primary text-primary-foreground">Evaluated</Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function ocrBadge(ocrStatus: Response["ocr_status"]) {
  switch (ocrStatus) {
    case "ok":
      return <Badge className="bg-primary/10 text-primary">OCR OK</Badge>;
    case "flagged":
      return (
        <Badge className="bg-yellow-100 text-yellow-800">OCR Flagged</Badge>
      );
    case "unknown":
      return <Badge variant="secondary">OCR Unknown</Badge>;
    default:
      return <Badge variant="secondary">{ocrStatus}</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [responses, setResponses] = useState<Response[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [evalProgress, setEvalProgress] = useState("");
  const [error, setError] = useState("");

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  const fetchResponses = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { data, error: queryError } = await supabase
        .from("responses")
        .select(
          "id, rfp_id, vendor_name, file_path, extracted_text, ocr_status, page_count, status, created_at"
        )
        .eq("rfp_id", id)
        .order("created_at", { ascending: true });

      if (queryError) {
        throw new Error(queryError.message);
      }

      if (data) {
        setResponses(data as Response[]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load responses");
    } finally {
      setLoading(false);
    }
  }, [id, supabase]);

  useEffect(() => {
    fetchResponses();
  }, [fetchResponses]);

  // -----------------------------------------------------------------------
  // Upload handler
  // -----------------------------------------------------------------------

  const handleUpload = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!file || !vendorName.trim()) return;

      const validationError = validateFile(file);
      if (validationError) {
        setFileError(validationError);
        return;
      }

      setUploading(true);
      setError("");
      setFileError("");

      const formData = new FormData();
      formData.append("file", file);
      formData.append("vendor_name", vendorName.trim());
      formData.append("rfp_id", id);

      try {
        const res = await fetch("/api/upload-response", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || "Failed to upload response");
        }

        const newResponse: Response = {
          id: data.response_id,
          rfp_id: id,
          vendor_name: vendorName.trim(),
          file_path: data.file_path,
          extracted_text: null,
          ocr_status: data.ocr_status || "unknown",
          page_count: data.page_count || 0,
          status: "pending",
          created_at: new Date().toISOString(),
        };

        setResponses((prev) => [...prev, newResponse]);
        setVendorName("");
        setFile(null);

        // Reset the file input so the same file can be re-selected if needed
        const fileInput = document.getElementById(
          "file-input"
        ) as HTMLInputElement | null;
        if (fileInput) fileInput.value = "";
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Something went wrong during upload"
        );
      } finally {
        setUploading(false);
      }
    },
    [file, vendorName, id]
  );

  // -----------------------------------------------------------------------
  // File selection
  // -----------------------------------------------------------------------

  const handleFileSelect = (selectedFile: File | null) => {
    if (!selectedFile) {
      setFile(null);
      setFileError("");
      return;
    }

    const validationError = validateFile(selectedFile);
    if (validationError) {
      setFileError(validationError);
      setFile(null);
      return;
    }

    setFileError("");
    setFile(selectedFile);
  };

  // -----------------------------------------------------------------------
  // Remove handler
  // -----------------------------------------------------------------------

  const handleRemove = async (response: Response) => {
    try {
      // Delete from storage
      if (response.file_path) {
        const { error: storageError } = await supabase.storage
          .from("rfp-files")
          .remove([response.file_path]);

        if (storageError) {
          console.warn("Storage deletion warning:", storageError.message);
        }
      }

      // Delete from database
      const { error: dbError } = await supabase
        .from("responses")
        .delete()
        .eq("id", response.id);

      if (dbError) {
        throw new Error(dbError.message);
      }

      // Remove from local state
      setResponses((prev) => prev.filter((r) => r.id !== response.id));
    } catch (err) {
      setError(
        err instanceof Error
          ? `Failed to remove response: ${err.message}`
          : "Failed to remove response"
      );
    }
  };

  // -----------------------------------------------------------------------
  // Evaluate All
  // -----------------------------------------------------------------------

  const pendingOrErrorResponses = responses.filter(
    (r) => r.status === "pending" || r.status === "error"
  );

  const allEvaluated =
    responses.length > 0 &&
    responses.every((r) => r.status === "evaluated");

  const canEvaluate =
    responses.length > 0 && pendingOrErrorResponses.length > 0 && !evaluating;

  const handleEvaluateAll = useCallback(async () => {
    if (!canEvaluate) return;
    setEvaluating(true);
    setError("");

    const toEvaluate = responses.filter(
      (r) => r.status === "pending" || r.status === "error"
    );

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < toEvaluate.length; i++) {
      const response = toEvaluate[i];
      setEvalProgress(
        `Evaluating ${response.vendor_name}... (${i + 1} of ${toEvaluate.length})`
      );

      // Set status to evaluating in local state
      setResponses((prev) =>
        prev.map((r) =>
          r.id === response.id ? { ...r, status: "evaluating" } : r
        )
      );

      try {
        const res = await fetch("/api/evaluate-response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response_id: response.id }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(
            data.error || `Failed to evaluate ${response.vendor_name}`
          );
        }

        // Set status to evaluated in local state
        setResponses((prev) =>
          prev.map((r) =>
            r.id === response.id ? { ...r, status: "evaluated" } : r
          )
        );

        successCount++;
      } catch (err) {
        // Set status to error in local state
        setResponses((prev) =>
          prev.map((r) =>
            r.id === response.id ? { ...r, status: "error" } : r
          )
        );

        errorCount++;
        const errMsg =
          err instanceof Error ? err.message : "Unknown error";
        // Show error but continue to next
        console.error(`Evaluation failed for ${response.vendor_name}:`, errMsg);
      }
    }

    setEvalProgress("");
    setEvaluating(false);

    if (errorCount > 0 && successCount === 0) {
      setError(
        `All ${errorCount} evaluation(s) failed. Please check the errors and try again.`
      );
    } else if (errorCount > 0) {
      setError(
        `${errorCount} evaluation(s) failed out of ${toEvaluate.length}. Successfully evaluated ${successCount}.`
      );
    }

    // If at least one succeeded, navigate to evaluations
    if (successCount > 0 && errorCount === 0) {
      router.push(`/rfp/${id}/evaluations`);
    }
  }, [canEvaluate, responses, router, id]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <a
            href="/dashboard"
            className="text-lg font-bold tracking-tight text-primary"
          >
            OpenRFP
          </a>
          <div className="flex items-center gap-6">
            <a
              href={`/rfp/${id}/rubric`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Rubric
            </a>
            <a
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              ← Back to dashboard
            </a>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight text-primary">
          Upload vendor responses
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Upload each vendor&apos;s proposal. The AI will evaluate each one
          against the rubric.
        </p>

        {/* ----------------------------------------------------------------- */}
        {/* Upload form */}
        {/* ----------------------------------------------------------------- */}

        <Card className="mt-8 border-border">
          <CardContent className="p-6">
            <form onSubmit={handleUpload} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="vendor-name">Vendor Name</Label>
                <Input
                  id="vendor-name"
                  type="text"
                  required
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  placeholder="e.g., ABC Building Envelope Consultants"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="file-input">Proposal Document (PDF, max 25MB)</Label>
                <div
                  className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted p-4 transition-colors hover:border-primary/50"
                  onClick={() =>
                    document.getElementById("file-input")?.click()
                  }
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const f = e.dataTransfer.files[0];
                    if (f) handleFileSelect(f);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  {file ? (
                    <p className="text-sm font-medium text-foreground">
                      {file.name}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Drop a PDF here or click to browse
                    </p>
                  )}
                  <input
                    id="file-input"
                    type="file"
                    accept=".pdf,application/pdf"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleFileSelect(e.target.files[0]);
                      }
                    }}
                  />
                </div>
                {fileError && (
                  <p className="text-sm text-destructive">{fileError}</p>
                )}
              </div>

              <Button
                type="submit"
                disabled={!file || !vendorName.trim() || uploading || evaluating}
                className="w-full"
              >
                {uploading ? "Uploading..." : "Add Response"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ----------------------------------------------------------------- */}
        {/* Error display */}
        {/* ----------------------------------------------------------------- */}

        {error && (
          <div className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Loading state */}
        {/* ----------------------------------------------------------------- */}

        {loading && (
          <div className="mt-8 flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="ml-3 text-sm text-muted-foreground">
              Loading responses...
            </span>
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Responses list */}
        {/* ----------------------------------------------------------------- */}

        {!loading && responses.length > 0 && (
          <div className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-primary">
                {responses.length} {responses.length === 1 ? "response" : "responses"} uploaded
              </h2>
            </div>

            <Separator className="my-4" />

            <div className="space-y-3">
              {responses.map((response) => (
                <Card key={response.id} className="border-border">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm text-foreground">
                            {response.vendor_name}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {statusBadge(response.status)}
                          {ocrBadge(response.ocr_status)}
                          {response.page_count > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {response.page_count} page{response.page_count !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>

                        {response.ocr_status === "flagged" && (
                          <div className="mt-2 rounded-md bg-yellow-50 border border-yellow-200 p-2 text-xs text-yellow-800">
                            <p>
                              ⚠ This PDF may need OCR. Please OCR it and re-upload for best results.{" "}
                              <a
                                href="https://www.adobe.com/acrobat/online/ocr-pdf.html"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-medium underline hover:text-yellow-900"
                              >
                                Run OCR on Adobe.com →
                              </a>
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemove(response)}
                          disabled={evaluating || uploading}
                          className="text-xs text-destructive hover:text-destructive"
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* ----------------------------------------------------------------- */}
            {/* Evaluate All */}
            {/* ----------------------------------------------------------------- */}

            <div className="mt-8">
              {evaluating && evalProgress && (
                <div className="mb-4 rounded-md bg-muted p-3 text-sm text-primary">
                  {evalProgress}
                </div>
              )}

              <Button
                onClick={handleEvaluateAll}
                disabled={!canEvaluate}
                className="w-full"
                size="lg"
              >
                {evaluating
                  ? "Evaluating all responses..."
                  : allEvaluated
                    ? "All responses evaluated ✓"
                    : `Evaluate ${pendingOrErrorResponses.length} response${pendingOrErrorResponses.length !== 1 ? "s" : ""} → View Results`}
              </Button>

              {allEvaluated && !evaluating && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  All responses have been evaluated.{" "}
                  <button
                    onClick={() => router.push(`/rfp/${id}/evaluations`)}
                    className="font-medium text-primary underline hover:text-primary/80"
                  >
                    View results →
                  </button>
                </p>
              )}
            </div>
          </div>
        )}

        {/* ----------------------------------------------------------------- */}
        {/* Empty state */}
        {/* ----------------------------------------------------------------- */}

        {!loading && responses.length === 0 && !error && (
          <div className="mt-12 text-center">
            <p className="text-sm text-muted-foreground">
              No responses uploaded yet. Add your first vendor response above.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
