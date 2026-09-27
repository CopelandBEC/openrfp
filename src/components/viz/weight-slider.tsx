"use client"

import { useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent } from "react"

import { cn } from "@/lib/utils"

/**
 * A rubric weight, as a draggable bar.
 *
 * Same mark spec as ScoreBar — one hue, length is the encoding — but the end
 * of the fill is a handle. The weights are the one number on the rubric screen
 * worth changing by feel, and typing eight numbers to balance a total is
 * spreadsheet work. The number input in the criterion form still works; both
 * write the same weight.
 *
 * The whole bar is the control, so the pointer target is the full track and
 * not the 14px handle. Keyboard follows the slider convention: arrows step by
 * one, with shift by ten.
 */
export function WeightSlider({
  value,
  onChange,
  label,
  index = 0,
  className,
}: {
  /** 0–100. Clamped, so a drag can never leave the track. */
  value: number
  onChange: (value: number) => void
  /** Accessible name for the control — the bar is the slider. */
  label: string
  /** Row position, so a list of bars staggers instead of arriving at once. */
  index?: number
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const clamped = Math.max(0, Math.min(100, value))

  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))

  const percentAt = (clientX: number) => {
    const track = trackRef.current
    if (!track) return clamped
    const rect = track.getBoundingClientRect()
    if (rect.width === 0) return clamped
    return clamp(((clientX - rect.left) / rect.width) * 100)
  }

  const nudge = (delta: number) => onChange(clamp(clamped + delta))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setDragging(true)
    onChange(percentAt(e.clientX))
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const next = percentAt(e.clientX)
    if (next !== clamped) onChange(next)
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault()
        nudge(e.shiftKey ? 10 : 1)
        break
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault()
        nudge(e.shiftKey ? -10 : -1)
        break
      case "Home":
        e.preventDefault()
        onChange(0)
        break
      case "End":
        e.preventDefault()
        onChange(100)
        break
    }
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
      aria-valuetext={`${clamped} percent`}
      className={cn(
        "group relative w-full touch-none rounded-lg py-2 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50",
        dragging ? "cursor-grabbing" : "cursor-grab",
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <div
        ref={trackRef}
        className="h-1.5 w-full overflow-hidden rounded-r-[4px] bg-viz-track"
        style={{ ["--reveal-i" as string]: index }}
      >
        <div
          className="viz-grow h-full rounded-r-[4px] bg-viz-mark"
          style={{ width: `${clamped}%` }}
        />
      </div>

      {/* The handle, parked at the end of the fill. It grows on hover, focus
          and drag, so the bar reads as adjustable before anyone tries. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-sm transition-transform motion-reduce:transition-none group-hover:scale-125 group-focus-visible:scale-125",
          dragging && "scale-125"
        )}
        style={{
          left: `${clamped}%`,
          borderColor: "var(--viz-mark)",
          backgroundColor: "var(--background)",
        }}
      />
    </div>
  )
}
