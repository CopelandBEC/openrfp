"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { CheckIcon } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import {
  embeddedCount,
  firstEmbedded,
  reachedStages,
  type StageName,
} from "@/lib/stage"
import { cn } from "@/lib/utils"

/**
 * The four stages of an evaluation, in order.
 *
 * Every screen in an RFP is one of these, and the header renders the whole
 * ladder so the reader can always see how far along they are and how much is
 * left. That was the single biggest thing missing: each page previously stood
 * alone, with nothing but a back link, so the flow felt like four unrelated
 * forms rather than one piece of work with an end.
 */
export const STAGES = [
  { key: "rubric", label: "Rubric", path: "rubric" },
  { key: "responses", label: "Responses", path: "responses" },
  { key: "evaluations", label: "Evaluations", path: "evaluations" },
  { key: "comparison", label: "Decision", path: "comparison" },
] as const

export type StageKey = (typeof STAGES)[number]["key"]

/**
 * Which stages have data behind them, from the rows.
 *
 * Until the query answers, only the stages at or behind the current one are
 * offered, which is what the rail always offered; the ones ahead light up
 * once it is known they lead somewhere.
 */
function useReachedStages(rfpId: string): Set<StageName> {
  const supabase = useMemo(() => createClient(), [])
  const [reached, setReached] = useState<Set<StageName>>(() => new Set())

  useEffect(() => {
    let cancelled = false
    supabase
      .from("rfps")
      .select(
        "rubrics(edited_by_user), evaluations(count), comparisons(count)"
      )
      .eq("id", rfpId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return
        const rubric = firstEmbedded<{ edited_by_user: boolean | null }>(
          data.rubrics
        )
        setReached(
          reachedStages({
            hasRubric: rubric != null,
            rubricAccepted: rubric?.edited_by_user === true,
            evaluationCount: embeddedCount(data.evaluations),
            hasRanking: embeddedCount(data.comparisons) > 0,
          })
        )
      })
    return () => {
      cancelled = true
    }
  }, [supabase, rfpId])

  return reached
}

function StageRail({
  rfpId,
  current,
}: {
  rfpId: string
  current: StageKey
}) {
  const currentIndex = STAGES.findIndex((s) => s.key === current)
  const reached = useReachedStages(rfpId)

  return (
    <nav aria-label="Evaluation progress" className="flex items-center gap-1">
      <ol className="flex items-center gap-1">
        {STAGES.map((stage, index) => {
          const done = index < currentIndex
          const active = index === currentIndex
          // A stage is a link if it is behind us, or if the data it shows
          // exists. Inferred from the URL alone — behind reachable, ahead not —
          // a finished evaluation's Decision screen stopped being a link the
          // moment its owner stepped back to the rubric. Stages with nothing
          // behind them still are not links: offering the jump only to land
          // on an empty state is worse than not offering it.
          const reachable = done || active || reached.has(stage.key)

          const content = (
            <>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-semibold transition-colors",
                  active && "bg-primary text-primary-foreground",
                  done && "bg-muted text-primary",
                  !reachable && "bg-muted/60 text-muted-foreground"
                )}
              >
                {done ? (
                  <CheckIcon className="size-3" aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="hidden sm:inline">{stage.label}</span>
            </>
          )

          return (
            <li key={stage.key} className="flex items-center gap-1">
              {index > 0 && (
                <span
                  className={cn(
                    "hidden h-px w-4 sm:block",
                    done || active ? "bg-primary/30" : "bg-border"
                  )}
                  aria-hidden="true"
                />
              )}
              {reachable ? (
                <Link
                  href={`/rfp/${rfpId}/${stage.path}`}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {content}
                </Link>
              ) : (
                <span className="flex items-center gap-1.5 px-1.5 py-1 text-xs font-medium text-muted-foreground/70">
                  {content}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * The header every authenticated screen wears.
 *
 * Sticky, because the stage rail is also the navigation — on the long result
 * pages the way back should not require scrolling to find it.
 */
export function AppHeader({
  rfpId,
  current,
  label,
  action,
}: {
  /** Omitted on the dashboard, where there is no single RFP in play. */
  rfpId?: string
  current?: StageKey
  /** Shown in place of the stage rail when there is no RFP. */
  label?: string
  /** Sign-out and the like, on the right. */
  action?: React.ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-sm">
      <div className="container mx-auto flex h-14 items-center gap-4 px-4">
        <Link
          href="/dashboard"
          className="shrink-0 text-base font-bold tracking-tight text-primary"
        >
          OpenRFP
        </Link>
        <div className="ml-auto flex items-center gap-4">
          {rfpId && current ? (
            <StageRail rfpId={rfpId} current={current} />
          ) : (
            label && (
              <span className="text-sm text-muted-foreground">{label}</span>
            )
          )}
          {action}
        </div>
      </div>
    </header>
  )
}

/**
 * The title block at the top of a screen: an eyebrow, a heading, and one line
 * of orientation. Actions sit on the right of the heading, not below it.
 */
export function PageIntro({
  eyebrow,
  title,
  children,
  action,
}: {
  eyebrow?: string
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {children && (
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">
            {children}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
