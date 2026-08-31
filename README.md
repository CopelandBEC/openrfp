# OpenRFP

**AI-powered RFP evaluation tool for institutional facilities management.**

Free, open source, and transparent. Upload your RFP, get an AI-generated evaluation rubric, upload vendor responses, and receive scored evaluations with cited evidence.

Built by [Copeland Building Envelope Consulting](https://copelandbec.com) as an open-source contribution to the industry.

## How it works

1. **Upload your RFP** — The AI reads it and generates a customized evaluation rubric with weighted criteria and scoring scales, specialized for building envelope and facilities management projects.
2. **Upload vendor responses** — The AI evaluates each response against the rubric, scoring each criterion with a rationale and a direct quote from the proposal as evidence.
3. **Compare and decide** — Get a side-by-side ranking with comparative analysis, close-call flags, and recommended interview questions. Override any score you disagree with.

**Uploads are text-searchable PDFs only.** The app extracts text with
`pdf-parse` and evaluates that text; it does not currently send page images to a
vision model, so diagrams and photos don't contribute to scores. Scanned PDFs
without an OCR layer are detected and flagged rather than silently scored on
empty text. Word documents need to be exported to PDF first — native DOCX
parsing is on the roadmap.

## Transparency

Every evaluation prompt, scoring rubric, and comparison logic is visible in this repository. You can see exactly how the AI is instructed to evaluate proposals. See [`src/lib/prompts/`](src/lib/prompts/) for the prompt source code.

## Tech stack

- **Frontend:** Next.js 16 + React 19 + TypeScript + shadcn/ui + Tailwind CSS
- **Backend:** Supabase (PostgreSQL + Auth + Storage + Row-Level Security)
- **AI:** Fireworks AI (model-agnostic architecture — switch models via env vars)
- **Hosting:** Vercel

## Getting started

### Prerequisites

- Node.js 18+ 
- A [Supabase](https://supabase.com) account (free tier)
- A [Fireworks AI](https://fireworks.ai) API key
- A [Vercel](https://vercel.com) account (for deployment)

### Installation

```bash
git clone https://github.com/CopelandBEC/openrfp.git
cd openrfp
npm install
```

### Environment setup

Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

`.env.example` documents every variable the app reads, including the per-user
hourly cap on AI calls (`AI_RATE_LIMIT_PER_HOUR`). The AI provider key is held
server-side, so leaving that cap unset on a public deployment means any account
that signs up can spend your provider budget.

### Database setup

1. Create a new Supabase project
2. Run the SQL in `supabase/schema.sql` in the Supabase SQL Editor
3. Copy your Supabase URL and keys to `.env.local`

`schema.sql` is idempotent — re-run the whole file to pick up schema or policy
changes without recreating the project.

**Configure custom SMTP before inviting anyone.** Supabase's built-in email
service is capped at 2 messages per hour per project, shared across magic links,
signups and password resets, and is documented as test-only. Sign-in appears
broken under that cap. Add an SMTP provider under **Authentication → SMTP
Settings**, then raise **Authentication → Rate Limits**. Also add every origin
you deploy to (including preview URLs) to **Authentication → URL Configuration →
Redirect URLs**, or the emailed link will refuse to complete sign-in.

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

### Deployment

Deploy to Vercel with one click — just connect the GitHub repo and add your environment variables.

The AI routes declare `maxDuration = 300`. Evaluating a long proposal can run
well past a platform's default function timeout, and a request killed mid-call
leaves the response marked `error`.

## Configuration

### Switching AI models

The app uses a model-agnostic architecture. To change the AI model, just update environment variables:

```env
AI_PROVIDER=fireworks
AI_MODEL=accounts/fireworks/models/kimi-k3
AI_BASE_URL=https://api.fireworks.ai/inference/v1
```

Any OpenAI-compatible API works, provided the model supports
`response_format: { type: "json_object" }` — every route parses the model's
reply as JSON. Document text is truncated at `AI_MAX_DOC_CHARS` (default
400,000) before it is sent, so a very long PDF doesn't overrun a smaller
model's context window. See `.env.example` for all options.

## Status

OpenRFP is in active development and not yet production-ready. The full flow —
upload, rubric, evaluation, comparison, CSV/JSON export — is implemented, but
it has not been exercised end to end against a large real RFP.

Known gaps:

- The four `/rfp/[id]/*` screens fetch from the browser inside effects. Moving
  that to server components would remove the loading flashes and the
  `react-hooks/set-state-in-effect` suppressions those pages carry.
- No PDF export (CSV and JSON only), no BYOK, no rubric templates.
- Vision/page-image evaluation is specified in `SPEC.md` but not built; scoring
  is text-only.

## Contributing

Contributions are welcome. CopelandBEC maintains this project. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE)
