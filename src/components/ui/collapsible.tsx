"use client"

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Collapsible({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      className={cn("group/collapsible", className)}
      {...props}
    />
  )
}

/**
 * The trigger, styled as a quiet text affordance rather than a button.
 *
 * It reads as "there is more here" — which is the point of every disclosure on
 * the result screens — and the caret rotates so the state is legible without
 * reading the label.
 */
function CollapsibleTrigger({
  className,
  children,
  ...props
}: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "group/trigger inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="size-3.5 transition-transform duration-200 group-data-panel-open/trigger:rotate-180" />
    </CollapsiblePrimitive.Trigger>
  )
}

/**
 * The panel animates its height, which needs the measured height base-ui
 * exposes as `--collapsible-panel-height`. `[&[hidden]]` keeps a closed panel
 * out of the accessibility tree once the transition has finished.
 */
function CollapsiblePanel({
  className,
  ...props
}: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="collapsible-panel"
      className={cn(
        "h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsiblePanel }
