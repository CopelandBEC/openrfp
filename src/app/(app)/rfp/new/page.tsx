"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewRfpPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !title) return;

    setLoading(true);
    setError("");

    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", title);
    formData.append("description", description);

    try {
      const res = await fetch("/api/upload-rfp", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to upload");
      }

      const data = await res.json();
      // Navigate to the rubric generation step
      router.push(`/rfp/${data.rfp_id}/rubric?new=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <a href="/dashboard" className="text-lg font-bold tracking-tight">
              OpenRFP
            </a>
            <span className="text-sm text-muted-foreground">
              New RFP Evaluation
            </span>
          </div>
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
          Upload your RFP
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Upload your RFP document. The AI will read it and generate a
          customized evaluation rubric with weighted criteria.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          <div className="space-y-2">
            <label htmlFor="title" className="text-sm font-medium">
              RFP Title
            </label>
            <input
              id="title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="e.g., Building Envelope Consulting Services — State University"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="description" className="text-sm font-medium">
              Description (optional)
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder="Brief description of the procurement..."
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="rfp-file" className="text-sm font-medium">
              RFP Document
            </label>
            {/* A <label> rather than a div with an onClick: the file input is
                visually hidden, and a label forwards both mouse and keyboard
                activation to it. The previous markup advertised "browse" but
                nothing opened the picker — only drag-and-drop worked. */}
            <label
              htmlFor="rfp-file"
              className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/30 p-6 transition-colors hover:border-muted-foreground/50"
              onDrop={(e) => {
                e.preventDefault();
                const droppedFile = e.dataTransfer.files[0];
                if (droppedFile) setFile(droppedFile);
              }}
              onDragOver={(e) => e.preventDefault()}
            >
              {file ? (
                <div className="text-center">
                  <p className="text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">
                    Drag and drop your RFP here, or{" "}
                    <span className="text-primary">browse</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    PDF, max 25MB
                  </p>
                </div>
              )}
              <input
                id="rfp-file"
                type="file"
                accept=".pdf,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.[0]) setFile(e.target.files[0]);
                }}
              />
            </label>
          </div>

          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!file || !title || loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading
              ? "Uploading and processing..."
              : "Upload RFP → Generate Rubric"}
          </button>
        </form>
      </main>
    </div>
  );
}
