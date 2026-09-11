import { MessageSquareIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Where feedback goes. One form, linked from every page. */
export const FEEDBACK_URL = "https://tally.so/r/vGlDeX";

/**
 * From which breakpoint the word "Feedback" joins the icon.
 *
 * Written out as whole class strings rather than composed, because Tailwind
 * only ships the classes it can see spelled out in the source.
 */
const LABEL_FROM = {
  always: { label: "", sr: "" },
  sm: { label: "hidden sm:inline", sr: "sr-only sm:hidden" },
  md: { label: "hidden md:inline", sr: "sr-only md:hidden" },
} as const;

/**
 * The "Feedback" link every header carries.
 *
 * It lives in the header rather than the footer because the moments worth
 * hearing about — a rubric that read wrong, a score that looked off — happen
 * partway down a long results page, where a footer is a scroll away and the
 * thought has passed by the time you get there.
 *
 * Headers are tight, and this link is the newest thing in them, so it is the
 * one that gives way: `labelFrom` drops the word at widths where the header it
 * sits in has no room for it, leaving the icon and its accessible name.
 */
export function FeedbackLink({
  className,
  labelFrom = "sm",
}: {
  className?: string;
  labelFrom?: keyof typeof LABEL_FROM;
}) {
  const { label, sr } = LABEL_FROM[labelFrom];

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
      <span className={label}>Feedback</span>
      {sr && <span className={sr}>Feedback</span>}
    </a>
  );
}
