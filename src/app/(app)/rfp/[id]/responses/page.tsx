"use client";

import { useEffect, useState, use, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRightIcon,
  FileTextIcon,
  ScanTextIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader, PageIntro } from "@/components/app-shell";
import { EmptyState, ErrorState } from "@/components/stage-state";
import { scoredAgainstCurrentRubric } from "@/lib/stage";
import { readApiResponse } from "@/lib/api-response";
import { reconcileAfterFailure, uploadDocument } from "@/lib/storage-upload";
import { cn } from "@/lib/utils";

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

/**
 * How many proposals to evaluate at once.
 *
 * Each evaluation is an independent model call, so they need not be serialised.
 * Three is a compromise: it collapses most of the wait for a typical RFP while
 * leaving the hourly AI quota — reserved per call, server side — recognisable
 * to the owner who clicks the button once.
 */
const EVALUATION_CONCURRENCY = 3;

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

/**
 * A proposal's state, as a dot and a word.
 *
 * This replaced two separate badges — one for the upload status, one for OCR —
 * which between them put up to four chips on a row whose only real news was
 * "not scored yet". The dot carries the state at a glance and the word carries
 * it properly; the OCR problem is the only one worth its own line, and it gets
 * one below.
 */
const STATUS = {
  pending: { label: "Not scored", tone: "var(--muted-foreground)" },
  evaluating: { label: "Scoring…", tone: "var(--status-warning)" },
  evaluated: { label: "Scored", tone: "var(--status-good)" },
  error: { label: "Failed", tone: "var(--status-critical)" },
} as const;

function StatusDot({ status }: { status: Response["status"] }) {
  const meta = STATUS[status] ?? {
    label: status,
    tone: "var(--muted-foreground)",
  };
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          status === "evaluating" && "animate-pulse"
        )}
        style={{ backgroundColor: meta.tone }}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
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
  const [dragActive, setDragActive] = useState(false);
  /**
   * Which rubric each existing score was made against, by response id, and
   * when the rubric's criteria last changed. Together they say whether a
   * scored proposal is actually scored against the rubric as it is now.
   */
  const [scoredAgainst, setScoredAgainst] = useState<
    Map<string, string | null>
  >(new Map());
  const [rubricUpdatedAt, setRubricUpdatedAt] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Data fetching
  // -----------------------------------------------------------------------

  // No synchronous setState before the first await: this runs from an effect,
  // where an eager reset just triggers a cascading render. `loading` and
  // `error` already mount in the right state.
  const fetchResponses = useCallback(async () => {
    try {
      const [responsesRes, evaluationsRes, rubricRes] = await Promise.all([
        supabase
          .from("responses")
          .select(
            "id, rfp_id, vendor_name, file_path, extracted_text, ocr_status, page_count, status, created_at"
          )
          .eq("rfp_id", id)
          .order("created_at", { ascending: true }),
        // A rubric edited after scoring has to show up here as scoring left
        // to do, not as "every proposal is scored" — `responses.status`
        // cannot tell the two apart.
        supabase
          .from("evaluations")
          .select("response_id, rubric_updated_at")
          .eq("rfp_id", id),
        supabase
          .from("rubrics")
          .select("updated_at")
          .eq("rfp_id", id)
          .maybeSingle(),
      ]);

      if (responsesRes.error) throw new Error(responsesRes.error.message);
      if (evaluationsRes.error) throw new Error(evaluationsRes.error.message);
      if (rubricRes.error) throw new Error(rubricRes.error.message);

      if (responsesRes.data) {
        setResponses(responsesRes.data as Response[]);
      }
      setScoredAgainst(
        new Map(
          (
            (evaluationsRes.data ?? []) as {
              response_id: string;
              rubric_updated_at: string | null;
            }[]
          ).map((ev) => [ev.response_id, ev.rubric_updated_at])
        )
      );
      setRubricUpdatedAt(
        (rubricRes.data as { updated_at?: string | null } | null)?.updated_at ??
          null
      );
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load responses");
    } finally {
      setLoading(false);
    }
  }, [id, supabase]);

  useEffect(() => {
    // Client-side data fetch. The rule flags any effect that can transitively
    // reach setState and does not trace awaits, so it cannot tell this apart
    // from the cascading-render anti-pattern it targets. The real fix is to
    // load this data in a server component; tracked as a follow-up.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

      const name = vendorName.trim();

      /** Ask the route to attach an object already in storage. */
      const attach = async (path: string) => {
        const res = await fetch("/api/upload-response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_path: path, vendor_name: name, rfp_id: id }),
        });
        const result = await readApiResponse<{
          response_id: string;
          file_path: string;
          ocr_status?: "ok" | "flagged" | "unknown";
          page_count?: number;
        }>(res, "Failed to upload response");
        if (!result.ok) throw new Error(result.error);
        return result.data;
      };

      const adopt = (row: Response) => {
        setResponses((prev) =>
          prev.some((r) => r.id === row.id) ? prev : [...prev, row]
        );
        setVendorName("");
        setFile(null);
        // Reset the file input so the same file can be re-selected if needed
        const fileInput = document.getElementById(
          "file-input"
        ) as HTMLInputElement | null;
        if (fileInput) fileInput.value = "";
      };

      try {
        // The PDF goes straight to storage from here; the route gets its
        // path. See lib/storage-upload.ts for why — the short version is that
        // the hosting platform stops request bodies at 4.5 MB, before the
        // route runs, and proposals with drawings in them are bigger.
        const uploaded = await uploadDocument(supabase, file, id);
        if (!uploaded.ok) {
          throw new Error(uploaded.error);
        }
        const path = uploaded.path;

        let data: Awaited<ReturnType<typeof attach>>;
        try {
          data = await attach(path);
        } catch (first) {
          // A failure after the upload is ambiguous: the route may have
          // finished, may still be working, may have been killed, or may never
          // have been reached. Ask the tables before deciding anything.
          const outcome = await reconcileAfterFailure(
            supabase,
            { table: "responses", column: "file_path" },
            path
          );
          if (outcome.state === "referenced") {
            const { data: row } = await supabase
              .from("responses")
              .select(
                "id, rfp_id, vendor_name, file_path, extracted_text, ocr_status, page_count, status, created_at"
              )
              .eq("id", outcome.id)
              .maybeSingle();
            if (row) {
              adopt(row as Response);
              return;
            }
            throw first;
          }
          if (outcome.state === "stale") {
            // A killed route left its claim behind. Posting the same path
            // again takes the claim over and finishes the job; a fresh upload
            // would leave this object and claim orphaned.
            data = await attach(path);
          } else if (outcome.state === "processing" || outcome.state === "unknown") {
            setError(
              "The upload is still being processed. Refresh in a moment to see it; if it does not appear, add it again."
            );
            return;
          } else {
            throw first;
          }
        }

        adopt({
          id: data.response_id,
          rfp_id: id,
          vendor_name: name,
          file_path: data.file_path,
          extracted_text: null,
          ocr_status: data.ocr_status || "unknown",
          page_count: data.page_count || 0,
          status: "pending",
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Something went wrong during upload"
        );
      } finally {
        setUploading(false);
      }
    },
    [file, vendorName, id, supabase]
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

  /**
   * Scored, but against a rubric that has changed since. The scores describe
   * criteria and weights that no longer exist, so the proposal goes back in
   * the queue as if it had never been scored.
   */
  const staleAgainstRubric = useCallback(
    (r: Response) =>
      r.status === "evaluated" &&
      scoredAgainst.has(r.id) &&
      !scoredAgainstCurrentRubric(scoredAgainst.get(r.id), rubricUpdatedAt),
    [scoredAgainst, rubricUpdatedAt]
  );

  const pendingOrErrorResponses = responses.filter(
    (r) => r.status === "pending" || r.status === "error"
  );
  const needsRescoring = responses.filter(staleAgainstRubric);
  const toScore = [...pendingOrErrorResponses, ...needsRescoring];

  const allEvaluated =
    responses.length > 0 &&
    responses.every((r) => r.status === "evaluated") &&
    needsRescoring.length === 0;

  const canEvaluate = responses.length > 0 && toScore.length > 0 && !evaluating;

  const handleEvaluateAll = useCallback(async () => {
    if (!canEvaluate) return;
    setEvaluating(true);
    setError("");

    const toEvaluate = responses.filter(
      (r) =>
        r.status === "pending" || r.status === "error" || staleAgainstRubric(r)
    );

    let successCount = 0;
    let errorCount = 0;
    let finished = 0;

    setEvalProgress(
      `Evaluating ${toEvaluate.length} response${toEvaluate.length === 1 ? "" : "s"}...`
    );

    const evaluateOne = async (response: (typeof toEvaluate)[number]) => {
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
          const result = await readApiResponse(
            res,
            `Failed to evaluate ${response.vendor_name}`
          );
          throw new Error(
            result.ok ? `Failed to evaluate ${response.vendor_name}` : result.error
          );
        }

        // Set status to evaluated in local state, and scored against the
        // rubric as it is now.
        setResponses((prev) =>
          prev.map((r) =>
            r.id === response.id ? { ...r, status: "evaluated" } : r
          )
        );
        setScoredAgainst((prev) =>
          new Map(prev).set(response.id, rubricUpdatedAt)
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
        // Show error but continue with the rest
        console.error(`Evaluation failed for ${response.vendor_name}:`, errMsg);
      }

      finished++;
      setEvalProgress(`Evaluated ${finished} of ${toEvaluate.length}...`);
    };

    // Evaluations are independent of one another, so run several at once: done
    // one at a time, an RFP with six proposals took six model calls' worth of
    // wall clock. The cap is there because the rate limiter reserves per call
    // and a wide fan-out would burn an hour's quota in one click; the per-row
    // status badges are what tell the owner where things stand.
    const queue = [...toEvaluate];
    const workers = Array.from(
      { length: Math.min(EVALUATION_CONCURRENCY, queue.length) },
      async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          await evaluateOne(next);
        }
      }
    );
    await Promise.all(workers);

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
  }, [canEvaluate, responses, staleAgainstRubric, rubricUpdatedAt, router, id]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <AppHeader rfpId={id} current="responses" />

      <main className="container mx-auto max-w-2xl px-4 py-10">
        <PageIntro eyebrow="Step 2 of 4" title="Add the proposals">
          One PDF per vendor. Each one gets scored against the rubric you just
          accepted, with the passage behind every score quoted back to you.
        </PageIntro>

        {/* ------------------------------------------------------------------
         * Upload
         *
         * The drop target is now the primary element rather than a thin strip
         * under a label, and it reacts while a file is over it — dropping a
         * PDF onto a box that never acknowledges it is the moment people
         * assume the app is broken.
         * --------------------------------------------------------------- */}
        <form onSubmit={handleUpload} className="mt-8 space-y-4">
          <div
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl px-6 py-10 text-center ring-1 transition-colors",
              dragActive
                ? "bg-muted ring-2 ring-primary"
                : file
                  ? "bg-muted/50 ring-foreground/10"
                  : "bg-muted/30 ring-foreground/10 hover:bg-muted/60"
            )}
            onClick={() => document.getElementById("file-input")?.click()}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDragActive(false);
              const f = e.dataTransfer.files[0];
              if (f) handleFileSelect(f);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
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
                  {(file.size / 1024 / 1024).toFixed(1)} MB · click to choose a
                  different file
                </p>
              </>
            ) : (
              <>
                <UploadIcon
                  className="size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="mt-3 text-sm font-medium text-foreground">
                  Drop a proposal here
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  PDF, up to 25MB
                </p>
              </>
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

          {fileError && <p className="text-sm text-destructive">{fileError}</p>}

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="vendor-name">Vendor name</Label>
              <Input
                id="vendor-name"
                type="text"
                required
                value={vendorName}
                onChange={(e) => setVendorName(e.target.value)}
                placeholder="ABC Building Envelope Consultants"
              />
            </div>
            <Button
              type="submit"
              disabled={!file || !vendorName.trim() || uploading || evaluating}
            >
              {uploading ? "Uploading…" : "Add proposal"}
            </Button>
          </div>
        </form>

        {error && (
          <div className="mt-6">
            <ErrorState message={error} />
          </div>
        )}

        {/* ------------------------------------------------------------------
         * What's been added
         * --------------------------------------------------------------- */}
        {loading ? (
          <p className="mt-10 text-sm text-muted-foreground">
            Loading proposals…
          </p>
        ) : responses.length === 0 ? (
          !error && (
            <div className="mt-10">
              <EmptyState title="No proposals yet">
                Add the first vendor above. You can score them one at a time or
                all at once.
              </EmptyState>
            </div>
          )
        ) : (
          <>
            <h2 className="mt-10 text-sm font-semibold text-foreground">
              {responses.length}{" "}
              {responses.length === 1 ? "proposal" : "proposals"}
            </h2>

            {needsRescoring.length > 0 && (
              <div
                role="note"
                className="mt-3 flex gap-2 rounded-lg bg-muted px-4 py-3 text-sm text-foreground"
              >
                <TriangleAlertIcon
                  className="mt-0.5 size-4 shrink-0"
                  style={{ color: "var(--status-warning)" }}
                  aria-hidden="true"
                />
                <p>
                  <span className="font-medium">
                    The rubric changed after scoring.
                  </span>{" "}
                  {needsRescoring.length === 1
                    ? "One proposal was scored"
                    : `${needsRescoring.length} proposals were scored`}{" "}
                  against criteria that are no longer in it:{" "}
                  {needsRescoring.map((r) => r.vendor_name).join(", ")}. Score
                  them again to bring them up to date.
                </p>
              </div>
            )}

            <ul className="mt-3 divide-y divide-border/60 rounded-xl bg-card ring-1 ring-foreground/10">
              {responses.map((response, index) => (
                <li
                  key={response.id}
                  className="animate-reveal px-4 py-3"
                  style={{ ["--reveal-i" as string]: index }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {response.vendor_name}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StatusDot status={response.status} />
                        {staleAgainstRubric(response) && (
                          <span
                            className="text-xs font-medium"
                            style={{ color: "var(--status-warning)" }}
                          >
                            Rubric changed since
                          </span>
                        )}
                        {response.page_count > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {response.page_count} page
                            {response.page_count !== 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRemove(response)}
                      disabled={evaluating || uploading}
                      aria-label={`Remove ${response.vendor_name}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>

                  {/* The one status worth spelling out: a proposal the model
                      cannot read will score badly for the wrong reason. */}
                  {response.ocr_status === "flagged" && (
                    <div className="mt-2.5 flex gap-2 rounded-lg bg-muted/60 p-2.5">
                      <ScanTextIcon
                        className="mt-0.5 size-3.5 shrink-0"
                        style={{ color: "var(--status-warning)" }}
                        aria-hidden="true"
                      />
                      <p className="text-xs leading-snug text-foreground">
                        This PDF looks like scanned images, so there is little
                        text to read. Run OCR on it and re-upload, or the
                        scores will reflect the scan rather than the proposal.{" "}
                        <a
                          href="https://www.adobe.com/acrobat/online/ocr-pdf.html"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline-offset-4 hover:underline"
                        >
                          OCR it at Adobe
                        </a>
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {/* --------------------------------------------------------------
             * Score them
             *
             * Sticky, because this is the only thing on the page that starts
             * work, and the list above it grows with every vendor added.
             * ----------------------------------------------------------- */}
            <div className="sticky bottom-0 -mx-4 mt-10 border-t border-border/70 bg-background/90 px-4 py-3 backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {evaluating
                    ? evalProgress ||
                      `Scoring up to ${EVALUATION_CONCURRENCY} at a time…`
                    : allEvaluated
                      ? "Every proposal is scored."
                      : needsRescoring.length > 0
                        ? `${toScore.length} to score against the current rubric.`
                        : `${pendingOrErrorResponses.length} waiting to be scored.`}
                </p>
                {allEvaluated && !evaluating ? (
                  <Button
                    size="lg"
                    onClick={() => router.push(`/rfp/${id}/evaluations`)}
                  >
                    See the results
                    <ArrowRightIcon aria-hidden="true" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleEvaluateAll}
                    disabled={!canEvaluate}
                    size="lg"
                  >
                    {evaluating
                      ? "Scoring…"
                      : `${
                          pendingOrErrorResponses.length === 0 ? "Re-score" : "Score"
                        } ${toScore.length} proposal${
                          toScore.length !== 1 ? "s" : ""
                        }`}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
