"use client"

import { CircleCheckIcon, CircleAlertIcon, CircleSlashIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { TIER, type ScoreTier } from "@/lib/score"

const ICON = {
  strong: CircleCheckIcon,
  mixed: CircleAlertIcon,
  weak: CircleSlashIcon,
} as const satisfies Record<ScoreTier, unknown>

/**
 * The verdict word for a score, with its icon.
 *
 * Status colour rides the icon, never the text: the warning step is
 * deliberately sub-3:1 on white, so it would fail as type. The word is what
 * actually carries the meaning — in a printed report, for a reader who cannot
 * separate the hues, and for anyone skimming a column of these.
 */
export function TierChip({
  tier,
  size = "default",
  className,
}: {
  tier: ScoreTier
  size?: "default" | "sm"
  className?: string
}) {
  const Icon = ICON[tier]
  const { label } = TIER[tier]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-4xl bg-muted font-medium text-foreground",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        className
      )}
    >
      <Icon
        className={size === "sm" ? "size-3" : "size-3.5"}
        style={{ color: TIER[tier].tone }}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}
