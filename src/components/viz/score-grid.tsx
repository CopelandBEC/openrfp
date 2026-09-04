"use client"

import { cn } from "@/lib/utils"
import { BINS, formatScore, scoreBin } from "@/lib/score"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export interface GridColumn {
  id: string
  label: string
}

export interface GridRow {
  id: string
  label: string
  /** Shown in the tooltip, so the weight doesn't need its own column. */
  weight?: number
}

export interface GridCell {
  /** 0–100, already normalised against the criterion's maximum. */
  percent: number
  /** Raw "3/5" style reading, for the tooltip. */
  raw?: string
  /** The model's one-line reason, trimmed by the caller. */
  note?: string
}

/**
 * Criteria × vendors, as a heatmap.
 *
 * A grid of magnitudes is the one place a sequential ramp earns its keep: the
 * eye finds the dark column and the pale row before it reads a single number.
 * One hue in five steps — past about seven bins neighbouring classes stop
 * being separable — and every cell still prints its own value, which is what
 * makes the palest step legal and what makes this readable at all in
 * grayscale.
 */
export function ScoreGrid({
  columns,
  rows,
  cell,
  className,
}: {
  columns: GridColumn[]
  rows: GridRow[]
  cell: (rowId: string, columnId: string) => GridCell | null
  className?: string
}) {
  if (!columns.length || !rows.length) return null

  return (
    <TooltipProvider>
      <div className={cn("space-y-3", className)}>
        <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
          <table className="w-full border-separate border-spacing-0.5 bg-card p-0.5 text-sm">
            <caption className="sr-only">
              Score by criterion for each vendor, as a percentage of the
              criterion&apos;s maximum.
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 z-1 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground"
                >
                  Criterion
                </th>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className="px-2 py-2 text-center text-xs font-medium text-muted-foreground"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-1 max-w-[16rem] bg-card px-3 py-2 text-left text-xs font-medium text-foreground"
                  >
                    {row.label}
                    {row.weight != null && (
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        {row.weight}%
                      </span>
                    )}
                  </th>
                  {columns.map((column) => {
                    const value = cell(row.id, column.id)
                    if (!value) {
                      return (
                        <td
                          key={column.id}
                          className="px-2 py-2 text-center text-xs text-muted-foreground"
                        >
                          —
                        </td>
                      )
                    }
                    const bin = scoreBin(value.percent)
                    return (
                      <td key={column.id} className="p-0">
                        <Tooltip>
                          {/* The whole cell is the hit target, comfortably past
                              the 24px minimum, and focus shows what hover
                              shows. */}
                          <TooltipTrigger
                            className="flex h-9 w-full min-w-[4.5rem] items-center justify-center rounded-[4px] text-xs font-semibold tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                            style={{
                              backgroundColor: `var(--viz-bin-${bin})`,
                              color: `var(--viz-bin-${bin}-ink)`,
                            }}
                          >
                            {formatScore(value.percent)}
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-semibold">{column.label}</p>
                            <p className="mt-0.5 text-background/80">
                              {row.label} —{" "}
                              {value.raw ?? `${formatScore(value.percent)}%`}
                            </p>
                            {value.note && (
                              <p className="mt-1 text-background/70">
                                {value.note}
                              </p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ScoreGridLegend />
      </div>
    </TooltipProvider>
  )
}

/** The scale, spelled out — a sequential ramp is meaningless without one. */
function ScoreGridLegend() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Score</span>
      <span className="flex items-center gap-0.5">
        {BINS.map(({ bin }) => (
          <span
            key={bin}
            className="size-3.5 rounded-[2px]"
            style={{ backgroundColor: `var(--viz-bin-${bin})` }}
            aria-hidden="true"
          />
        ))}
      </span>
      <span>0 → 100% of each criterion&apos;s maximum</span>
    </div>
  )
}
