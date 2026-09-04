/**
 * Exports.
 *
 * The old exports were a four-column CSV of the ranking and a raw dump of the
 * comparison row. Both were technically complete and neither was something you
 * would send to a selection committee, so the interesting part of the work —
 * the evidence behind each score — never left the app.
 *
 * There are now three, for three different readers: an HTML report that opens
 * with the decision and keeps the detail behind disclosures, a CSV that a
 * procurement officer can pivot, and the JSON for anyone rebuilding this
 * elsewhere.
 */

import { BINS, formatScore, scoreBin, scoreTier, TIER } from "@/lib/score";
import { describeModel } from "@/lib/ai/model-label";

// ---------------------------------------------------------------------------
// The shape a report needs
// ---------------------------------------------------------------------------

export interface ReportCriterion {
  id: string;
  name: string;
  description?: string;
  weight: number;
}

export interface ReportScore {
  score: number;
  max: number;
  percent: number;
  rationale?: string;
  evidence_quote?: string;
  page_ref?: string | null;
  overridden?: boolean;
}

export interface ReportVendor {
  responseId: string;
  vendorName: string;
  rank: number | null;
  overallScore: number | null;
  rankRationale?: string;
  summary?: string;
  strengths: string[];
  weaknesses: string[];
  scores: Record<string, ReportScore>;
}

export interface ReportCloseCall {
  criterionName: string;
  note: string;
  contenders: { vendorName: string; score: number }[];
}

export interface ReportData {
  rfpTitle: string;
  generatedAt: string;
  /** The model that produced the ranking — `comparisons.model_used`. */
  rankingModel?: string | null;
  /**
   * The model or models that scored the proposals — every distinct
   * `evaluations.model_used`. Not the same fact as `rankingModel`: AI_MODEL
   * can change between scoring and ranking, and a report that named the
   * ranking model as the scorer misattributed the scores.
   */
  scoringModels?: string[];
  criteria: ReportCriterion[];
  vendors: ReportVendor[];
  comparativeAnalysis?: string;
  closeCalls: ReportCloseCall[];
  interviewFocusAreas: string[];
  /**
   * Set when the saved ranking no longer describes the field: a score changed,
   * a proposal added or removed, the rubric edited. A committee reading a
   * printed ranking has no way to find that out otherwise.
   */
  rankingStale?: boolean;
  /**
   * Whether every score in the report is a live, current one. False when a
   * proposal is unscored, scored against an earlier rubric, or removed since
   * the ranking (it keeps the score it had when ranked, because that is all
   * there is). The report must not then call its scores current, whatever
   * else it says.
   */
  scoresCurrent?: boolean;
  /** What changed, one clause each. Printed under the ranking. */
  stalenessReasons?: string[];
}

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename stem from the RFP title: safe on every filesystem, still legible. */
function slug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "rfp";
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Escape one cell.
 *
 * The leading apostrophe is the formula-injection guard this export inherited:
 * a vendor name beginning `=` is a live formula in Excel, and the text here
 * came out of a PDF someone else wrote.
 *
 * It has to go *inside* the quotes. Written the other way — apostrophe, then
 * the opening quote — the field no longer begins with a quote, so RFC 4180
 * says it is not a quoted field at all: the quotes become literal and the
 * first comma inside the value ends the column. One weakness bullet starting
 * "- " and containing a comma shifts every column after it on that row. The
 * inherited version had this backwards, and it went unnoticed while the export
 * was four columns of short values; the per-criterion, rationale and
 * strengths/weaknesses columns added here are free text where a leading dash
 * and an internal comma are close to guaranteed.
 *
 * It also has to look past leading whitespace and control characters. Anchored
 * at byte zero it was trivially bypassed: quoting preserves a leading tab, and
 * a compatible importer strips it and evaluates the formula behind it. That
 * matters more in this revision than it used to, because these columns now
 * carry the first-stage evaluation's strengths and weaknesses verbatim — text
 * written by a model reading a PDF that a bidding vendor supplied, with no
 * second model pass in between to launder it.
 */
function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  // Leading control characters are dropped before anything else. A tab or a
  // carriage return ahead of an `=` is invisible in the cell and defeats a
  // check anchored at byte zero, which is the only thing it is good for: the
  // importer acts on the `=` behind it. Nothing legitimate in a strength or a
  // rationale begins with a control character.
  const normalised = text.replace(/^[\u0000-\u001f]+/, "");
  // Then decide on the first character that a spreadsheet would actually act
  // on, rather than on the first byte.
  const guarded = /^\s*[=+\-@]/.test(normalised) ? `'${normalised}` : normalised;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * One row per vendor, one column per criterion, plus the summary columns.
 *
 * The old CSV had four columns and stopped at the overall score, which is the
 * one number a spreadsheet cannot help you interrogate. Per-criterion columns
 * are what make it worth opening.
 */
export function exportCsv(data: ReportData) {
  const header = [
    "Rank",
    "Vendor",
    "Overall score",
    "Verdict",
    ...data.criteria.map((c) => `${c.name} (${num(c.weight)}%)`),
    "Why this rank",
    "Strengths",
    "Weaknesses",
  ];

  const rows = data.vendors.map((vendor) => [
    vendor.rank ?? "",
    vendor.vendorName,
    vendor.overallScore != null ? formatScore(vendor.overallScore) : "",
    vendor.overallScore != null
      ? TIER[scoreTier(vendor.overallScore)].label
      : "",
    ...data.criteria.map((c) => {
      const entry = vendor.scores[c.id];
      return entry ? `${formatScore(entry.score)}/${entry.max}` : "";
    }),
    vendor.rankRationale ?? "",
    vendor.strengths.join(" | "),
    vendor.weaknesses.join(" | "),
  ]);

  // The spreadsheet carries the same warning the report does. Without it, a
  // CSV opened in a month pairs live scores with a rank order and rationale
  // from before the change, and nothing on the sheet says so. Appended after
  // a blank row so the data block above still parses as a plain table.
  const notice: (string | number)[][] = data.rankingStale
    ? [
        [],
        [
          `This ranking is out of date. ${
            data.scoresCurrent === false
              ? "Not every score here is current."
              : "The scores are current; the rank order and rationale predate a change."
          } ${(data.stalenessReasons ?? []).join(" ")}`.trim(),
        ],
      ]
    : [];

  const csv = [header, ...rows, ...notice]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");

  downloadFile(
    csv,
    `${slug(data.rfpTitle)}-comparison.csv`,
    "text/csv;charset=utf-8;"
  );
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export function exportJson(data: ReportData) {
  downloadFile(
    JSON.stringify(data, null, 2),
    `${slug(data.rfpTitle)}-comparison.json`,
    "application/json"
  );
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

/** Everything interpolated into the report passes through here first. */
function esc(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a number that arrived as JSON, as a number.
 *
 * `criteria` and `ranking` are stored exactly as the model emitted them —
 * `parseModelJson` output straight into a jsonb column — so a field this
 * codebase types as `number` is only a number by convention. The types are a
 * compile-time claim about runtime data nobody validated.
 *
 * That matters here and nowhere else in the app: React escapes interpolated
 * values, so a stray string is merely ugly in the UI, but this module builds
 * HTML by concatenation. A weight of `<img src=x onerror=…>` would be live
 * markup in a report someone emails to a selection committee, and the RFP that
 * shaped the model's answer came from outside. Coercing is stricter than
 * escaping: it enforces the type the rest of the code already assumes.
 */
function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The report stylesheet.
 *
 * The same validated ramp the app uses, inlined so the file works with no
 * network at all — it gets emailed around, and a report that needs a CDN to
 * look right is a report that eventually doesn't.
 */
const REPORT_CSS = `
:root {
  --ink: #1a1a1a;
  --ink-soft: #5c5b5b;
  --ink-faint: #8a8989;
  --surface: #ffffff;
  --surface-sunk: #f7f9f4;
  --rule: #e2e2dd;
  --mark: #436801;
  --track: #dbeec9;
  --bin-1: #dbeec9; --bin-1-ink: #444343;
  --bin-2: #b9d89b; --bin-2-ink: #444343;
  --bin-3: #95bd6a; --bin-3-ink: #444343;
  --bin-4: #53791f; --bin-4-ink: #ffffff;
  --bin-5: #284700; --bin-5-ink: #ffffff;
  --good: #0ca30c;
  --warning: #fab219;
  --critical: #d03b3b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 24px 80px;
  background: var(--surface);
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 820px; margin: 0 auto; }
h1, h2, h3, h4 { line-height: 1.25; margin: 0; font-weight: 600; }
h1 { font-size: 26px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin-top: 44px; }
h3 { font-size: 14px; }
p { margin: 0; }
.eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--ink-faint);
}
.meta { margin-top: 6px; font-size: 12px; color: var(--ink-soft); }
.rule { height: 1px; background: var(--rule); border: 0; margin: 28px 0 0; }

/* -- the decision ------------------------------------------------------- */
.verdict {
  margin-top: 28px; padding: 24px;
  background: var(--surface-sunk); border-radius: 14px;
}
.verdict-name { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
.hero-score {
  font-size: 44px; font-weight: 600; line-height: 1; letter-spacing: -0.02em;
}
.hero-score span { font-size: 15px; font-weight: 500; color: var(--ink-soft); }
.verdict-why { margin-top: 14px; font-size: 14px; }
.margin-note { margin-top: 10px; font-size: 13px; color: var(--ink-soft); }
.stale {
  margin-top: 14px; padding: 12px 14px; border-radius: 10px;
  background: var(--surface-sunk); border-left: 3px solid var(--warning);
  font-size: 13px;
}
.verdict .stale { background: var(--surface); }

/* -- ranked list -------------------------------------------------------- */
.rank-row {
  display: grid; grid-template-columns: 20px minmax(0, 1fr) 210px 52px;
  align-items: center; gap: 12px;
  padding: 11px 0; border-bottom: 1px solid var(--rule);
}
.rank-row:last-child { border-bottom: 0; }
.rank-no { font-size: 13px; font-weight: 600; color: var(--mark); }
.rank-name { font-size: 14px; font-weight: 500; }
.rank-value { font-size: 14px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.bar { height: 8px; background: var(--track); border-radius: 0 4px 4px 0; overflow: hidden; }
.bar > i { display: block; height: 100%; background: var(--mark); border-radius: 0 4px 4px 0; }

/* -- verdict chips ------------------------------------------------------ */
.chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 500; color: var(--ink);
}
.chip::before {
  content: ""; width: 8px; height: 8px; border-radius: 50%;
  background: var(--chip-tone, var(--ink-faint));
}

/* -- checklist ---------------------------------------------------------- */
.checklist { margin: 12px 0 0; padding: 0; list-style: none; }
.checklist li {
  display: flex; gap: 10px; padding: 8px 0;
  border-bottom: 1px solid var(--rule); font-size: 14px;
}
.checklist li:last-child { border-bottom: 0; }
.checklist li::before {
  content: ""; flex: 0 0 14px; height: 14px; margin-top: 3px;
  border: 1.5px solid var(--ink-faint); border-radius: 3px;
}

/* -- disclosure --------------------------------------------------------- */
details {
  margin-top: 10px; padding: 0 16px;
  background: var(--surface-sunk); border-radius: 10px;
}
details > summary {
  padding: 12px 0; cursor: pointer; font-size: 13px; font-weight: 600;
  list-style: none;
}
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "▸ "; color: var(--ink-faint); }
details[open] > summary::before { content: "▾ "; }
details > .body { padding: 0 0 16px; font-size: 14px; }
.prose { white-space: pre-wrap; }

/* -- score grid --------------------------------------------------------- */
table.grid { width: 100%; border-collapse: separate; border-spacing: 2px; font-size: 12px; }
table.grid th { font-weight: 500; color: var(--ink-soft); text-align: center; padding: 4px; }
table.grid th.row-head { text-align: left; }
table.grid td {
  text-align: center; padding: 8px 6px; border-radius: 4px;
  font-weight: 600; font-variant-numeric: tabular-nums;
}
.legend { margin-top: 10px; display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ink-soft); }
.legend i { width: 14px; height: 14px; border-radius: 2px; display: inline-block; }

/* -- per-vendor detail -------------------------------------------------- */
.crit { padding: 12px 0; border-bottom: 1px solid var(--rule); }
.crit:last-child { border-bottom: 0; }
.crit-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.crit-name { font-size: 13px; font-weight: 600; }
.crit-score { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.crit-why { margin-top: 6px; font-size: 13px; color: var(--ink-soft); }
blockquote {
  margin: 8px 0 0; padding: 10px 12px;
  background: var(--surface); border-radius: 8px;
  font-size: 13px; font-style: italic;
}
blockquote cite { display: block; margin-top: 6px; font-size: 11px; font-style: normal; color: var(--ink-faint); }
.findings { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 4px; }
.findings ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.findings li { margin-bottom: 5px; }

/* -- controls (screen only) --------------------------------------------- */
.controls { margin-top: 20px; }
button.expand {
  font: inherit; font-size: 12px; font-weight: 500;
  padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: var(--surface-sunk); color: var(--ink); border: 1px solid var(--rule);
}

@media (max-width: 620px) {
  .findings { grid-template-columns: 1fr; }
  .rank-row { grid-template-columns: 20px minmax(0, 1fr) 52px; }
  .rank-row .bar { display: none; }
}

/* Screen only. Printed from a dark system theme, this palette put near-white
   ink on paper whose dark background the browser had dropped. */
@media screen and (prefers-color-scheme: dark) {
  :root {
    --ink: #f2f2ee; --ink-soft: #b4b3ad; --ink-faint: #8a8989;
    --surface: #1a1a1a; --surface-sunk: #242424; --rule: #3a3a38;
    --mark: #85ae56; --track: #355700;
    --bin-1: #284700; --bin-1-ink: #ffffff;
    --bin-2: #436801; --bin-2-ink: #ffffff;
    --bin-3: #749c45; --bin-3-ink: #1a1a1a;
    --bin-4: #95bd6a; --bin-4-ink: #1a1a1a;
    --bin-5: #cce5b5; --bin-5-ink: #1a1a1a;
  }
}

@media print {
  body { padding: 0; font-size: 11pt; }
  .controls { display: none; }
  h2 { margin-top: 24pt; }
  details, .verdict { background: transparent; padding-left: 0; padding-right: 0; }
  details { border-top: 1px solid var(--rule); border-radius: 0; }
  .verdict { border: 1px solid var(--rule); }
  h2, .verdict, .crit, details > summary { break-inside: avoid; }
}
`;

/** A tier's dot colour, for the report's own palette. */
const REPORT_TONE: Record<string, string> = {
  strong: "var(--good)",
  mixed: "var(--warning)",
  weak: "var(--critical)",
};

function verdictChip(percent: number | null | undefined): string {
  if (percent == null) return "";
  const tier = scoreTier(percent);
  return `<span class="chip" style="--chip-tone: ${REPORT_TONE[tier]}">${esc(
    TIER[tier].label
  )}</span>`;
}

function bar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  return `<div class="bar"><i style="width:${clamped.toFixed(1)}%"></i></div>`;
}

function scoreGridHtml(data: ReportData): string {
  if (!data.criteria.length || !data.vendors.length) return "";
  const head = data.vendors
    .map((v) => `<th>${esc(v.vendorName)}</th>`)
    .join("");
  const body = data.criteria
    .map((criterion) => {
      const cells = data.vendors
        .map((vendor) => {
          const entry = vendor.scores[criterion.id];
          if (!entry) return `<td style="color:var(--ink-faint)">—</td>`;
          const bin = scoreBin(entry.percent);
          return `<td style="background:var(--bin-${bin});color:var(--bin-${bin}-ink)">${esc(
            formatScore(entry.percent)
          )}</td>`;
        })
        .join("");
      return `<tr><th class="row-head">${esc(criterion.name)} <span style="font-weight:400">${num(
        criterion.weight
      )}%</span></th>${cells}</tr>`;
    })
    .join("");
  const legend = BINS.map(
    ({ bin }) => `<i style="background:var(--bin-${bin})"></i>`
  ).join("");

  return `
    <table class="grid">
      <caption class="eyebrow" style="text-align:left;padding-bottom:8px">Score by criterion, as a percentage of each maximum</caption>
      <thead><tr><th class="row-head">Criterion</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="legend"><span>Score</span>${legend}<span>0 → 100%</span></div>`;
}

function vendorDetailHtml(vendor: ReportVendor, data: ReportData): string {
  const criteria = data.criteria
    .map((criterion) => {
      const entry = vendor.scores[criterion.id];
      if (!entry) return "";
      const quote = entry.evidence_quote
        ? `<blockquote>“${esc(entry.evidence_quote)}”${
            entry.page_ref
              ? `<cite>Page ${esc(entry.page_ref)} of the proposal</cite>`
              : ""
          }</blockquote>`
        : "";
      return `
        <div class="crit">
          <div class="crit-head">
            <span class="crit-name">${esc(criterion.name)}</span>
            <span class="crit-score">${esc(
              formatScore(entry.score)
            )}/${esc(entry.max)}${
              entry.overridden ? " (yours)" : ""
            }</span>
          </div>
          ${entry.rationale ? `<p class="crit-why">${esc(entry.rationale)}</p>` : ""}
          ${quote}
        </div>`;
    })
    .join("");

  const findings =
    vendor.strengths.length || vendor.weaknesses.length
      ? `<div class="findings">
          <div><h3>Strengths</h3><ul>${vendor.strengths
            .map((s) => `<li>${esc(s)}</li>`)
            .join("")}</ul></div>
          <div><h3>Weaknesses</h3><ul>${vendor.weaknesses
            .map((w) => `<li>${esc(w)}</li>`)
            .join("")}</ul></div>
        </div>`
      : "";

  return `
    <details>
      <summary>${esc(vendor.vendorName)} — ${esc(
        formatScore(vendor.overallScore)
      )}/100${vendor.rank ? ` · rank ${num(vendor.rank)}` : ""}</summary>
      <div class="body">
        ${vendor.summary ? `<p>${esc(vendor.summary)}</p>` : ""}
        ${findings}
        <h3 style="margin-top:20px">Criterion by criterion</h3>
        ${criteria}
      </div>
    </details>`;
}

/**
 * Build the report.
 *
 * The order is the argument: who won and why, then the ranking, then the
 * questions to ask at interview. Everything a reader would only want if they
 * disagreed — the full analysis, the close calls, every criterion's reasoning
 * and quoted evidence — sits behind a disclosure, present and out of the way.
 */
export function buildReportHtml(data: ReportData): string {
  const ranked = [...data.vendors].sort(
    (a, b) => (a.rank ?? 999) - (b.rank ?? 999)
  );
  const winner = ranked[0];
  const runnerUp = ranked[1];

  const margin =
    winner?.overallScore != null && runnerUp?.overallScore != null
      ? winner.overallScore - runnerUp.overallScore
      : null;

  const marginNote =
    margin == null || data.rankingStale
      ? ""
      : margin < 3
        ? `<p class="margin-note">This is close — ${esc(
            formatScore(margin)
          )} points clear of ${esc(
            runnerUp.vendorName
          )}. Treat the ranking as a starting point for the interview, not a conclusion.</p>`
        : `<p class="margin-note">${esc(
            formatScore(margin)
          )} points clear of ${esc(runnerUp.vendorName)}.</p>`;

  const verdict = winner
    ? `
    <section class="verdict">
      <p class="eyebrow">${
        data.rankingStale ? "Ranked first when this ran" : "Recommended"
      }</p>
      <div style="display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:flex-start;margin-top:6px">
        <div style="min-width:0">
          <p class="verdict-name">${esc(winner.vendorName)}</p>
          <div style="margin-top:8px">${verdictChip(winner.overallScore)}</div>
        </div>
        <div style="text-align:right">
          <p class="hero-score">${esc(
            formatScore(winner.overallScore)
          )}<span> / 100</span></p>
          <p class="meta" style="margin-top:4px">Weighted across ${
            data.criteria.length
          } criteria</p>
        </div>
      </div>
      ${
        winner.rankRationale
          ? `<p class="verdict-why">${esc(winner.rankRationale)}</p>`
          : winner.summary
            ? `<p class="verdict-why">${esc(winner.summary)}</p>`
            : ""
      }
      ${marginNote}
    </section>`
    : "";

  const rankRows = ranked
    .map(
      (vendor) => `
      <div class="rank-row">
        <span class="rank-no">${vendor.rank == null ? "—" : num(vendor.rank)}</span>
        <span class="rank-name">${esc(vendor.vendorName)}</span>
        ${bar(vendor.overallScore ?? 0)}
        <span class="rank-value">${esc(formatScore(vendor.overallScore))}</span>
      </div>`
    )
    .join("");

  // Where the proposals went. A committee reading this deserves the answer
  // without looking up a model id: the models named above ran on a US
  // provider's servers, nothing was retained, and the models' developers
  // never saw the documents.
  const provenanceModels = [
    ...new Set([...(data.scoringModels ?? []), ...(data.rankingModel ? [data.rankingModel] : [])]),
  ]
    .map((m) => describeModel(m))
    .filter((d) => d.provenance);
  const provenance = provenanceModels.length
    ? `<p class="meta">${esc(
        provenanceModels.length === 1
          ? `${provenanceModels[0].name}: ${provenanceModels[0].provenance}`
          : provenanceModels
              .map((d) => `${d.name}: ${d.provenance}`)
              .join(" ")
      )}</p>`
    : "";

  const stale = data.rankingStale
    ? `<p class="stale"><strong>This ranking is out of date.</strong>
       ${
         data.scoresCurrent === false
           ? `Not every score in this report is current — the note below says
       which — so they cannot all be relied on. Bring the scoring up to date
       in OpenRFP and re-rank before using this report.`
           : `Every score in this report is the current one; the order is the
       one the model gave before the change. Re-rank in OpenRFP to bring the
       two back into line.`
       }${
         data.stalenessReasons?.length
           ? `<br><span style="color:var(--ink-soft)">${data.stalenessReasons
               .map((r) => esc(r))
               .join(" ")}</span>`
           : ""
       }</p>`
    : "";

  const interview = data.interviewFocusAreas.length
    ? `
    <h2>Ask at interview</h2>
    <ul class="checklist">${data.interviewFocusAreas
      .map((area) => `<li>${esc(area)}</li>`)
      .join("")}</ul>`
    : "";

  const closeCalls = data.closeCalls.length
    ? `
    <details>
      <summary>Close calls (${data.closeCalls.length})</summary>
      <div class="body">
        ${data.closeCalls
          .map(
            (cc) => `
          <div class="crit">
            <div class="crit-name">${esc(cc.criterionName)}</div>
            <p class="crit-why">${cc.contenders
              .map(
                (c) =>
                  `${esc(c.vendorName)} ${esc(formatScore(c.score))}`
              )
              .join(" · ")}</p>
            ${cc.note ? `<p class="crit-why">${esc(cc.note)}</p>` : ""}
          </div>`
          )
          .join("")}
      </div>
    </details>`
    : "";

  const analysis = data.comparativeAnalysis
    ? `
    <details>
      <summary>Full comparative analysis</summary>
      <div class="body prose">${esc(data.comparativeAnalysis)}</div>
    </details>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.rfpTitle)} — evaluation report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">RFP evaluation</p>
  <h1>${esc(data.rfpTitle)}</h1>
  <p class="meta">
    ${esc(data.vendors.length)} proposals · ${esc(
      data.criteria.length
    )} criteria · ${esc(data.generatedAt)}${
      data.scoringModels?.length
        ? ` · scored by ${data.scoringModels
            .map((m) => esc(describeModel(m).name))
            .join(", ")}`
        : ""
    }${
      data.rankingModel
        ? ` · ranked by ${esc(describeModel(data.rankingModel).name)}`
        : ""
    }
  </p>
  ${provenance}

  ${verdict}

  <h2>Ranking</h2>
  ${stale}
  ${rankRows}

  ${interview}

  <h2>Detail</h2>
  <p class="meta">Everything the ranking rests on, including the passages quoted from each proposal.</p>
  <div class="controls">
    <button class="expand" type="button" id="expand-all">Expand everything</button>
  </div>
  ${analysis}
  ${closeCalls}
  <details>
    <summary>Score grid — every criterion, every vendor</summary>
    <div class="body">${scoreGridHtml(data)}</div>
  </details>
  ${ranked.map((vendor) => vendorDetailHtml(vendor, data)).join("")}

  <hr class="rule">
  <p class="meta">
    Scores are a reading of each proposal against the rubric above, with the
    passage behind every score quoted. They are an input to a decision, not the
    decision. Generated by OpenRFP.
  </p>
</div>
<script>
  // Two conveniences, and the reason this file carries any script at all:
  // a printed report with everything collapsed is a report with no content,
  // and a reader who wants it all should not click twelve times.
  (function () {
    var all = document.querySelectorAll("details");
    var button = document.getElementById("expand-all");
    if (button) {
      button.addEventListener("click", function () {
        var open = button.getAttribute("data-open") === "1";
        all.forEach(function (d) { d.open = !open; });
        button.setAttribute("data-open", open ? "0" : "1");
        button.textContent = open ? "Expand everything" : "Collapse everything";
      });
    }
    window.addEventListener("beforeprint", function () {
      all.forEach(function (d) { d.open = true; });
    });
  })();
</script>
</body>
</html>`;
}

export function exportReport(data: ReportData) {
  downloadFile(
    buildReportHtml(data),
    `${slug(data.rfpTitle)}-evaluation-report.html`,
    "text/html;charset=utf-8;"
  );
}
