/**
 * Score semantics, in one place.
 *
 * Every screen and every export reads scores through this module, so a
 * criterion that reads "Mixed" on the evaluations page cannot read "Strong" in
 * the downloaded report. The thresholds were already implicit in the old
 * comparison-page badge (80 and 60); they are now stated once.
 */

export type ScoreTier = "strong" | "mixed" | "weak";

/** Lower bound of each tier, as a percentage of the criterion's maximum. */
export const TIER_MIN = { strong: 80, mixed: 60 } as const;

export function scoreTier(percent: number): ScoreTier {
  if (percent >= TIER_MIN.strong) return "strong";
  if (percent >= TIER_MIN.mixed) return "mixed";
  return "weak";
}

/**
 * What a tier is called and how it is announced.
 *
 * `tone` maps to a status custom property. Status colour never travels alone:
 * every place that paints with it also renders `label`, which is what makes
 * the tier readable to someone who cannot separate the hues — and readable at
 * all in a printed report.
 */
export const TIER = {
  strong: {
    label: "Strong",
    blurb: "Meets or exceeds what the RFP asked for",
    tone: "var(--status-good)",
  },
  mixed: {
    label: "Mixed",
    blurb: "Partly answered — worth a question at interview",
    tone: "var(--status-warning)",
  },
  weak: {
    label: "Needs review",
    blurb: "Thin or missing against this criterion",
    tone: "var(--status-critical)",
  },
} as const satisfies Record<ScoreTier, { label: string; blurb: string; tone: string }>;

/** A raw score against its maximum, as a percentage. Guards a zero maximum. */
export function toPercent(score: number, max: number): number {
  if (!max) return 0;
  return (score / max) * 100;
}

/**
 * Which of the five sequential bins a percentage falls in, 1 (lowest) to 5.
 *
 * Five is the ceiling here rather than a round number: past roughly seven bins
 * adjacent classes stop being separable, and the grid carries the number in
 * every cell anyway.
 */
export function scoreBin(percent: number): 1 | 2 | 3 | 4 | 5 {
  const clamped = Math.max(0, Math.min(100, percent));
  if (clamped < 20) return 1;
  if (clamped < 40) return 2;
  if (clamped < 60) return 3;
  if (clamped < 80) return 4;
  return 5;
}

/** The five bins, for a scale legend. */
export const BINS = [
  { bin: 1, from: 0, to: 20 },
  { bin: 2, from: 20, to: 40 },
  { bin: 3, from: 40, to: 60 },
  { bin: 4, from: 60, to: 80 },
  { bin: 5, from: 80, to: 100 },
] as const;

/** One decimal, and no trailing ".0" noise on a whole number. */
export function formatScore(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
