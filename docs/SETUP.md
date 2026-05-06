# Setup Guide

## Prerequisites

- [Claude Code](https://claude.ai/code) installed and configured
- Node.js 18+ (for PDF generation and utility scripts)
- (Optional) Go 1.21+ (for the dashboard TUI)

## Quick Start (5 steps)

### 1. Clone and install

```bash
git clone https://github.com/santifer/career-ops.git
cd career-ops
npm install
npx playwright install chromium   # Required for PDF generation
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Edit `config/profile.yml` with your personal details: name, email, target roles, narrative, proof points.

### 3. Add your CV

Create `cv.md` in the project root with your full CV in markdown format. This is the source of truth for all evaluations and PDFs.

(Optional) Create `article-digest.md` with proof points from your portfolio projects/articles.

### 4. Configure portals

```bash
cp templates/portals.example.yml portals.yml
```

Edit `portals.yml`:
- Update `title_filter.positive` with keywords matching your target roles
- Add companies you want to track in `tracked_companies`
- Customize `search_queries` for your preferred job boards

### 5. Start using

Open Claude Code in this directory:

```bash
claude
```

Then paste a job offer URL or description. Career-ops will automatically evaluate it, generate a report, create a tailored PDF, and track it.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` |
| Process pending URLs | `/career-ops pipeline` |
| Generate a PDF | `/career-ops pdf` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

## Verify Setup

```bash
node cv-sync-check.mjs      # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
cd dashboard
go build -o career-dashboard .
./career-dashboard            # Opens TUI pipeline viewer
```

---

## Jobright.ai Integration

Jobright.ai can be used as a lead source. The system logs in once, reads your
saved/recommended listings, navigates to each detail page to extract the real
external job posting URL, and adds it to your pipeline for evaluation.

### How it works

```
Jobright list page
  → detail page  (Jobright URL)
    → external ATS URL  (Greenhouse / Lever / Ashby / etc.)  ← canonical URL
      → pipeline.md  →  evaluation  →  report  →  apply
```

The **canonical URL** (external job posting) is what the rest of the pipeline uses.
The Jobright source URL is preserved as metadata in each pipeline entry.

### Setup (one time)

**1. Review `config/jobright.yml`** — adjust `lists`, `max_jobs_per_run`, and `apply.mode`.

**2. Log in to Jobright.ai:**

```bash
node scripts/jobright-login.mjs
```

A browser window opens. Log in (Google / LinkedIn / email), navigate to your
saved jobs to confirm the session is fully loaded, then press **Enter** in the
terminal. Your session is saved to `.auth/jobright-storage-state.json`
(gitignored — stays local only).

**3. Run a sync:**

```bash
node scripts/jobright-sync.mjs
# or:
npm run jobright:sync
```

New listings are appended to `data/pipeline.md`. Duplicates are skipped
automatically using `data/scan-history.tsv` + `data/pipeline.md` + `data/applications.md`.

**4. Process the pipeline:**

```
/career-ops pipeline
```

This evaluates each new URL, generates a report + PDF, and tracks the result.

### Session expiry

If Jobright.ai logs you out, re-run `node scripts/jobright-login.mjs` to
refresh the session. The new session replaces the old one automatically.

### Apply mode

`config/jobright.yml` → `apply.mode`:

| Mode | Behavior |
|------|----------|
| `draft_only` | Generate tailored CV + draft answers only; no browser navigation |
| `assisted` | Navigate application form, prefill fields, **pause for your review before submit** |

The system never submits an application without your explicit confirmation.

---

## Gemini Provider Support

Gemini is used alongside Claude for research-heavy tasks (job summarization,
company research, second opinion scoring, draft generation).

### Setup

**1. Get a Gemini API key:**
   - Visit [https://aistudio.google.com/](https://aistudio.google.com/)
   - Create an API key

**2. Set the environment variable:**

```bash
export GEMINI_API_KEY="your-api-key-here"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist it.

**3. Review `config/providers.yml`** — adjust routing if needed.

### Default routing

| Task | Provider |
|------|----------|
| Offer evaluation (A–F) | Claude |
| CV tailoring | Claude |
| Application answers | Claude |
| Job summarization | Gemini |
| Company research | Gemini |
| Second opinion score | Gemini |
| Draft cover letters | Gemini |
| Fallback | Gemini |

Claude remains the primary engine for high-stakes evaluation and writing.
Gemini handles research and enrichment tasks where its web grounding is an advantage.
