"use client"

import { useEffect, useRef } from "react"
import { Meter } from "@base-ui/react/meter"

import { cn } from "@/lib/utils"
import { formatScore, scoreTier } from "@/lib/score"
import { TierChip } from "@/components/viz/tier-chip"

/**
 * Count a figure up to its value once, on mount.
 *
 * The score is the one thing the reader came for, and it arrives after a wait
 * measured in tens of seconds — landing on it beats blinking it into place.
 *
 * The frames are written straight to the text node rather than through state.
 * A score animating through sixty values would otherwise re-render the whole
 * card sixty times, and React's own guidance is that an effect should drive an
 * external system rather than feed itself. It also means the value rendered on
 * the server is the real one, so the number is correct before any of this runs
 * and correct if it never does.
 */
function useCountUp(
  value: number,
  enabled: boolean,
  durationMs = 700
): React.RefObject<HTMLSpanElement | null> {
  const ref = useRef<HTMLSpanElement>(null)
  const done = useRef(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    // Re-runs land here: an overridden criterion changes the score, and
    // re-animating then would read as a fresh result rather than an edit.
    if (done.current || !enabled) {
      node.textContent = formatScore(value)
      return
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.textContent = formatScore(value)
      return
    }
    done.current = true

    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      // Ease-out cubic: quick, then settles.
      node.textContent = formatScore(value * (1 - Math.pow(1 - t, 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, enabled, durationMs])

  return ref
}

/**
 * The headline score: a hero figure over a meter track.
 *
 * A single ratio against a limit is a meter, not a donut — a ring would make
 * the reader estimate an angle to recover a number printed right beside it.
 * The figure is the chart; the track shows where in the range it sits. One
 * hue, because length already carries the magnitude, and the verdict word
 * beside it carries the judgement.
 */
export function ScoreMeter({
  value,
  label = "Overall score",
  size = "hero",
  showTier = true,
  className,
}: {
  value: number | null | undefined
  label?: string
  size?: "hero" | "compact"
  showTier?: boolean
  className?: string
}) {
  const known = value != null && !Number.isNaN(value)
  const safe = known ? value : 0
  const ref = useCountUp(safe, known)
  const hero = size === "hero"

  return (
    <Meter.Root
      value={safe}
      className={cn("flex flex-col", hero ? "gap-2" : "gap-1.5", className)}
    >
      {/* The verdict sits above the figure rather than beside it. Competing for
          the same line, a chip and a 48px number either wrap or squeeze the
          number, and the number is the thing being read. */}
      {showTier && known && (
        <TierChip tier={scoreTier(safe)} size="sm" className="self-start" />
      )}

      <div className="flex items-baseline gap-1.5">
        {/* Proportional figures, not tabular: equal-width digits read loose at
            display sizes. The sans is the body sans — no display face. */}
        <span
          ref={ref}
          className={cn(
            "font-semibold leading-none text-foreground",
            hero ? "text-5xl" : "text-2xl"
          )}
        >
          {known ? formatScore(safe) : "—"}
        </span>
        <span
          className={cn(
            "font-medium whitespace-nowrap text-muted-foreground",
            hero ? "text-sm" : "text-xs"
          )}
        >
          / 100
        </span>
      </div>

      {/* 4px rounded at the data end, square at the baseline, and the track is
          a lighter step of the mark's own ramp so the unfilled part still reads
          as part of the same scale. */}
      <Meter.Track
        className={cn(
          "w-full overflow-hidden rounded-r-[4px] bg-viz-track",
          hero ? "h-2" : "h-1.5"
        )}
      >
        <Meter.Indicator className="viz-grow h-full rounded-r-[4px] bg-viz-mark" />
      </Meter.Track>

      <Meter.Label
        className={cn(
          "text-muted-foreground",
          hero ? "text-xs" : "text-[0.7rem]"
        )}
      >
        {label}
      </Meter.Label>
    </Meter.Root>
  )
}
