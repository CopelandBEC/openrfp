import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GuestStartButton } from "@/components/guest-start-button";

export const metadata: Metadata = {
  title: "OpenRFP — Intelligent RFP evaluation, free and open source",
  description:
    "Upload your RFP, get an automatically generated evaluation rubric, upload vendor responses, and receive scored evaluations with cited evidence. Free, open source, and transparent.",
};

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="border-b border-border">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight text-primary">
              OpenRFP
            </span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              open source
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/CopelandBEC/openrfp"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-primary"
            >
              GitHub
            </a>
            <Link href="/login">
              <Button variant="outline" size="sm">
                Sign in
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1">
        <div className="container mx-auto px-4 py-20 md:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-bold tracking-tight md:text-6xl">
              Evaluate RFP responses intelligently.
              <br />
              <span className="text-muted-foreground">
                Free, open source, transparent.
              </span>
            </h1>
            <p className="mt-6 text-lg text-muted-foreground md:text-xl">
              Upload your RFP and get an automatically generated evaluation
              rubric. Upload vendor responses and receive scored evaluations
              with cited evidence — then compare all responses side by side.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:items-start">
              <GuestStartButton size="lg">
                Start evaluating — no account needed
              </GuestStartButton>
              <a
                href="https://github.com/CopelandBEC/openrfp"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="lg" className="w-full sm:w-auto">
                  View Source Code
                </Button>
              </a>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Run a full evaluation first. Add an email afterwards only if you
              want to keep it.
            </p>
          </div>
        </div>

        {/* How it works */}
        <div className="border-t border-border bg-muted/30">
          <div className="container mx-auto px-4 py-16">
            <h2 className="text-center text-2xl font-semibold text-foreground">
              How it works
            </h2>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {[
                {
                  step: "1",
                  title: "Upload your RFP",
                  description:
                    "Upload your RFP document. OpenRFP reads it and generates a customized evaluation rubric with weighted criteria and scoring scales — specialized for building envelope and facilities management projects.",
                },
                {
                  step: "2",
                  title: "Upload vendor responses",
                  description:
                    "Upload each vendor's proposal. OpenRFP evaluates every response against the rubric — scoring each criterion with a rationale and a direct quote from the proposal as evidence.",
                },
                {
                  step: "3",
                  title: "Compare and decide",
                  description:
                    "Get a side-by-side ranking with comparative analysis, close-call flags, and recommended interview questions. Override any score you disagree with, and export the ranking to CSV or JSON for your board — no account required.",
                },
              ].map((item) => (
                <Card key={item.step}>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                        {item.step}
                      </span>
                      <CardTitle className="text-primary">
                        {item.title}
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>

        {/* Trust section */}
        <div className="border-t border-border">
          <div className="container mx-auto px-4 py-16">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-2xl font-semibold text-foreground">
                Built for trust and transparency
              </h2>
              <p className="mt-4 text-muted-foreground">
                Every evaluation rubric, scoring criterion, and comparison
                logic is visible in the open-source repository. You can see
                exactly how evaluations are structured — and audit every score
                against cited evidence from the actual proposals.
              </p>
              <div className="mt-8 flex flex-col items-center justify-center gap-4 text-sm text-muted-foreground sm:flex-row sm:gap-8">
                <div>
                  <span className="font-semibold text-primary">
                    Open source
                  </span>{" "}
                  · MIT licensed
                </div>
                <div>
                  <span className="font-semibold text-primary">
                    No vendor lock-in
                  </span>{" "}
                  · Your data stays yours
                </div>
                <div>
                  <span className="font-semibold text-primary">Free</span>{" "}
                  · No subscription
                </div>
              </div>
              <p className="mt-6 text-sm text-muted-foreground">
                An account is only ever for keeping your work — saved history,
                picking an evaluation back up later, and adding responses to one
                you already ran. Everything else works as a guest.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="container mx-auto px-4 py-8">
          <div className="flex flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
            <div>
              An open-source contribution by{" "}
              <a
                href="https://copelandbec.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                Copeland Building Envelope Consulting
              </a>
            </div>
            <div className="flex gap-4">
              <a
                href="https://github.com/CopelandBEC/openrfp"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary"
              >
                GitHub
              </a>
              <a
                href="https://copelandbec.com"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-primary"
              >
                CopelandBEC
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
