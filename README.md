# OpenRFP

**AI-powered RFP evaluation tool for institutional facilities management.**

Free, open source, and transparent. Upload your RFP, get an AI-generated evaluation rubric, upload vendor responses, and receive scored evaluations with cited evidence.

Built by [Copeland Building Envelope Consulting](https://copelandbec.com) as an open-source contribution to the industry.

## How it works

1. **Upload your RFP** — The AI reads it and generates a customized evaluation rubric with weighted criteria and scoring scales, specialized for building envelope and facilities management projects.
2. **Upload vendor responses** — The AI evaluates each response against the rubric, scoring each criterion with a rationale and a direct quote from the proposal as evidence.
3. **Compare and decide** — Get a side-by-side ranking with comparative analysis, close-call flags, and recommended interview questions. Override any score you disagree with.

## Transparency

Every evaluation prompt, scoring rubric, and comparison logic is visible in this repository. You can see exactly how the AI is instructed to evaluate proposals. See [`src/lib/prompts/`](src/lib/prompts/) for the prompt source code.

## Tech stack

- **Frontend:** Next.js 15 + React + TypeScript + shadcn/ui + Tailwind CSS
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

### Database setup

1. Create a new Supabase project
2. Run the SQL in `supabase/schema.sql` in the Supabase SQL Editor
3. Copy your Supabase URL and keys to `.env.local`

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

### Deployment

Deploy to Vercel with one click — just connect the GitHub repo and add your environment variables.

## Configuration

### Switching AI models

The app uses a model-agnostic architecture. To change the AI model, just update environment variables:

```env
AI_PROVIDER=fireworks
AI_MODEL=accounts/fireworks/models/kimi-k3
AI_BASE_URL=https://api.fireworks.ai/inference/v1
```

Any OpenAI-compatible API works. See `.env.example` for all options.

## Contributing

Contributions are welcome. CopelandBEC maintains this project. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE)
