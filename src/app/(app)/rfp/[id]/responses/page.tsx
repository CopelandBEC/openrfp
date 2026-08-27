"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";

export default function ResponsesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [responses, setResponses] = useState<any[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState("");

  // Placeholder: in production, fetch from Supabase
  const fetchResponses = async () => {
    // TODO: fetch from Supabase
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !vendorName) return;

    setUploading(true);
    setError("");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("vendor_name", vendorName);
    formData.append("rfp_id", id);

    try {
      const res = await fetch("/api/upload-response", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to upload");
      }
      const data = await res.json();
      setResponses((prev) => [
        ...prev,
        {
          id: data.response_id,
          vendor_name: vendorName,
          ocr_status: data.ocr_status,
          status: "pending",
        },
      ]);
      setVendorName("");
      setFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setUploading(false);
    }
  };

  const handleEvaluateAll = async () => {
    setEvaluating(true);
    setError("");

    try {
      for (const response of responses) {
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
      }
      router.push(`/rfp/${id}/evaluations`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <a href="/dashboard" className="text-lg font-bold tracking-tight">
            OpenRFP
          </a>
          <a
            href="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to dashboard
          </a>
        </div>
      </header>

      <main className="container mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-2xl font-bold tracking-tight">
          Upload vendor responses
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Upload each vendor&apos;s proposal. The AI will evaluate each one
          against the rubric.
        </p>

        <form onSubmit={handleUpload} className="mt-8 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Vendor Name</label>
            <input
              type="text"
              required
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="e.g., ABC Building Envelope Consultants"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Proposal Document</label>
            <div
              className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/30 p-4 transition-colors hover:border-muted-foreground/50"
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) setFile(f);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              {file ? (
                <p className="text-sm font-medium">{file.name}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Drop PDF/DOCX here or click to browse
                </p>
              )}
              <input
                type="file"
                accept=".pdf,.docx"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) setFile(e.target.files[0]);
                }}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={!file || !vendorName || uploading}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {uploading ? "Uploading..." : "Add Response"}
          </button>
        </form>

        {error && (
          <div className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {responses.length > 0 && (
          <div className="mt-8">
            <h2 className="text-lg font-semibold">Uploaded Responses</h2>
            <div className="mt-4 space-y-2">
              {responses.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div>
                    <p className="font-medium text-sm">{r.vendor_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Status: {r.status}
                      {r.ocr_status === "flagged" && (
                        <span className="ml-2 text-yellow-600">
                          ⚠ May need OCR
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handleEvaluateAll}
              disabled={evaluating}
              className="mt-6 inline-flex h-10 items-center justify-center rounded-md bg-primary px-6 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {evaluating
                ? "Evaluating all responses..."
                : "Evaluate All → View Results"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
