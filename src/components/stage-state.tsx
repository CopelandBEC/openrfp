"use client"

import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * The wait, and how long it has been going.
 *
 * No progress signal comes back from the provider, so there is nothing honest
 * to put a percentage on. What we can say truthfully is how long it has been
 * running, and what the request actually involves — so that is what these
 * share. `useWaitCommentary` holds both: a real elapsed count, and a line of
 * commentary rotated every few seconds.
 */
function useWaitCommentary(notes: string[]) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - started) / 1000)),
      1000
    )
    return () => clearInterval(timer)
  }, [])

  const note = notes.length ? notes[Math.floor(elapsed / 5) % notes.length] : ""
  return { elapsed, note }
}

/** Indeterminate, and shaped like one: a travelling sliver, not a fill that
    would imply a known fraction. */
function WorkingBar({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-1 overflow-hidden rounded-r-[4px] bg-viz-track",
        className
      )}
    >
      <div className="h-full w-1/3 animate-[working_1.4s_ease-in-out_infinite] rounded-r-[4px] bg-viz-mark motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  )
}

/**
 * The wait, when it is the whole screen.
 *
 * A model call here runs for tens of seconds to a couple of minutes, and the
 * old screens spent that time showing a bare spinner — the longest, least
 * reassuring moment in the app. Nothing here fakes a percentage or ticks off
 * steps as "done": inventing one would be a lie that the user catches the
 * first time it stalls at 80%.
 */
export function WorkingState({
  title,
  notes,
  expected,
  reassurance,
}: {
  title: string
  /** True statements about the work, rotated every few seconds. */
  notes: string[]
  /** Honest range, e.g. "a couple of minutes". */
  expected?: string
  /** One line of encouragement for the waits long enough to need it. */
  reassurance?: string
}) {
  const { elapsed, note } = useWaitCommentary(notes)

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <WorkingBar className="w-full max-w-56" />

      <h2 className="mt-6 text-lg font-semibold text-foreground">{title}</h2>

      <p
        key={note}
        className="animate-reveal mt-2 min-h-10 text-sm text-muted-foreground"
        aria-live="polite"
      >
        {note}
      </p>

      <p className="mt-1 text-xs text-muted-foreground/80">
        {elapsed}s elapsed
        {expected ? ` · usually ${expected}` : ""}
      </p>

      {reassurance && (
        <p className="mt-3 text-sm font-medium text-foreground">{reassurance}</p>
      )}
    </div>
  )
}

/**
 * The same wait, sized for a corner of a screen that stays useful.
 *
 * The proposals screen keeps its list and per-row status visible while scoring
 * runs, so the wait cannot take the page over — but it was reduced to one
 * static line of grey text, which reads as a stall. This is the full-screen
 * treatment folded into that space: the same travelling sliver, the same
 * rotating commentary, the same honest clock.
 */
export function WorkingInline({
  notes,
  status,
  className,
}: {
  notes: string[]
  status?: string
  className?: string
}) {
  const { elapsed, note } = useWaitCommentary(notes)

  return (
    <div className={cn("min-w-0", className)}>
      <WorkingBar className="w-32" />
      <p
        key={note}
        className="animate-reveal mt-2 text-xs font-medium text-foreground"
        aria-live="polite"
      >
        {note}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground/80">
        {status ? `${status} · ` : ""}
        {elapsed}s elapsed
      </p>
    </div>
  )
}

/**
 * Nothing here yet — said in one line, with the one thing to do next.
 *
 * Dashed borders and a shrug of grey text were the old pattern; an empty state
 * is a place where the app should be most helpful, not least.
 */
export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl bg-muted/40 px-6 py-14 text-center ring-1 ring-foreground/5",
        className
      )}
    >
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {children}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

/** A recoverable failure, with the retry beside it rather than below the fold. */
export function ErrorState({
  message,
  action,
}: {
  message: string
  action?: React.ReactNode
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/10 px-4 py-3"
    >
      <p className="text-sm text-destructive">{message}</p>
      {action}
    </div>
  )
}
