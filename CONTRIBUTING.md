# Contributing to OpenRFP

Contributions are welcome. OpenRFP is maintained by
[Copeland Building Envelope Consulting](https://copelandbec.com) (CopelandBEC),
which reviews and merges changes and sets the project's direction.

## Ground rules

- **Open an issue before large changes.** Small fixes can go straight to a pull
  request. For anything that changes the schema, the evaluation prompts, or the
  shape of the app, start with an issue so we can agree on the approach.
- **The prompts are the product.** `src/lib/prompts/` encodes domain expertise
  about what makes a building envelope proposal strong or weak. Changes there
  affect every evaluation, so they need a clear rationale — say what the current
  prompt gets wrong and why your version is better. Bump `PROMPT_VERSION` when
  you change one; evaluations record it so past results stay interpretable.
- **Keep it auditable.** Every score the tool produces must carry a rationale and
  a direct quote from the proposal. Don't add features that produce scores
  without cited evidence.

## Development setup

```bash
git clone https://github.com/CopelandBEC/openrfp.git
cd openrfp
npm install
cp .env.example .env.local   # then fill in your own credentials
npm run dev
```

You'll need a Supabase project (run `supabase/schema.sql` in the SQL Editor) and
an API key for any OpenAI-compatible AI provider. See the README for details.

## Before you open a pull request

```bash
npm run lint       # must be clean — this is not run during `next build`
npx tsc --noEmit   # must be clean
npm run build      # must succeed
```

Describe what you changed and how you verified it. If you couldn't test
something end to end (most changes touching AI calls or storage need a live
Supabase project), say so in the PR rather than implying it was verified.

## Security

Do not open a public issue for a security problem — especially anything touching
row-level security, storage policies, or auth. Email
[matt@copelandbec.com](mailto:matt@copelandbec.com) instead.

Uploaded RFPs and vendor proposals are confidential procurement documents. Any
change to RLS policies in `supabase/schema.sql` gets extra scrutiny: state which
policies you touched and what a signed-in user can reach before and after.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
