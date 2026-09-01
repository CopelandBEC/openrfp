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

**Add every origin you deploy to** (including preview URLs) under
**Authentication → URL Configuration → Redirect URLs**, or the emailed link will
refuse to complete sign-in.

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

Change one with an `UPDATE` from the SQL Editor:

```sql
update public.ai_limits set guest_hourly_limit = 4;
```

`AI_RATE_LIMIT_PER_HOUR` still works and is applied on top, but only ever as
the stricter of the two.

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
so sweep them periodically. `public.delete_stale_guests()` removes anonymous
users older than 30 days along with their uploaded files, and never touches a
guest who saved their work (attaching an email clears the anonymous flag).
Schedule it under **Database → Cron**:

```sql
select cron.schedule(
  'openrfp-delete-stale-guests', '0 3 * * *',
  $$ select public.delete_stale_guests(); $$
);
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
