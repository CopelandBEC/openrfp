"use client";

import { useState, useTransition } from "react";
import { CheckIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteRfp, updateRfp } from "@/app/(app)/dashboard/actions";
import { cn } from "@/lib/utils";
import { TOTAL_STAGES, type Stage } from "@/lib/stage";

export interface RfpSummary {
  id: string;
  title: string;
  description: string | null;
  responseCount: number;
  /**
   * Derived from the rows, not from `rfps.status`, which reports
   * `rubric_ready` from the moment a rubric is generated. See lib/stage.ts.
   */
  stage: Stage;
}

type Mode = "view" | "edit" | "confirm-delete";

/**
 * One RFP on the dashboard: a link into the evaluation, plus rename, edit
 * description and delete, all inline so nothing leaves the page.
 *
 * Delete asks once, in place, and says what goes with it. It is the only
 * irreversible thing on this screen.
 */
export function RfpCard({ rfp }: { rfp: RfpSummary }) {
  const [mode, setMode] = useState<Mode>("view");
  const [error, setError] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = (form.elements.namedItem("title") as HTMLInputElement).value;
    const description = (
      form.elements.namedItem("description") as HTMLTextAreaElement
    ).value;
    setError("");
    startTransition(async () => {
      const result = await updateRfp(rfp.id, { title, description });
      if (result.ok) setMode("view");
      else setError(result.error ?? "Couldn't save the changes.");
    });
  }

  function handleDelete() {
    setError("");
    startTransition(async () => {
      const result = await deleteRfp(rfp.id);
      // On success the dashboard re-renders without this card.
      if (!result.ok) setError(result.error ?? "Couldn't delete the RFP.");
    });
  }

  function cancel() {
    setError("");
    setMode("view");
  }

  if (mode === "edit") {
    return (
      <form
        onSubmit={handleSave}
        className="rounded-lg border p-4"
        aria-label={`Edit ${rfp.title}`}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor={`title-${rfp.id}`} className="text-sm font-medium">
              Title
            </label>
            <Input
              id={`title-${rfp.id}`}
              name="title"
              defaultValue={rfp.title}
              required
              maxLength={200}
              disabled={isPending}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor={`description-${rfp.id}`}
              className="text-sm font-medium"
            >
              Description{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id={`description-${rfp.id}`}
              name="description"
              defaultValue={rfp.description ?? ""}
              rows={3}
              maxLength={2000}
              disabled={isPending}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={cancel}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      </form>
    );
  }

  const contents = [
    "its rubric",
    rfp.responseCount === 1
      ? "1 vendor response"
      : rfp.responseCount > 1
        ? `${rfp.responseCount} vendor responses`
        : null,
    rfp.responseCount > 0 ? "every evaluation" : null,
  ].filter(Boolean);
  const contentsText =
    contents.length > 1
      ? `${contents.slice(0, -1).join(", ")} and ${contents[contents.length - 1]}`
      : contents[0];

  const { stage } = rfp;

  return (
    <div className="group/rfp rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <a href={`/rfp/${rfp.id}/${stage.next}`} className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-foreground">
            {rfp.title}
          </h2>
          {rfp.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {rfp.description}
            </p>
          )}

          {/* Four pips and a word: how far along, and what happens next. */}
          <div className="mt-3 flex items-center gap-2.5">
            <span className="flex items-center gap-1" aria-hidden="true">
              {Array.from({ length: TOTAL_STAGES }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 w-5 rounded-full",
                    i < stage.step ? "bg-viz-mark" : "bg-viz-track"
                  )}
                />
              ))}
            </span>
            <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              {stage.done && (
                <CheckIcon
                  className="size-3"
                  style={{ color: "var(--status-good)" }}
                  aria-hidden="true"
                />
              )}
              {stage.label}
            </span>
            {rfp.responseCount > 0 && (
              <span className="text-xs text-muted-foreground">
                · {rfp.responseCount}{" "}
                {rfp.responseCount === 1 ? "proposal" : "proposals"}
              </span>
            )}
          </div>
        </a>

        {mode === "view" && (
          <div className="flex shrink-0 gap-0.5">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => setMode("edit")}
              aria-label={`Edit ${rfp.title}`}
              className="text-muted-foreground"
            >
              <PencilIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setMode("confirm-delete")}
              aria-label={`Delete ${rfp.title}`}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>

      {mode === "confirm-delete" && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          role="alertdialog"
          aria-label={`Confirm deleting ${rfp.title}`}
        >
          <p className="text-foreground">
            Delete this RFP and {contentsText}?{" "}
            <span className="text-muted-foreground">This cannot be undone.</span>
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting…" : "Delete"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={cancel}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
          {error && (
            <p className="w-full text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
