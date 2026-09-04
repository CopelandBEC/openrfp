"use client"

import { cn } from "@/lib/utils"

/**
 * One magnitude bar, for a criterion score or a rubric weight.
 *
 * Every bar on a screen wears the same hue. The criteria are nominal — nothing
 * orders "Technical competence" against "Communication" — so colouring each
 * bar by its own value would spend the only free channel restating the length,
 * and shade would start to look like a category. Length is the encoding; the
 * number beside it is the label.
 *
 * Mark spec: capped thickness, 4px rounded at the data end, square at the
 * baseline, grown from zero on first paint.
 */
export function ScoreBar({
  percent,
  index = 0,
  thickness = "default",
  className,
}: {
  /** 0–100. Clamped, so a stray override cannot draw past the track. */
  percent: number
  /** Row position, so a list of bars staggers instead of arriving at once. */
  index?: number
  thickness?: "default" | "thin"
  className?: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-r-[4px] bg-viz-track",
        thickness === "thin" ? "h-1.5" : "h-2",
        className
      )}
      style={{ ["--reveal-i" as string]: index }}
      // The number is always rendered next to this bar, so the bar itself is
      // decoration for a value that is already readable as text.
      aria-hidden="true"
    >
      <div
        className="viz-grow h-full rounded-r-[4px] bg-viz-mark"
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
