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
- **AI:** Fireworks AI, a US company. The default model is Kimi K3, an
  open-weight model that Fireworks serves; Fireworks does not store prompts or
  outputs or use them for training, and the model's developer (Moonshot AI)
  never receives your documents. The architecture is model-agnostic — switch
  models via env vars.
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

**Re-run `schema.sql` before deploying the version that added `updated_at` to
`rubrics`, `evaluations` and `comparisons`, `rubric_updated_at` to
`evaluations`, `evaluation_revisions` to `comparisons`, and `served_by` to
both, not after.** The dashboard reads those columns to tell a
current ranking from one that predates a score or a rubric change, and the
scoring route stamps each evaluation with the rubric it scored against.
PostgREST rejects the whole query when a selected column is missing — so until
the migration is applied the dashboard cannot list any RFPs and scoring fails.
After it is applied, every existing ranking reads as out of date once — nothing
recorded which scores it saw, and the migration does not pretend to know — and
one re-rank per RFP clears it. Existing rows also carry no record of which
endpoint served them, so the screens name their model without saying where it
ran; if every row was produced through the default endpoint, `schema.sql` has a
commented statement that records that, to run deliberately. It says so, with the
database's message, rather than rendering its empty state; nothing is lost and
applying the schema restores them. The backfill sets `updated_at` from
`created_at`, so existing rows read as last changed when they were made rather
than all reading as "changed just now".

**Upgrading from a version without guest mode? Re-run `schema.sql` before you
deploy the new code, not after.** The AI routes now reserve every call through
`reserve_ai_call` and fail closed, so until that function exists every rubric,
evaluation and comparison request answers 503 ("Couldn't reserve this
evaluation just now"). The reverse order is tolerable for a short window: the
new schema stops the *old* code's usage rows from being written, which relaxes
the spend cap until the new code is live. Do both in one sitting.

**Add every origin you deploy to** (including preview URLs) under
**Authentication → URL Configuration → Redirect URLs**, or the emailed link will
refuse to complete sign-in. Use a wildcard on the path — for example
`https://your-app.vercel.app/auth/callback**` — because the "save my work"
confirmation link carries a `?next=` query string, and Supabase matches
non-Site-URL redirects against this list as glob patterns, so an exact
`/auth/callback` entry does not cover it.

### Email setup (Resend)

Email is only needed when someone saves their work — a guest can run a whole
evaluation without it — but sign-in is broken without it, so configure it before
inviting anyone.

Supabase's built-in email service is capped at **2 messages per hour per
project**, shared across every kind of auth email, and is documented as
test-only. Under that cap sign-in simply appears broken. Resend's free tier
(3,000/month, 100/day) is enough for this and takes a few minutes:

1. Create an account at [resend.com](https://resend.com).
2. **Domains → Add Domain**, enter a domain you control, and add the DNS records
   it shows you (SPF and DKIM as `TXT`, plus the `MX` record for bounces). Wait
   for the domain to read **Verified**.
   *Skipping this is the usual mistake:* until a domain is verified Resend only
   delivers to the address that owns the account, so invites appear to send and
   silently never arrive.
3. **API Keys → Create API Key**, with Sending access. Copy the `re_…` value —
   it is shown once.
4. In Supabase, go to **Authentication → Emails → SMTP Settings**, enable
   **Custom SMTP**, and enter:

   | Field | Value |
   | --- | --- |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | your `re_…` API key |
   | Sender email | an address at your verified domain, e.g. `no-reply@yourdomain.com` |
   | Sender name | `OpenRFP` |

5. Raise **Authentication → Rate Limits → Rate limit for sending emails** from
   the default `2` per hour to something realistic (30 is a reasonable start).
   *Changing the SMTP settings does not raise this on its own* — it stays at 2
   until you change it, which looks exactly like the SMTP setup having failed.
6. Send yourself a magic link to confirm delivery end to end.

Supabase also publishes a Resend integration that fills in the SMTP fields for
you; the manual route above is the same configuration, and worth knowing when
something needs debugging.

### Guest sessions

A visitor can upload an RFP, generate a rubric, upload responses and read the
full comparison without an account. Only *keeping* that work needs an email.

This uses Supabase anonymous sign-in: a guest gets a real row in `auth.users`
and a real JWT, so every row-level security policy applies to them unchanged.
When they later choose **Save to an account**, `updateUser({ email })` attaches
an email to that same user id — nothing is copied or migrated, and the account
simply stops being anonymous.

Two settings make this work, both under **Authentication**:

1. **Sign In / Providers → Allow anonymous sign-ins: on.** Without it the guest
   button fails and visitors are pushed back to the magic-link form.
2. **Attack Protection → enable CAPTCHA, provider Cloudflare Turnstile**, and
   paste in your Turnstile *secret* key. Put the matching **site** key in
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.

   **Deploy the site key before you flip this switch.** CAPTCHA protection is
   project-wide — it covers the magic-link endpoint as much as anonymous
   sign-in — so enabling it while the deployed build has no site key takes
   *all* sign-in down, not just the guest path. `NEXT_PUBLIC_` values are
   inlined at build time, so setting the variable in Vercel needs a redeploy
   to take effect; adding it to an existing deployment's settings alone does
   nothing.

**Turnstile is not optional on a public deployment.** Guest sessions are the
only signup path with no email step, and each one carries its own allowance of
calls against your server-side AI key. Without a CAPTCHA, minting unlimited
sessions is a page reload. Supabase verifies the token at its own auth endpoint,
so the check holds even against a caller who bypasses this app's UI entirely.
Leave the variable unset in local development, where it is only friction.

#### Guest limits

Limits live in the `public.ai_limits` table rather than in environment
variables, because `reserve_ai_call` is reachable over PostgREST by any
signed-in caller — a limit sent from the app can only ever *tighten* the one
stored server-side, never raise it. Defaults:

| Column | Default | Applies to |
| --- | --- | --- |
| `member_hourly_limit` | 20 | AI calls/hour for a signed-in account |
| `guest_hourly_limit` | 6 | AI calls/hour for one guest session |
| `guest_ip_hourly_limit` | 12 | AI calls/hour for all guests behind one IP |
| `guest_rfp_limit` | 3 | RFPs one guest session may create |
| `guest_file_limit` | 12 | Uploaded files, and response rows, per guest |

Change one with an `UPDATE` from the SQL Editor:

```sql
update public.ai_limits set guest_hourly_limit = 4;
```

`AI_RATE_LIMIT_PER_HOUR` still works and is applied on top, but only ever as
the stricter of the two. It defaults to off (0); if you set it, remember that
raising `member_hourly_limit` above it in the table has no effect.

A guest holds an ordinary JWT, so they can upload straight to the Storage API
without going through this app. `guest_file_limit` is therefore enforced by the
storage policy itself, and the `rfp-files` bucket carries a 25 MB size limit and
a PDF-only MIME allowlist — the upload routes check both, but only for uploads
that come through the app.

The per-IP ceiling is defence in depth rather than a hard boundary: it needs
`IP_HASH_SECRET` set to be active at all, it exempts signed-in members so a
shared office NAT can't lock an organization out of its own account, and since
this repository is public, someone reading this file could call the reservation
function directly with a fabricated hash. The guarantees that do hold under
that are the CAPTCHA on session creation, the per-session cap, and the guest
RFP cap — the first and last are enforced by Supabase and by RLS, where a
forged argument cannot reach them.

#### Cleaning up abandoned guests

Guest rows are permanent and count toward your project's monthly active users,
so sweep them periodically. Run:

```bash
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
node scripts/purge-stale-guests.mjs --older-than "30 days"
```

Add `--dry-run` to see what would go without deleting anything.

This is a script rather than a cron job in SQL because deleting a row from
`storage.objects` removes only Storage's metadata — the object itself stays in
the bucket, and with the row gone nothing is left to find it by. Files have to
be removed through the Storage API, so the script does that first and then asks
the database to delete the accounts. As a backstop, `delete_stale_guests()`
skips any guest that still owns objects, so an interrupted run leaves work to
finish rather than bytes stranded.

The service role key bypasses row-level security. It belongs in the environment
of this job only — never in `.env.local`, and never behind a `NEXT_PUBLIC_`
prefix, which would ship it to the browser.

Staleness is measured from **last activity**, not signup: an anonymous session
stays valid as long as its refresh token is used, so a guest who started five
weeks ago may have uploaded something minutes ago. Activity is read from this
project's own tables (`rfps`, `responses`, `ai_usage`), which misses a guest who
only ever reads — acceptable on a 30-day window, and the reason unsaved guest
work is documented as impermanent. A guest who saved is never in scope, since
attaching an email clears the anonymous flag.

To run it on a schedule, point any scheduler you already have (GitHub Actions,
a Vercel cron hitting a small admin route, your own machine) at that command.
Inspect what a sweep would touch from the SQL Editor at any time:

```sql
select * from public.stale_guest_ids('30 days');
select * from public.stale_guest_files('30 days');
```

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
# Kimi K3, open-weight, served by Fireworks AI, a US company. Fireworks retains
# nothing; the model's developer never receives your documents.
AI_MODEL=accounts/fireworks/models/kimi-k3
AI_BASE_URL=https://api.fireworks.ai/inference/v1
```

Any OpenAI-compatible API works, provided the model supports
`response_format: { type: "json_object" }` — every route parses the model's
reply as JSON. Document text is truncated at `AI_MAX_DOC_CHARS` (default
400,000) before it is sent, so a very long PDF doesn't overrun a smaller
model's context window. See `.env.example` for all options.

### Latency

On a reasoning model, the dominant cost is the thinking that happens before the
JSON starts, and most models default to their highest effort. Three variables
set it per call site — `AI_REASONING_EFFORT_RUBRIC`,
`AI_REASONING_EFFORT_EVALUATION` and `AI_REASONING_EFFORT_COMPARISON` — with
the middle one, the call that runs once per proposal, deliberately low: it is
applying a rubric that already exists. Those defaults apply only to the default
model. If you set `AI_MODEL`, nothing is sent unless you set these too — an
OpenAI-compatible endpoint that does not accept the parameter rejects the whole
request, so a model swap must not start sending it unasked. Set a variable to
an empty string to omit the parameter for the default model as well.

Two things beyond model choice matter as much:

- The responses screen evaluates proposals concurrently, capped at
  `EVALUATION_CONCURRENCY` in `src/app/(app)/rfp/[id]/responses/page.tsx`.
  Serialised, an RFP cost one model call's latency per proposal.
- The evaluation prompt puts the system instructions and the rubric ahead of
  anything vendor-specific, so every proposal under one RFP shares a
  byte-identical prefix. The routes send that RFP's id in the
  `x-session-affinity` header and, to the default endpoint, as
  `prompt_cache_key` in the body, which is what keeps those calls on a replica
  that already has the prefix cached. The body field goes only to the default
  `AI_BASE_URL`: a strict OpenAI-compatible endpoint that does not implement it
  rejects the request. Set `AI_PROMPT_CACHE_KEY=1` to send it elsewhere, or `0`
  to withhold it. Reordering the prompt or changing the reasoning effort
  invalidates the cached prefix.

## Uploads

Documents go from the browser straight into the `rfp-files` storage bucket, and
the API routes receive only the object's path, which they read back server-side
before extracting text. They used to travel inside the API request, and the
hosting platform stops any request body at 4.5 MB before the route runs — so a
proposal with drawings in it failed with a platform error page the client could
not parse, while the app promised 25 MB. Storage has no such cap, the bucket's
policies already scope each owner to their own folder, and outbound reads inside
a function are not limited. The path layout is unchanged:
`<user id>/<rfp id>/<timestamp>-<name>` for a proposal and
`<user id>/<timestamp>-<name>` for an RFP. The bucket itself enforces the 25 MB
and PDF-only limits, so the browser-side checks are a courtesy, not the guard.

The row is the claim on a path: each route inserts it before reading the file
back, and the unique indexes on `responses.file_path` and `rfps.rfp_file_path`
in `schema.sql` are what make a second request for the same path fail before
any download or parsing. **Re-run `schema.sql` before deploying this version**
so those indexes exist; without them a burst of identical requests could each
parse the same 25 MB object.

Every API call in the client reads its response through `readApiResponse`,
which parses JSON only when the body is JSON and otherwise says what the status
means. A platform 413, 504 or 500 used to surface as
"JSON.parse: unexpected character at line 1 column 1".

## Interface conventions

Two rules shape every result screen, and breaking either is how these pages
became walls of text the first time.

**The answer first, the evidence behind a press.** Each screen opens with the
one thing the reader came for — the rubric's weighting, a proposal's score and
where it is thin, the recommended vendor and how far clear of second place it
is. Everything that supports it (a criterion's reasoning, the quoted passage,
the model and prompt version, the full comparative analysis) lives inside an
`Accordion` or `Collapsible` from `src/components/ui/`. Nothing is dropped to
make room; it is folded. The exported HTML report follows the same order using
native `<details>`.

**Colour encodes one thing at a time.** `src/app/globals.css` defines a single
sequential green ramp (`--viz-100` … `--viz-700`), generated in OKLCH from the
brand primary so its lightness steps are even, plus the five heat-grid bins and
their ink colours. Scores are magnitude: every bar wears `--viz-mark` and the
length carries the value, because colouring a bar by its own value spends the
identity channel restating what length already shows. Judgement is carried by
the verdict word from `src/lib/score.ts` (`TierChip`), never by hue alone —
status colour rides an icon beside a label so it survives greyscale printing
and colour-blind readers.

The ramp, the bins and every ink pairing were checked with the data-viz
validator: monotone lightness, adjacent steps at least 0.06 L apart, a single
hue, marks clearing 3:1 on their surface in both modes, and every heat-cell
number clearing 4.5:1 against its cell. The palest bin sits below 3:1 on
purpose — near-zero recedes toward the surface — which is why every cell also
prints its number. `src/lib/score.ts` is the single source of truth for
thresholds, so a criterion that reads "Mixed" on screen reads "Mixed" in the
CSV and the report.

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
