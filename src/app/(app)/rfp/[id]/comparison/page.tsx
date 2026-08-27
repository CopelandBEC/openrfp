"use client";

import { use, useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RankingEntry {
  response_id: string;
  vendor_name: string;
  rank: number;
  overall_score: number;
  rationale: string;
}

interface CloseCallResponse {
  response_id: string;
  vendor_name: string;
  score: number;
}

interface CloseCall {
  criterion_id: string;
  criterion_name: string;
  responses: CloseCallResponse[];
  note: string;
}

interface Comparison {
  id: string;
  rfp_id: string;
  ranking: RankingEntry[];
  comparative_analysis: string;
  close_calls: CloseCall[];
  model_used?: string;
  prompt_version?: string;
  created_at: string;
  interview_focus_areas?: string[];
}

interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoring_scale: number;
  scale_descriptions?: Record<string, string>;
}

interface Rubric {
  id: string;
  rfp_id: string;
  criteria: RubricCriterion[];
  total_weight: number;
  ai_generated: boolean;
  edited_by_user: boolean;
  locked: boolean;
  created_at: string;
}

interface ScoreEntry {
  score: number;
  max: number;
  rationale: string;
  evidence_quote: string;
  page_ref: string | null;
}

interface Evaluation {
  id: string;
  response_id: string;
  rfp_id: string;
  scores: Record<string, ScoreEntry>;
  overall_score: number;
  summary: string;
  strengths: string;
  weaknesses: string;
  model_used: string;
  prompt_version: string;
  created_at: string;
}

interface Response {
  id: string;
  rfp_id: string;
  vendor_name: string;
  file_path: string | null;
  extracted_text: string | null;
  ocr_status: string | null;
  page_count: number | null;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreBadge(score: number) {
  if (score >= 80) {
    return (
      <Badge className="bg-primary/15 text-primary border-primary/30">
        {score.toFixed(1)}
      </Badge>
    );
  } else if (score >= 60) {
    return (
      <Badge className="bg-yellow-100 text-yellow-800 border-yellow-300">
        {score.toFixed(1)}
      </Badge>
    );
  } else {
    return (
      <Badge className="bg-destructive/10 text-destructive border-destructive/30">
        {score.toFixed(1)}
      </Badge>
    );
  }
}

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

function sanitizeCSVCell(value: string): string {
  // Prevent formula injection: prefix cells starting with =, +, -, or @
  const escaped = `"${value.replace(/"/g, '""')}"`;
  if (/^[=+\-@]/.test(value)) {
    return `'${escaped}`;
  }
  return escaped;
}

function exportCSV(ranking: RankingEntry[]) {
  const rows = [
    ["Rank", "Vendor", "Overall Score", "Rationale"],
    ...ranking
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((r) => [
        String(r.rank),
        sanitizeCSVCell(r.vendor_name),
        r.overall_score != null ? r.overall_score.toFixed(1) : "—",
        sanitizeCSVCell(r.rationale || ""),
      ]),
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  downloadFile(csv, "comparison-ranking.csv", "text/csv;charset=utf-8;");
}

function exportJSON(comparison: Comparison) {
  const json = JSON.stringify(comparison, null, 2);
  downloadFile(json, "comparison.json", "application/json");
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      {label && (
        <span className="text-sm text-muted-foreground">{label}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ComparisonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const supabase = useMemo(() => createClient(), []);

  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [responses, setResponses] = useState<Response[]>([]);
  const [rubric, setRubric] = useState<Rubric | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // -- fetch all data -------------------------------------------------------

  const fetchData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoading(true);
      }
      setError(null);

      try {
        const [
          comparisonRes,
          evaluationsRes,
          responsesRes,
          rubricRes,
        ] = await Promise.all([
          supabase
            .from("comparisons")
            .select("*")
            .eq("rfp_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase.from("evaluations").select("*").eq("rfp_id", id),
          supabase.from("responses").select("*").eq("rfp_id", id),
          supabase
            .from("rubrics")
            .select("*")
            .eq("rfp_id", id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (comparisonRes.error) throw comparisonRes.error;
        if (evaluationsRes.error) throw evaluationsRes.error;
        if (responsesRes.error) throw responsesRes.error;
        if (rubricRes.error) throw rubricRes.error;

        setComparison((comparisonRes.data as Comparison) ?? null);
        setEvaluations((evaluationsRes.data as Evaluation[]) ?? []);
        setResponses((responsesRes.data as Response[]) ?? []);
        setRubric((rubricRes.data as Rubric) ?? null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load comparison data"
        );
      } finally {
        setLoading(false);
      }
    },
    [id, supabase]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // -- generate comparison --------------------------------------------------

  const generateComparison = useCallback(async () => {
    setGenerating(true);
    setError(null);

    try {
      const res = await fetch("/api/compare-responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rfp_id: id }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      await fetchData({ silent: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate comparison"
      );
    } finally {
      setGenerating(false);
    }
  }, [id, fetchData]);

  // -- derived data ---------------------------------------------------------

  const sortedRanking = useMemo(() => {
    if (!comparison?.ranking) return [];
    return [...comparison.ranking].sort((a, b) => a.rank - b.rank);
  }, [comparison]);

  const criteriaList = useMemo<RubricCriterion[]>(() => {
    if (!rubric?.criteria) return [];
    if (Array.isArray(rubric.criteria)) return rubric.criteria;
    const maybe = rubric.criteria as unknown as {
      criteria?: RubricCriterion[];
    };
    return maybe.criteria ?? [];
  }, [rubric]);

  // Map response_id → vendor_name from responses table (fallback)
  const vendorByResponseId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of responses) {
      map.set(r.id, r.vendor_name);
    }
    return map;
  }, [responses]);

  // Map response_id → evaluation
  const evalByResponseId = useMemo(() => {
    const map = new Map<string, Evaluation>();
    for (const e of evaluations) {
      map.set(e.response_id, e);
    }
    return map;
  }, [evaluations]);

  // All vendor responses that have evaluations (for per-criterion table columns)
  const evaluatedResponses = useMemo(() => {
    return responses
      .filter((r) => evalByResponseId.has(r.id))
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  }, [responses, evalByResponseId]);

  // Interview focus areas
  const interviewFocusAreas = useMemo<string[]>(() => {
    if (comparison?.interview_focus_areas?.length) {
      return comparison.interview_focus_areas;
    }
    // Derive from close calls notes
    if (comparison?.close_calls?.length) {
      return comparison.close_calls.map(
        (cc) => cc.note || `Review ${cc.criterion_name}`
      );
    }
    return [];
  }, [comparison]);

  // -- render ---------------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link
            href="/dashboard"
            className="text-lg font-bold tracking-tight text-primary"
          >
            OpenRFP
          </Link>
          <div className="flex items-center gap-6">
            <Link
              href={`/rfp/${id}/evaluations`}
              className="text-sm text-muted-foreground hover:text-primary"
            >
              ← Evaluations
            </Link>
            <Link
              href="/dashboard"
              className="text-sm text-muted-foreground hover:text-primary"
            >
              ← Back to dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-5xl px-4 py-8 space-y-6">
        {/* Title */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">
            Comparison &amp; Ranking
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Side-by-side comparison of all evaluated responses.
          </p>
        </div>

        {/* Error */}
        {error && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="p-4">
              <p className="text-sm text-destructive">
                <strong>Error:</strong> {error}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Loading state */}
        {loading && <Spinner label="Loading comparison…" />}

        {/* No evaluations */}
        {!loading && !evaluations.length && (
          <Card className="border-border">
            <CardContent className="p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No evaluations found. Go back and evaluate your responses first.
              </p>
              <Button className="mt-4" variant="outline">
                <Link href={`/rfp/${id}/evaluations`}>← Go to Evaluations</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Evaluations loading — spinner */}
        {!loading && evaluations.length > 0 && (
          <>
            {/* No comparison yet — show generate button */}
            {!comparison && (
              <Card className="border-border">
                <CardContent className="p-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    No comparison has been generated yet. Click below to run the
                    AI comparison.
                  </p>
                  <Button
                    className="mt-4"
                    onClick={generateComparison}
                    disabled={generating}
                  >
                    {generating ? "Generating…" : "Generate Comparison"}
                  </Button>
                  {generating && <Spinner label="Generating comparison…" />}
                </CardContent>
              </Card>
            )}

            {/* Comparison exists — show everything */}
            {comparison && (
              <>
                {/* Export buttons */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportCSV(sortedRanking)}
                  >
                    Export to CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportJSON(comparison)}
                  >
                    Export to JSON
                  </Button>
                  <span className="text-xs text-muted-foreground ml-auto">
                    Model: {comparison.model_used || "—"} ·{" "}
                    {new Date(comparison.created_at).toLocaleDateString()}
                  </span>
                </div>

                <Separator />

                {/* Ranked Table */}
                <Card className="border-border">
                  <CardHeader>
                    <CardTitle className="text-lg font-semibold text-primary">
                      Ranked Results
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="w-16 text-left">
                              Rank
                            </TableHead>
                            <TableHead className="text-left">Vendor</TableHead>
                            <TableHead className="w-32 text-left">
                              Overall Score
                            </TableHead>
                            <TableHead className="text-left">
                              Key Rationale
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sortedRanking.map((entry) => (
                            <TableRow key={entry.response_id}>
                              <TableCell className="font-semibold text-primary">
                                {entry.rank}
                              </TableCell>
                              <TableCell className="font-medium">
                                {entry.vendor_name ??
                                  (vendorByResponseId.get(entry.response_id) ??
                                    "Unknown")}
                              </TableCell>
                              <TableCell>
                                {scoreBadge(entry.overall_score)}
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {entry.rationale}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>

                {/* Comparative Analysis */}
                {comparison.comparative_analysis && (
                  <Card className="border-border bg-muted/30">
                    <CardHeader>
                      <CardTitle className="text-lg font-semibold text-primary">
                        Comparative Analysis
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                        {comparison.comparative_analysis}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Close Calls */}
                <Card className="border-border">
                  <CardHeader>
                    <CardTitle className="text-lg font-semibold text-primary">
                      Close Calls
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {comparison.close_calls?.length ? (
                      comparison.close_calls.map((cc, idx) => (
                        <div
                          key={`${cc.criterion_id}-${idx}`}
                          className="rounded-lg border border-border bg-muted/20 p-4"
                        >
                          <h4 className="text-sm font-semibold text-primary">
                            {cc.criterion_name}
                          </h4>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {cc.responses?.map((r) => (
                              <Badge
                                key={r.response_id}
                                variant="outline"
                                className="border-border"
                              >
                                {r.vendor_name}:{" "}
                                <span className="ml-1 font-semibold">
                                  {r.score.toFixed(1)}
                                </span>
                              </Badge>
                            ))}
                          </div>
                          <p className="mt-2 text-sm text-muted-foreground">
                            {cc.note}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No close calls — all rankings are decisive.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Interview Focus Areas */}
                <Card className="border-border">
                  <CardHeader>
                    <CardTitle className="text-lg font-semibold text-primary">
                      Interview Focus Areas
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {interviewFocusAreas.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                        {interviewFocusAreas.map((area, i) => (
                          <li key={i}>{area}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No specific focus areas identified.
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* Per-criterion comparison table */}
                {criteriaList.length > 0 && evaluatedResponses.length > 0 && (
                  <Card className="border-border">
                    <CardHeader>
                      <CardTitle className="text-lg font-semibold text-primary">
                        Per-Criterion Breakdown
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="overflow-x-auto rounded-md border border-border">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/50">
                              <TableHead className="text-left sticky left-0 bg-muted/50">
                                Criterion
                              </TableHead>
                              {evaluatedResponses.map((r) => (
                                <TableHead
                                  key={r.id}
                                  className="text-left text-xs"
                                >
                                  {r.vendor_name}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {criteriaList.map((criterion) => {
                              const scores =
                                evaluatedResponses.map((r) => {
                                  const ev = evalByResponseId.get(r.id);
                                  const s = ev?.scores?.[criterion.id];
                                  return s
                                    ? { ...s, response_id: r.id }
                                    : null;
                                });
                              const validScores = scores.filter(
                                (s) => s !== null
                              ) as (ScoreEntry & {
                                response_id: string;
                              })[];
                              const maxScore = validScores.length
                                ? Math.max(
                                    ...validScores.map((s) => s.score)
                                  )
                                : null;
                              const minScore = validScores.length
                                ? Math.min(
                                    ...validScores.map((s) => s.score)
                                  )
                                : null;

                              return (
                                <TableRow key={criterion.id}>
                                  <TableCell className="font-medium sticky left-0 bg-background">
                                    {criterion.name}
                                  </TableCell>
                                  {evaluatedResponses.map((r) => {
                                    const ev = evalByResponseId.get(r.id);
                                    const s = ev?.scores?.[criterion.id];
                                    if (!s) {
                                      return (
                                        <TableCell
                                          key={r.id}
                                          className="text-xs text-muted-foreground"
                                        >
                                          —
                                        </TableCell>
                                      );
                                    }
                                    let cellClass = "";
                                    if (
                                      maxScore !== null &&
                                      s.score === maxScore
                                    ) {
                                      cellClass = "bg-primary/10";
                                    } else if (
                                      minScore !== null &&
                                      s.score === minScore
                                    ) {
                                      cellClass = "bg-destructive/10";
                                    }
                                    return (
                                      <TableCell
                                        key={r.id}
                                        className={`text-xs ${cellClass}`}
                                      >
                                        <span className="font-semibold">
                                          {s.score.toFixed(1)}
                                        </span>
                                        <span className="text-muted-foreground">
                                          /{s.max.toFixed(1)}
                                        </span>
                                      </TableCell>
                                    );
                                  })}
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Regenerate button */}
                <div className="flex justify-end pt-4">
                  <Button
                    variant="outline"
                    onClick={generateComparison}
                    disabled={generating}
                  >
                    {generating ? "Regenerating…" : "Regenerate Comparison"}
                  </Button>
                </div>
                {generating && <Spinner label="Regenerating comparison…" />}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
