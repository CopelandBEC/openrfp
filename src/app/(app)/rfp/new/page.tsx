"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileTextIcon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AppHeader, PageIntro } from "@/components/app-shell";
import { ErrorState } from "@/components/stage-state";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { readApiResponse } from "@/lib/api-response";
import {
  forgetPending,
  readPending,
  reconcileAfterFailure,
  rememberPending,
  uploadDocument,
  waitForUpload,
  type Reconciliation,
} from "@/lib/storage-upload";

export default function NewRfpPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const pendingScope = "rfp";

  /** Ask the route to create the RFP from an object already in storage. */
  const create = useCallback(
    async (path: string, fields: Record<string, string>) => {
      const res = await fetch("/api/upload-rfp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_path: path,
          title: fields.title,
          description: fields.description ?? "",
        }),
      });
      const result = await readApiResponse<{ rfp_id: string }>(
        res,
        "Failed to upload"
      );
      if (!result.ok) throw new Error(result.error);
      return result.data.rfp_id;
    },
    []
  );

  /** See the note on `settleUpload` in the responses screen; same shape. */
  const settleUpload = useCallback(
    async (
      path: string,
      fields: Record<string, string>,
      freshlyUploaded: boolean
    ): Promise<string> => {
      rememberPending(pendingScope, { path, startedAt: Date.now(), fields });
      const ref = { table: "rfps" as const, column: "rfp_file_path" as const };
      let outcome: Reconciliation | null = freshlyUploaded
        ? null
        : await reconcileAfterFailure(supabase, ref, path);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (outcome == null || outcome.state === "stale") {
          try {
            const rfpId = await create(path, fields);
            forgetPending(pendingScope);
            return rfpId;
          } catch (err) {
            outcome = await reconcileAfterFailure(supabase, ref, path);
            if (outcome.state === "reclaimed") {
              forgetPending(pendingScope);
              throw err;
            }
          }
        }
        if (outcome.state === "processing" || outcome.state === "unknown") {
          outcome = await waitForUpload(supabase, ref, path, (elapsed) =>
            setError(
              `Still processing the upload (${Math.round(elapsed / 1000)}s). Leave this page open, or come back later and it will pick up where it left off.`
            )
          );
          setError("");
        }
        if (outcome.state === "referenced") {
          forgetPending(pendingScope);
          return outcome.id;
        }
        if (outcome.state === "reclaimed") {
          forgetPending(pendingScope);
          throw new Error("The upload did not complete. Please upload the RFP again.");
        }
      }
      throw new Error(
        "The upload is taking longer than expected. Leave this page open and it will keep trying."
      );
    },
    [supabase, create]
  );

  useEffect(() => {
    const pending = readPending(pendingScope);
    if (!pending) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rfpId = await settleUpload(pending.path, pending.fields, false);
        if (!cancelled) router.push(`/rfp/${rfpId}/rubric?new=1`);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "An earlier upload did not complete.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !title) return;

    setLoading(true);
    setError("");

    try {
      // Straight to storage, then the path to the route; see
      // lib/storage-upload.ts for why the file no longer rides in the request.
      const uploaded = await uploadDocument(supabase, file, null);
      if (!uploaded.ok) {
        throw new Error(uploaded.error);
      }
      const rfpId = await settleUpload(
        uploaded.path,
        { title, description },
        true
      );
      // Navigate to the rubric generation step
      router.push(`/rfp/${rfpId}/rubric?new=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <AppHeader label="New evaluation" />

      <main className="container mx-auto max-w-2xl px-4 py-10">
        <PageIntro eyebrow="Step 1 of 4" title="Start with the RFP">
          OpenRFP reads the document and proposes the criteria to score
          proposals against, weighted to reflect what the RFP actually asks
          for. You review every one of them before anything gets scored.
        </PageIntro>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          {/* The drop target leads, because it is the one thing that must
              happen here; the two text fields are quick by comparison. */}
          <div className="space-y-1.5">
            <Label htmlFor="rfp-file">RFP document</Label>
            {/* A <label> rather than a div with an onClick: the file input is
                visually hidden, and a label forwards both mouse and keyboard
                activation to it. The previous markup advertised "browse" but
                nothing opened the picker — only drag-and-drop worked. */}
            <label
              htmlFor="rfp-file"
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-xl px-6 py-10 text-center ring-1 transition-colors",
                dragActive
                  ? "bg-muted ring-2 ring-primary"
                  : file
                    ? "bg-muted/50 ring-foreground/10"
                    : "bg-muted/30 ring-foreground/10 hover:bg-muted/60"
              )}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                const droppedFile = e.dataTransfer.files[0];
                if (droppedFile) setFile(droppedFile);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
            >
              {file ? (
                <>
                  <FileTextIcon
                    className="size-6 text-primary"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm font-medium text-foreground">
                    {file.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(1)} MB · click to choose
                    a different file
                  </p>
                </>
              ) : (
                <>
                  <UploadIcon
                    className="size-6 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm font-medium text-foreground">
                    Drop your RFP here
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    PDF, up to 25MB
                  </p>
                </>
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

          <div className="space-y-1.5">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Building Envelope Consulting — State University"
            />
            <p className="text-xs text-muted-foreground">
              Used to name the exported report, so make it something a
              committee would recognise.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Textarea
              id="description"
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Anything you want to remember about this procurement."
            />
          </div>

          {error && <ErrorState message={error} />}

          <Button
            type="submit"
            disabled={!file || !title || loading}
            size="lg"
            className="w-full"
          >
            {loading ? "Reading your RFP…" : "Build the rubric"}
          </Button>
        </form>
      </main>
    </div>
  );
}
