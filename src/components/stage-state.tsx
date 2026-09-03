"use client"

import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * The wait.
 *
 * A model call here runs for tens of seconds, and the old screens spent that
 * time showing a bare spinner — the longest, least reassuring moment in the
 * app. This shows two true things instead: a real elapsed count, and a
 * rotating description of what the request actually involves. Nothing here
 * fakes a percentage or ticks off steps as "done": we have no progress signal
 * from the provider, and inventing one would be a lie that the user catches
 * the first time it stalls at 80%.
 */
export function WorkingState({
  title,
  notes,
  expected,
}: {
  title: string
  /** True statements about the work, rotated every few seconds. */
  notes: string[]
  /** Honest range, e.g. "15–60 seconds". */
  expected?: string
}) {
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

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      {/* Indeterminate, and shaped like one: a travelling sliver, not a fill
          that would imply a known fraction. */}
      <div className="h-1 w-full max-w-56 overflow-hidden rounded-r-[4px] bg-viz-track">
        <div className="h-full w-1/3 animate-[working_1.4s_ease-in-out_infinite] rounded-r-[4px] bg-viz-mark motion-reduce:w-full motion-reduce:animate-none" />
      </div>

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
