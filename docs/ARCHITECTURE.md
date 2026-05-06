# Architecture

## System Overview

```
                    +-----------------------------------+
                    |         Claude Code Agent         |
                    |   (reads CLAUDE.md + modes/*.md)  |
                    +-----------+-----------------------+
                                |
        +-----------------------+-----------------+---------------------+
        |                       |                 |                     |
 +------+------+    +-----------+-----+   +-------+----------+  +------+------+
 | Single Eval  |    |  Portal Scan   |   |  Batch Process   |  |  Jobright   |
 | (auto-pipe)  |    |   (scan.md)    |   |  (batch-runner)  |  |   Sync      |
 +------+-------+    +-------+--------+   +--------+---------+  +------+------+
        |                    |                     |                    |
        |            +-------+--------+    +-------+-----+    +--------+------+
        |            |  pipeline.md   |<---+ N workers   |    | detail page   |
        |            |  (URL inbox)   |    | (claude -p) |    | -> canonical  |
        |            +-------+--------+    +-------------+    |   URL         |
        |                    |                                 +--------+------+
        |                    |<-----------------------------------------+
        |                    |
 +------+--------------------+------------------------------------------+
 |                      Output Pipeline                                  |
 |  +-----------+  +-------------+  +---------------------+             |
 |  | Report.md |  | PDF (HTML   |  | Tracker TSV         |             |
 |  | (A-F eval)|  | ->Puppeteer)|  | (merge-tracker)     |             |
 |  +-----------+  +-------------+  +---------------------+             |
 +--------------------------------------------------------------------------+
                                |
                     +----------+----------+
                     | data/applications.md |
                     | (canonical tracker)  |
                     +---------------------+
```

## Evaluation Flow (Single Offer)

1. **Input**: User pastes JD text or URL
2. **Extract**: Playwright/WebFetch extracts JD from URL
3. **Classify**: Detect archetype (1 of 6 types)
4. **Evaluate**: 6 blocks (A-F):
   - A: Role summary
   - B: CV match (gaps + mitigation)
   - C: Level strategy
   - D: Comp research (WebSearch)
   - E: CV personalization plan
   - F: Interview prep (STAR stories)
5. **Score**: Weighted average across 10 dimensions (1-5)
6. **Report**: Save as `reports/{num}-{company}-{date}.md`
7. **PDF**: Generate ATS-optimized CV (`generate-pdf.mjs`)
8. **Track**: Write TSV to `batch/tracker-additions/`, auto-merged

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv    →  batch-runner.sh  →  N × claude -p workers
(id, url, source)     (orchestrator)       (self-contained prompt)
                           │
                    batch-state.tsv
                    (tracks progress)
```

Each worker is a headless Claude instance (`claude -p`) that receives the full `batch-prompt.md` as context. Workers produce:
- Report .md
- PDF
- Tracker TSV line

The orchestrator manages parallelism, state, retries, and resume.

## Data Flow

```
cv.md                    →  Evaluation context
article-digest.md        →  Proof points for matching
config/profile.yml       →  Candidate identity
config/providers.yml     →  LLM provider routing (Claude + Gemini)
config/jobright.yml      →  Jobright.ai integration settings
portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.html → PDF generation template
```

## Jobright Integration Data Flow

```
Jobright.ai (saved / recommended lists)
  → scripts/jobright-sync.mjs
    → detail page navigation (Playwright)
      → canonical external URL extraction (scripts/jobright-resolve-detail.mjs)
        → data/pipeline.md  (canonical URL + source metadata)
        → data/scan-history.tsv  (dedup record)
          → /career-ops pipeline
            → evaluation + report + PDF + tracker
```

Each pipeline entry preserves both URLs:
```
- [ ] https://job-boards.greenhouse.io/company/jobs/123 | Acme | Senior AI Engineer | source:jobright | source_url:https://jobright.ai/jobs/abc
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges batch TSV additions into applications.md |
| `verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `normalize-statuses.mjs` | Maps status aliases to canonical values |
| `cv-sync-check.mjs` | Validates setup consistency |
| `scripts/jobright-login.mjs` | One-time Jobright.ai browser login; saves auth session |
| `scripts/jobright-sync.mjs` | Syncs Jobright listings → pipeline.md + scan-history.tsv |
| `scripts/jobright-resolve-detail.mjs` | Helper: navigate detail page, extract canonical external URL |

## Dashboard TUI

The `dashboard/` directory contains a standalone Go TUI application that visualizes the pipeline:

- Filter tabs: All, Evaluada, Aplicado, Entrevista, Top >=4, No Aplicar
- Sort modes: Score, Date, Company, Status
- Grouped/flat view
- Lazy-loaded report previews
- Inline status picker
