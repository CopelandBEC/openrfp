import { MessageSquareIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Where feedback goes. One form, linked from every page. */
export const FEEDBACK_URL = "https://tally.so/r/vGlDeX";

/**
 * The "Feedback" link every header carries.
 *
 * It lives in the header rather than the footer because the moments worth
 * hearing about — a rubric that read wrong, a score that looked off — happen
 * partway down a long results page, where a footer is a scroll away and the
 * thought has passed by the time you get there.
 */
export function FeedbackLink({
  className,
  /**
   * Drop the word on narrow screens and keep only the icon. The app header is
   * already carrying the stage rail at that width; a link standing on its own
   * has the room and should keep its label.
   */
  compact = true,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <a
      href={FEEDBACK_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-primary",
        className
      )}
    >
      <MessageSquareIcon className="size-4" aria-hidden="true" />
      <span className={cn(compact && "hidden sm:inline")}>Feedback</span>
      {compact && <span className="sr-only sm:hidden">Feedback</span>}
    </a>
  );
}
