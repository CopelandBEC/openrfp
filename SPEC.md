# OpenRFP — Architecture & Build Spec

**Version:** 1.1  
**Date:** August 24, 2026  
**Author:** Matt (CopelandBEC) with Hermes Agent  
**Repo:** `github.com/CopelandBEC/openrfp`  
**Domain:** openrfp.tools  
**License:** MIT

---

## 1. What We're Building

A free, open-source web app that helps institutional facilities management personnel evaluate RFP responses using AI. The owner uploads their RFP, the app auto-generates an evaluation rubric, the owner uploads vendor responses, and the AI evaluates each response against the rubric — producing per-response scores with cited evidence and a cross-response comparative ranking.

**Not a procurement management platform.** No committee workflows, no vendor portals, no contract lifecycle management. Just: upload → AI evaluates → review results.

### Design Principles

1. **Simple.** Five screens, maximum. Upload, review rubric, upload responses, view evaluations, view comparison.
2. **Intelligent.** AI drives rubric generation, per-response evaluation, and cross-response comparison. The human reviews and overrides.
3. **Transparent.** Open source. All prompts visible in the repo. Evaluation logic is auditable.
4. **Free.** $0 to host and use. Server-side AI calls absorbed by the project (Option A), with BYOK on the roadmap (Option C).
5. **Swappable models.** The AI provider/model is a configuration value, not a code dependency. Change models by editing env vars.

---

## 2. Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Frontend** | Next.js 15 (App Router) + React + TypeScript | SSR for landing page, API routes for server-side AI calls, industry standard |
| **UI** | shadcn/ui + Tailwind CSS | Accessible, intuitive, beautiful by default. No design system to build from scratch. |
| **Database** | Supabase (PostgreSQL) | Free tier (500MB), built-in auth, row-level security, file storage |
| **File Storage** | Supabase Storage | Stores uploaded RFPs and response PDFs (1GB free tier) |
| **Hosting** | Vercel | One-click Next.js deploys, free tier (100GB bandwidth) |
| **Auth** | Supabase Auth | Guest (anonymous) sessions by default; magic link to save. SSO-ready for future. |
| **AI Provider** | Fireworks AI | Cost-efficient open models, OpenAI-compatible API, BYOK already configured |
| **PDF Processing** | pdf-parse (server-side text extraction) | Lightweight Node.js library, extracts text from OCR'd PDFs |
| **State Management** | React Server Components + Supabase client | No Redux/Zustand needed at this scale |

**Total hosting cost: $0/month** until free tiers are outgrown.

---

## 3. AI Model Strategy

### The Challenge

RFP responses are multi-page PDFs (often 30-100+ pages) that contain text, tables, charts, diagrams, and photographs. The AI needs to:
- Read and comprehend the full document
- Evaluate against nuanced criteria (technical approach, experience, methodology)
- "See" visual content (system diagrams, project photos, charts)
- Produce structured scores with cited evidence

### Fireworks Constraints Discovered

From the Fireworks docs:
- **VLMs (vision models) do NOT accept PDFs natively.** Each page must be converted to an image and passed as base64.
- **30-image maximum per request.** A 50-page proposal would need 2+ batches.
- **10MB total base64 limit per request.** Page images must be compressed.
- **Prompt caching available** — reduces cost for repeated content (e.g., the rubric is sent with every evaluation).

### Recommended Model Selection

**Primary evaluation model: Kimi K3** — open-weight, run by Fireworks AI (a US
company) on its US servers with no prompt or output retention; Moonshot AI, the
model's developer, never receives documents.
- Vision-capable (native visual understanding)
- 1M token context window (fits large proposals)
- $3/M input, $15/M output (cached input: $0.30/M)
- 2.8T parameters, MoE — frontier-class reasoning
- Open-source (Moonshot AI)

**Rubric generation model: Kimi K3** (same — no reason to split for v1)

**Alternative if cost becomes an issue: Qwen3.7 Plus**
- Vision-capable, 262K context
- $0.40/M input, $1.60/M output — 7x cheaper than Kimi K3
- Good but not frontier-class for complex reasoning

**The architecture must make this a config value, not a code path.** The model ID lives in an environment variable. Switching from Kimi K3 to Qwen3.7 Plus to DeepSeek V4 to Claude Sonnet is a one-line change.

### All-in-One vs. Split Model Approach

**Recommendation: All-in-one (VLM) for v1. Split is a roadmap item.**

Rationale:
- A single VLM call with text + page images is simpler to build, simpler to debug, and produces more coherent evaluations (the model sees everything in context).
- Splitting (text model for prose + vision model for images, then merging) adds orchestration complexity, merge logic, and failure modes. Not worth it for v1.
- Kimi K3's 1M context window is large enough to handle most proposals in a single call (or 2-3 batched calls for very long ones).
- **If a proposal has critical visual content** (diagrams, photos that are essential to evaluation), the VLM sees them. If it doesn't, the text is sufficient and the images just add token cost — acceptable for v1.

**Roadmap (v2+):** For cost optimization, implement a pre-processing step that uses a cheap vision model to identify which pages have meaningful visual content vs. pure text, then only send image-pages to the VLM and text-only pages as plain text. This cuts token costs significantly on text-heavy proposals.

### Document Processing Pipeline

```
User uploads PDF
       ↓
Server extracts text using pdf-parse
       ↓
  ┌─────────────┐
  │ Text length │
  │ check       │
  └──────┬──────┘
         │
    ┌────▼────┐                    ┌──────────────┐
    │ Text    │                    │ Little/no    │
    │ present?│─── yes ──→ use ──→ │ text (likely │
    │         │           text     │ scanned/     │
    └────┬────┘                    │ image PDF)   │
         │ no                      └──────┬───────┘
         │                                │
         │                         ┌──────▼──────┐
         │                         │ Show warning │
         │                         │ to user:     │
         │                         │ "This doc    │
         │                         │ appears to   │
         │                         │ lack OCR.    │
         │                         │ Please OCR   │
         │                         │ it and       │
         │                         │ re-upload."  │
         │                         │ + link to    │
         │                         │ recommended  │
         │                         │ OCR tools    │
         │                         └─────────────┘
         │
         ▼
  Convert PDF pages
  to images (pdf.js /
  pdf-to-img), batch
  at 30 pages max
         │
         ▼
  Send to VLM with
  rubric + evaluation
  prompt
```

**OCR detection logic (v1 — simple heuristic):**
1. Extract text via `pdf-parse`
2. If text length < 100 characters per page (average), flag as "likely not OCR'd"
3. Show user a warning with links to free OCR tools (e.g., Adobe's free online OCR, ILovePDF, or instructions for using Preview on macOS)
4. User OCRs the doc externally and re-uploads

This avoids building OCR infrastructure for v1 while gracefully handling the common failure case.

---

## 4. Application Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js App (Vercel)                   │
│                                                           │
│  ┌──────────┐   ┌───────────┐   ┌──────────────────────┐ │
│  │ Landing   │   │ Auth      │   │ App (authenticated)  │ │
│  │ Page      │   │ (Supabase)│   │                      │ │
│  │ (SSR,     │   │           │   │  ┌────────────────┐  │ │
│  │ public)   │   │           │   │  │ Screen 1:      │  │ │
│  │           │   │           │   │  │ RFP Upload     │  │ │
│  │ - What is │   │           │   │  │ + rubric gen   │  │ │
│  │   it?     │   │           │   │  ├────────────────┤  │ │
│  │ - GitHub  │   │           │   │  │ Screen 2:      │  │ │
│  │   link    │   │           │   │  │ Rubric Review  │  │ │
│  │ - Privacy │   │           │   │  │ (edit/accept)  │  │ │
│  │           │   │           │   │  ├────────────────┤  │ │
│  │           │   │           │   │  │ Screen 3:      │  │ │
│  │           │   │           │   │  │ Response       │  │ │
│  │           │   │           │   │  │ Upload         │  │ │
│  │           │   │           │   │  ├────────────────┤  │ │
│  │           │   │           │   │  │ Screen 4:      │  │ │
│  │           │   │           │   │  │ Evaluations    │  │ │
│  │           │   │           │   │  │ (per-response  │  │ │
│  │           │   │           │   │  │ scores +       │  │ │
│  │           │   │           │   │  │ evidence)      │  │ │
│  │           │   │           │   │  ├────────────────┤  │ │
│  │           │   │           │   │  │ Screen 5:      │  │ │
│  │           │   │           │   │  │ Comparison &   │  │ │
│  │           │   │           │   │  │ Ranking        │  │ │
│  │           │   │           │   │  └────────────────┘  │ │
│  └──────────┘   └───────────┘   └──────────────────────┘ │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              API Routes (server-side)                │ │
│  │                                                      │ │
│  │  POST /api/generate-rubric     ← RFP text → rubric   │ │
│  │  POST /api/evaluate-response   ← response + rubric   │ │
│  │                                 → scores + evidence  │ │
│  │  POST /api/compare-responses   ← all evaluations    │ │
│  │                                 → ranking + analysis │ │ │
│  │  POST /api/upload              ← file → Supabase     │ │
│  │  POST /api/check-ocr           ← PDF → OCR status    │ │
│  │                                                      │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
└──────────────────────────┬────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
     │  Supabase   │ │ Supabase │ │  Fireworks  │
     │  Postgres   │ │ Storage  │ │  AI API     │
     │             │ │          │ │             │
     │ - rfps      │ │ - rfp/   │ │ (OpenAI-    │
     │ - responses │ │   docs/  │ │  compatible │
     │ - rubrics   │ │ - resp/  │ │  endpoint)  │
     │ - evals     │ │   docs/  │ │             │
     │ - profiles  │ │          │ │ Kimi K3     │
     │             │ │          │ │ (default)   │
     └─────────────┘ └──────────┘ └─────────────┘
```

---

## 5. Database Schema

```sql
-- profiles (extends Supabase auth.users)
create table profiles (
  id uuid references auth.users primary key,
  email text,
  org_name text,
  role text default 'owner',  -- 'owner' | 'admin' (future)
  created_at timestamptz default now()
);

-- rfps
create table rfps (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users not null,
  title text not null,
  description text,
  rfp_file_path text not null,          -- Supabase Storage path
  rfp_text text,                        -- extracted text (for AI context)
  status text default 'draft',          -- 'draft' | 'rubric_ready' | 'evaluating' | 'complete'
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- rubrics (one per RFP)
create table rubrics (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references rfps not null unique,
  criteria jsonb not null,             -- array of {name, description, weight, scoring_scale}
  ai_generated boolean default true,
  edited_by_user boolean default false,
  locked boolean default false,
  created_at timestamptz default now()
);

-- responses (vendor proposals)
create table responses (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references rfps not null,
  vendor_name text not null,
  file_path text not null,              -- Supabase Storage path
  extracted_text text,                  -- extracted text
  ocr_status text default 'unknown',    -- 'ok' | 'flagged' | 'unknown'
  page_count integer,
  status text default 'pending',        -- 'pending' | 'evaluating' | 'evaluated' | 'error'
  created_at timestamptz default now()
);

-- evaluations (one per response)
create table evaluations (
  id uuid primary key default gen_random_uuid(),
  response_id uuid references responses not null unique,
  rfp_id uuid references rfps not null,
  scores jsonb not null,                -- {criterion_id: {score, max, rationale, evidence_quote, page_ref}}
  overall_score numeric,
  summary text,                         -- AI-generated narrative summary
  strengths jsonb,                      -- array of strings
  weaknesses jsonb,                     -- array of strings
  model_used text,                      -- which model produced this eval (transparency)
  created_at timestamptz default now()
);

-- comparisons (one per RFP, after all responses evaluated)
create table comparisons (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references rfps not null unique,
  ranking jsonb not null,               -- [{response_id, rank, score, rationale}]
  comparative_analysis text,            -- AI narrative comparing all responses
  close_calls jsonb,                    -- areas where responses are near-tied
  model_used text,
  created_at timestamptz default now()
);

-- audit log (transparency)
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  rfp_id uuid references rfps,
  user_id uuid references auth.users,
  action text not null,                 -- 'upload_rfp' | 'generate_rubric' | 'edit_rubric' | etc.
  details jsonb,
  created_at timestamptz default now()
);

-- RLS policies: users can only see their own RFPs/responses/evaluations
```

### Rubric JSON Structure

```json
{
  "criteria": [
    {
      "id": "criterion_1",
      "name": "Technical Approach",
      "description": "Does the proposed methodology address the RFP requirements thoroughly and demonstrate sound engineering judgment?",
      "weight": 30,
      "scoring_scale": "1-5",
      "scale_descriptions": {
        "1": "Approach is vague, generic, or fails to address key requirements",
        "2": "Approach addresses requirements but lacks detail or innovation",
        "3": "Approach is adequate, meets requirements with reasonable methodology",
        "4": "Approach is thorough, well-detailed, shows expertise",
        "5": "Approach is exceptional — innovative, comprehensive, demonstrates deep domain expertise"
      }
    },
    {
      "id": "criterion_2",
      "name": "Relevant Experience",
      "weight": 25,
      ...
    }
  ],
  "total_weight": 100
}
```

---

## 6. Screen-by-Screen UI Specification

### Screen 0: Landing Page (public, SSR)

- **Purpose:** Explain what the tool is, build trust, link to GitHub repo
- **Content:**
  - Headline: "Evaluate RFP responses with AI. Free, open source, transparent."
  - 3-step explanation: Upload RFP → AI generates rubric → Upload responses → Get evaluations
  - "How it works" section with the evaluation process explained in plain language
  - GitHub repo link (source code, prompts, scoring logic — all visible)
  - Privacy note: "Your documents are processed securely and are not used to train AI models. Fireworks AI's inference uses zero data retention by default."
  - CTA: "Start evaluating — no account needed" → guest session, straight into Screen 1
- **Design:** Clean, minimal, institutional-appropriate. Not flashy. Conveys trust.

### Auth model

Authentication is deliberately not a gate on the first pass. A visitor lands,
clicks through, and runs a complete evaluation — RFP, rubric, responses,
comparison — as a **guest**, holding a Supabase anonymous session. That session
is a real `auth.users` row with a real JWT, so every RLS policy applies to a
guest exactly as it does to a member; the difference is that nothing links the
session to a person, so it cannot be recovered once the browser forgets it.

Saving is the only thing an account buys. `updateUser({ email })` attaches an
email to the anonymous user already signed in, converting the same user id in
place — no data is copied or migrated, and the work the visitor just did is
simply theirs from then on.

**What requires an account:** persistence only — saved history, returning to an
evaluation later, adding responses to one already run. Results and CSV/JSON
export stay available to guests. Gating the export would put the paywall at the
exact moment the tool delivers its value, after the visitor has already spent
real time uploading proposals; the honest trade is that keeping the work is
worth an email and seeing it is not.

**What this costs:** guest sessions are a signup path with no email step, and
the AI key is held server-side, so the limits described in the README
(`public.ai_limits`, Turnstile on session creation) are what keep an open door
from being an open budget.

### Screen 1: RFP Upload + Rubric Generation

- **Layout:** Single column, centered, max-width prose
- **Elements:**
  - RFP title input
  - Optional description textarea
  - File drop zone (accepts .pdf, .docx)
  - "Generate Rubric" button
- **After upload:**
  - Loading state: "Reading your RFP and generating evaluation criteria..."
  - Progress indicator (this takes 15-60 seconds depending on doc length)
  - On success → navigate to Screen 2

### Screen 2: Rubric Review

- **Layout:** Card-based list of criteria
- **Elements:**
  - Each criterion shown as a card:
    - Criterion name (editable)
    - Description (editable)
    - Weight (editable, slider or number input)
    - Scoring scale descriptions (editable)
  - Weights must sum to 100 (validation indicator)
  - "Add Criterion" button
  - "Remove Criterion" button (per card)
  - "Accept Rubric" button → locks rubric, navigates to Screen 3
  - "Regenerate Rubric" button → re-runs AI with RFP context
- **Design note:** Make it very clear that the rubric can be edited. The AI-generated version is a starting point, not a mandate. This is core to the transparency story.

### Screen 3: Response Upload

- **Layout:** Upload zone + list of uploaded responses
- **Elements:**
  - For each response:
    - Vendor name input
    - File upload (.pdf, .docx)
    - OCR status indicator (green check / yellow warning)
    - If OCR flagged: warning box with link to OCR tools
    - Remove button
  - "Add Another Response" button
  - "Evaluate All" button → starts evaluation, navigates to Screen 4
- **After clicking Evaluate:**
  - Show progress: "Evaluating [Vendor Name]... (1 of 3)"
  - Each evaluation takes 30-90 seconds depending on doc length
  - Can navigate to Screen 4 to see results as they complete

### Screen 4: Per-Response Evaluations

- **Layout:** Tab bar (one tab per vendor) or accordion
- **Per response:**
  - Vendor name + overall score (large, prominent)
  - Summary paragraph (AI-generated narrative)
  - Criterion-by-criterion breakdown:
    - Criterion name + score (e.g., "4/5")
    - Rationale (AI-generated, 2-3 sentences)
    - Evidence quote (directly cited from the proposal, with page number)
  - Strengths list (bullet points)
  - Weaknesses list (bullet points)
  - "Override Score" button per criterion → allows manual score adjustment
  - Model used: "Kimi K3, run on Fireworks AI's US servers" (transparency —
    say where the documents went, not just which model read them)
- **Design note:** The evidence quotes are critical. They prove the AI actually read the proposal and ground the evaluation in specific text, not hallucination.

### Screen 5: Comparison & Ranking

- **Layout:** Ranked table + comparative analysis
- **Elements:**
  - Ranked table:
    - Rank | Vendor | Overall Score | Criterion 1 | Criterion 2 | ... | 
    - Sortable by criterion
    - Color-coded scores (green/yellow/red gradient)
  - Comparative analysis (AI-generated narrative, ~500 words):
    - Key differentiators between top-ranked responses
    - Areas of near-tie (where small score differences could go either way)
    - Recommended focus areas for interviews/clarifications
  - Per-criterion comparison charts (bar charts, using Recharts)
  - "Export to CSV" button
  - "Export to PDF" button (for board presentations)
  - "Override Ranking" capability (manual reorder with rationale)

---

## 7. AI Prompt Architecture

All prompts live in `/lib/prompts/` as individual TypeScript files. They are part of the open-source repo — visible, auditable, forkable. This is core to the transparency promise. Prompts are iterated on independently of this spec; the spec describes *what* each prompt should accomplish, not the exact wording.

### Prompt 1: Rubric Generation (`/lib/prompts/generate-rubric.ts`)

- **Input:** RFP document full text
- **Output:** JSON rubric (criteria array with id, name, description, weight, scoring_scale, scale_descriptions)
- **Persona:** Expert procurement evaluator with deep expertise in building envelope consulting, facilities management, and institutional construction (higher ed, K-12, municipal, private). Understands what distinguishes strong envelope proposals from weak ones — testing protocols (ASTM, AAMA, WUFI), cladding experience, building type and climate zone familiarity, field quality control, communication of complex enclosure concepts to non-technical stakeholders.
- **Instructions:** Generate 4-8 evaluation criteria that reflect the specific RFP requirements, cover technical competence + relevant experience + project approach + communication + value, use domain-specific sub-criteria where relevant, and weight criteria to reflect the RFP's implied priorities. Weights must sum to 100.
- **Scoring scale:** Each criterion includes descriptions for each score level (e.g., 1-5) so scoring is grounded in concrete expectations, not subjective gut feel.

### Prompt 2: Per-Response Evaluation (`/lib/prompts/evaluate-response.ts`)

- **Input:** Rubric JSON + response document (text and/or page images)
- **Output:** JSON evaluation (scores per criterion with rationale + evidence quote + page ref, overall summary, strengths, weaknesses)
- **Instructions:** For each criterion, read the response thoroughly, identify specific passages that address it, assign a score based on the rubric's scale descriptions, provide a 2-3 sentence rationale, and quote the exact passage from the proposal that supports the score (with page number). Be rigorous and fair — do not inflate scores. A score of 3 means "adequate."
- **Evidence requirement:** Every score must include a direct quote from the proposal as evidence. This is non-negotiable — it's what makes evaluations trustworthy and auditable. An evaluation without cited evidence is worse than no evaluation.

### Prompt 3: Cross-Response Comparison (`/lib/prompts/compare-responses.ts`)

- **Input:** All evaluation results + rubric
- **Output:** JSON ranking (rank per response with rationale), comparative analysis narrative (~300-500 words), close calls (criteria where responses are near-tied), interview focus areas
- **Instructions:** Rank responses by weighted overall score. Identify key differentiators between top-ranked responses. Flag near-ties (within 1 point on a criterion). Recommend focus areas for interviews or clarifications. Write a comparative analysis that helps the owner understand the landscape of options, not just the ranking.

### Prompt Management

- Each prompt file includes a version constant (e.g., `PROMPT_VERSION = '1.0.0'`)
- Each evaluation record stores which prompt version and model was used
- This makes evaluations reproducible and auditable
- If someone forks the repo and changes prompts, their evaluations are marked with their prompt version
- The `/public/prompts/` directory mirrors the active prompts as plain text — so non-developers can read them on GitHub without diving into TypeScript

---

## 8. API Route Design

All AI calls happen server-side in Next.js API routes (or Server Actions). The Fireworks API key is never exposed to the client.

```
POST /api/upload-rfp
  Body: FormData (file + title + description)
  → Extracts text, stores file in Supabase Storage, creates rfp record
  → Returns: { rfp_id, ocr_status }

POST /api/generate-rubric
  Body: { rfp_id }
  → Fetches RFP text from DB
  → Calls Fireworks API with generate-rubric prompt
  → Stores rubric in DB
  → Returns: { rubric }

PATCH /api/rubric/:id
  Body: { criteria } (edited rubric)
  → Updates rubric, marks edited_by_user = true
  → Returns: { rubric }

POST /api/upload-response
  Body: FormData (file + vendor_name + rfp_id)
  → Extracts text, checks OCR status, stores file
  → Returns: { response_id, ocr_status }

POST /api/evaluate-response
  Body: { response_id }
  → Fetches response text + rubric from DB
  → Converts pages to images if needed (batch at 30 max)
  → Calls Fireworks API with evaluate-response prompt
  → Stores evaluation in DB
  → Returns: { evaluation }

POST /api/evaluate-all
  Body: { rfp_id }
  → Triggers evaluation for all responses (sequential or parallel)
  → Returns: { status: "processing" } (client polls or uses SSE)

POST /api/compare-responses
  Body: { rfp_id }
  → Fetches all evaluations for this RFP
  → Calls Fireworks API with compare-responses prompt
  → Stores comparison in DB
  → Returns: { comparison }

GET /api/rfp/:id
  → Returns: { rfp, rubric, responses, evaluations, comparison }
```

### AI Call Wrapper (model-agnostic)

```typescript
// /lib/ai/client.ts

interface AIConfig {
  provider: 'fireworks' | 'openai' | 'anthropic';
  model: string;
  apiKey: string;
  baseURL: string;
}

// Reads from env vars — change models by editing .env
function getAIConfig(): AIConfig {
  return {
    provider: process.env.AI_PROVIDER || 'fireworks',
    model: process.env.AI_MODEL || 'accounts/fireworks/models/kimi-k3',
    apiKey: process.env.FIREWORKS_API_KEY!,
    baseURL: process.env.AI_BASE_URL || 'https://api.fireworks.ai/inference/v1',
  };
}

// All prompts go through this wrapper
async function callAI(prompt: string, content: AIContent): Promise<string> {
  const config = getAIConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  // ... unified call logic
}
```

This means switching to Claude Sonnet or GPT-4 later is just:
```env
AI_PROVIDER=openai
AI_MODEL=gpt-4o
AI_BASE_URL=https://api.openai.com/v1
```

No code changes. No refactoring. Just env vars.

---

## 9. Repository Structure

```
rfp-evaluator/
├── app/                          # Next.js App Router
│   ├── (public)/                 # Public routes (landing page)
│   │   └── page.tsx
│   ├── (auth)/                   # Auth routes
│   │   ├── login/page.tsx
│   │   └── callback/page.tsx
│   ├── (app)/                    # Authenticated app routes
│   │   ├── dashboard/page.tsx    # List of user's RFPs
│   │   ├── rfp/
│   │   │   ├── new/page.tsx      # Screen 1: Upload RFP
│   │   │   ├── [id]/
│   │   │   │   ├── rubric/page.tsx      # Screen 2: Rubric Review
│   │   │   │   ├── responses/page.tsx   # Screen 3: Upload Responses
│   │   │   │   ├── evaluations/page.tsx # Screen 4: Per-Response Evals
│   │   │   │   └── comparison/page.tsx  # Screen 5: Comparison
│   │   └── settings/page.tsx
│   └── api/                      # API routes
│       ├── upload-rfp/route.ts
│       ├── generate-rubric/route.ts
│       ├── upload-response/route.ts
│       ├── evaluate-response/route.ts
│       ├── evaluate-all/route.ts
│       └── compare-responses/route.ts
├── lib/
│   ├── ai/
│   │   ├── client.ts             # Model-agnostic AI wrapper
│   │   └── config.ts             # Reads env, returns AIConfig
│   ├── prompts/
│   │   ├── generate-rubric.ts    # Prompt 1 (versioned)
│   │   ├── evaluate-response.ts  # Prompt 2 (versioned)
│   │   └── compare-responses.ts  # Prompt 3 (versioned)
│   ├── pdf/
│   │   ├── extract-text.ts       # pdf-parse wrapper
│   │   ├── check-ocr.ts          # OCR heuristic
│   │   └── pages-to-images.ts    # pdf.js page → base64
│   ├── supabase/
│   │   ├── client.ts             # Server client
│   │   └── schema.sql            # Full schema with RLS
│   └── utils/
│       ├── tokens.ts             # Token estimation (for cost tracking)
│       └── audit.ts              # Audit log helper
├── components/
│   ├── ui/                       # shadcn/ui components
│   ├── rubric/
│   │   ├── rubric-card.tsx
│   │   └── criterion-editor.tsx
│   ├── evaluation/
│   │   ├── score-display.tsx
│   │   ├── evidence-quote.tsx
│   │   └── evaluation-tabs.tsx
│   └── comparison/
│       ├── ranking-table.tsx
│       └── comparison-charts.tsx
├── public/
│   ├── prompts/                  # Public copies of prompts (transparency)
│   └── README.md
├── .env.example                  # Documents all env vars
├── supabase/
│   └── migrations/               # DB migration files
├── package.json
├── next.config.ts
├── tailwind.config.ts
└── README.md
```

---

## 10. Environment Variables

```env
# AI Provider (change these to switch models)
AI_PROVIDER=fireworks
AI_MODEL=accounts/fireworks/models/kimi-k3
AI_BASE_URL=https://api.fireworks.ai/inference/v1
FIREWORKS_API_KEY=your_key_here

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_key

# App
NEXT_PUBLIC_APP_URL=https://your-domain.com

# Roadmap: BYOK support
# When implemented, per-user API keys stored encrypted in DB
# and override the global AI_* vars
```

---

## 11. Build Sequence

### Phase 1: Foundation (Days 1-3)
1. Initialize Next.js project with TypeScript, Tailwind, shadcn/ui
2. Set up Supabase project (DB + Storage + Auth)
3. Create database schema with migrations
4. Implement auth flow (login, signup, callback)
5. Build landing page
6. Deploy to Vercel (empty shell, verify pipeline)

### Phase 2: Upload + Rubric Generation (Days 4-7)
7. Build file upload component (dropzone)
8. Implement PDF text extraction (pdf-parse)
9. Implement OCR check heuristic
10. Build AI client wrapper (model-agnostic)
11. Write and test generate-rubric prompt
12. Build Screen 1 (RFP upload) and Screen 2 (rubric review)
13. End-to-end test: upload RFP → get generated rubric

### Phase 3: Response Evaluation (Days 8-12)
14. Build Screen 3 (response upload)
15. Implement PDF → page images conversion (pdf-to-img)
16. Write and test evaluate-response prompt
17. Build evaluation API route (handle batching for 30+ page docs)
18. Build Screen 4 (per-response evaluations with evidence quotes)
19. Implement score override capability
20. End-to-end test: upload 3 responses → get evaluations with scores + evidence

### Phase 4: Comparison + Polish (Days 13-16)
21. Write and test compare-responses prompt
22. Build Screen 5 (comparison table + charts + analysis)
23. Implement CSV/PDF export
24. Add audit logging
25. Add cost tracking (log token usage per evaluation)
26. Polish UI: loading states, error handling, empty states
27. Write README.md (installation, deployment, how prompts work)
28. Make repo public

### Phase 5: Hardening + Launch (Days 17-20)
29. Rate limiting on API routes (prevent abuse)
30. Input validation and file size limits (25MB per file)
31. Error recovery (retry failed AI calls, partial evaluation states)
32. Mobile responsiveness pass
33. Accessibility audit (WCAG AA — important for institutional users)
34. Write documentation for contributors
35. Deploy final version + announce

---

## 12. Cost Analysis

### Per-Evaluation Cost (Kimi K3 on Fireworks)

Assumptions:
- Average proposal: 40 pages
- Text extraction: ~15K tokens (from pdf-parse)
- Page images (if visual content matters): ~40 images × ~500 tokens = ~20K tokens
- Rubric context: ~2K tokens
- Prompt overhead: ~1K tokens
- **Total input: ~38K tokens**
- **Output (structured evaluation): ~3K tokens**

| Component | Tokens | Rate | Cost |
|---|---|---|---|
| Input (cache miss) | 38K | $3/M | $0.114 |
| Input (cache hit — rubric is cached) | 38K | $0.30/M | $0.011 |
| Output | 3K | $15/M | $0.045 |
| **Per evaluation (first call)** | | | **~$0.16** |
| **Per evaluation (with caching)** | | | **~$0.06** |

Rubric generation: ~$0.05 (one-time per RFP)  
Comparison: ~$0.10 (one-time per RFP)

**Typical RFP evaluation (1 RFP + 5 responses):**
- Rubric: $0.05
- 5 evaluations: $0.30-$0.80
- Comparison: $0.10
- **Total: ~$0.45-$0.95 per RFP evaluation session**

At this cost, the free tier can handle ~500-1,000 evaluation sessions per month before hitting meaningful spend. That's substantial capacity for a free tool.

---

## 13. Roadmap (Post-v1)

| Feature | Priority | Notes |
|---|---|---|
| **BYOK (Option C)** | High | Users paste their own API key for unlimited evaluations |
| **Cost dashboard** | Medium | Show users how much their evaluations cost (transparency) |
| **Smart page selection** | Medium | Pre-process to identify pages with visual content, send only those as images |
| **Multi-format support** | Medium | .docx, .xlsx native parsing (currently PDF-only) |
| **Rubric templates** | Medium | Save and reuse rubrics across similar RFPs |
| **Collaborative review** | Low | Multiple reviewers on one evaluation (adds complexity) |
| **Built-in OCR** | Low | Tesseract.js or similar for in-app OCR (removes external step) |
| **Public results page** | Low | Share evaluation results via public URL (for transparency/FOIA) |
| **Model comparison** | Low | Run same evaluation with 2 models, show differences |
| **Fine-tuned models** | Low | Fine-tune on building envelope RFP evaluation patterns |
| **Audit trail export** | Low | Full audit log export for legal defensibility |
| **API access** | Low | REST API for programmatic access (integration with procurement systems) |

---

## 14. Decisions

1. **App name:** OpenRFP
2. **Domain:** openrfp.tools (available — leaves room for future related tools under the same domain)
3. **GitHub repo:** `github.com/CopelandBEC/openrfp` — public, under the CopelandBEC org. Positions it as a CopelandBEC contribution to the industry. Includes `CONTRIBUTING.md` clarifying CopelandBEC maintains the project. Can move to a dedicated `openrfp` org later if community adoption warrants neutrality.
4. **License:** MIT. Maximum simplicity and adoption. Matches the rest of the stack (Next.js, shadcn/ui, Tailwind). The transparency and trust come from open code and visible prompts, not the license document.
5. **Starting scope:** Specialized for building envelope / facilities management RFPs first. The prompts encode CopelandBEC's domain expertise — what matters in a building envelope proposal, how to evaluate technical approach, what constitutes relevant experience, etc. Generalize the prompts later once the specialized version is proven and the pattern is established. This makes the tool immediately differentiated rather than generic.
