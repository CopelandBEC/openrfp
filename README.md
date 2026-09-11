# OpenRFP

**Evaluate RFP responses intelligently. Free, open source, transparent.**

OpenRFP helps facilities and procurement teams get from a stack of vendor
proposals to a defensible ranking. Upload your RFP and OpenRFP builds a
weighted evaluation rubric from it. Upload each vendor's response and every
proposal is scored against that rubric, criterion by criterion, with a
rationale and a quoted passage behind each score. Then compare the field side
by side, see where it is too close to call, and export the result for your
committee or board.

No account is needed to run a full evaluation. Add an email afterwards only
if you want to keep it.

Built by [Copeland Building Envelope Consulting](https://copelandbec.com) as
an open-source contribution to the industry. The rubrics it writes are tuned
for building envelope and facilities management work: roofing, façade,
waterproofing, envelope assessment and repair, and the consulting and
contracting proposals that come with them.

## How it works

1. **Upload your RFP.** OpenRFP reads it end to end, works out what you are
   actually buying, and drafts a rubric: the criteria that matter for this
   project, a weight for each one, and a written description of every score
   level so scoring is not a gut feel. Edit any criterion, rewrite a
   description, or change the weights before you accept it.
2. **Upload the proposals.** Each response is read against every criterion and
   scored on the rubric's scale. Every score comes with the reasoning behind
   it and a direct quote from the proposal, so you can check the evidence
   yourself. A summary notes where each proposal is strong and where it is
   thin. Scoring holds the line: 3 out of 5 means adequate, not good.
3. **Compare and decide.** The comparison screen ranks the proposals by their
   weighted totals and shows the whole field in one grid. It flags close
   calls, criteria where two or more vendors scored nearly the same, with a
   note on what separates them, and drafts the questions worth asking each
   vendor at interview. Disagree with a score? Override it, and re-rank when you are
   ready.

## What you get

- **A rubric you can defend.** Weights total 100 percent. Every criterion has
  a name, a description, and a scoring scale with each level spelled out.
- **Scores with receipts.** No score appears without a rationale and a quoted
  passage from the proposal it came from.
- **A ranking that knows when it is stale.** Change a score after ranking and
  the comparison says so, tells you whether the order still holds, and offers
  a re-rank.
- **Exports for the people who were not in the room.** Download the ranking as
  a CSV or JSON file, or as a self-contained report you can open in any
  browser, print, or attach to a recommendation.
- **Your work, when you want it.** Run everything as a guest. Add an email
  afterwards only if you want to keep the evaluation, come back to it later,
  or add proposals to one you already ran.

## Transparency

Every instruction used to write a rubric, score a proposal, or rank the field
is in this repository, in plain text, in [`src/lib/prompts/`](src/lib/prompts/).
Each evaluation records which version of those instructions produced it, so a
score from last quarter stays interpretable after the instructions change.
You can audit any score against the quoted evidence, and you can read exactly
how OpenRFP was told to judge.

## Your documents

- **Formats.** Upload PDF or Word (.docx) files up to 25 MB each. Older `.doc`
  files should be saved as `.docx` or exported to PDF first.
- **Only the text is read.** Drawings, photos and charts do not contribute to
  a score. Word tables are kept one row per line so pricing and schedules
  stay legible.
- **Scanned PDFs are flagged, not silently scored.** If a file has no readable
  text layer, OpenRFP tells you it may need OCR rather than scoring an empty
  page.
- **Where the text goes.** On the hosted app, extracted text is sent to
  Fireworks AI, a US company, which does not store prompts or outputs and does
  not use them for training. The evaluation model is an open-weight model
  served there, and its developer never receives your documents.
- **Confidential by default.** Your uploads and results are visible only to
  your session or account. Guest work that is never saved is temporary and may be
  cleared after a period of inactivity.

## What it does not do yet

OpenRFP is in active development. The full flow works, but it has not yet been
exercised end to end against a very large real RFP, so treat it as a strong
first read rather than a final word.

- No PDF export. Exports are CSV, JSON, and an HTML report.
- Scoring is text-only. Diagrams, photographs and charts in a proposal are not
  evaluated.
- No rubric templates or saved criteria libraries yet.
- No committee workflows, vendor portals, or contract management. OpenRFP
  evaluates responses. It is not a procurement platform.

## Run your own copy

OpenRFP is free to use. If you would rather host it yourself, everything you
need is in [docs/DEPLOYING.md](docs/DEPLOYING.md): the stack, the accounts to create, the
database and email setup, guest limits, and how to swap the evaluation model.

## Contributing

Contributions are welcome. CopelandBEC maintains this project. See
[CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE)
