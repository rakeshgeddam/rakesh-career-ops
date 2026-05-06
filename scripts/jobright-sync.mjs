#!/usr/bin/env node
/**
 * jobright-sync.mjs
 *
 * Sync saved/recommended job listings from Jobright.ai into the pipeline.
 *
 * For each Jobright listing:
 *   1. Navigate to the list (saved / recommended)
 *   2. Collect all listing cards (title, company, Jobright detail URL)
 *   3. Navigate to each detail page
 *   4. Extract the actual external job posting URL (canonical URL)
 *   5. Deduplicate against scan-history.tsv, pipeline.md, applications.md
 *   6. Write new entries to data/pipeline.md (Pendientes section)
 *   7. Record every seen URL in data/scan-history.tsv
 *
 * The CANONICAL URL (external ATS/company URL) is used as the pipeline key.
 * The Jobright source URL is preserved in the pipeline entry as metadata.
 *
 * Usage:
 *   node scripts/jobright-sync.mjs
 *
 * Prerequisites:
 *   node scripts/jobright-login.mjs   (one-time login to save session)
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveCanonicalUrl, stripTrackingParams } from "./jobright-resolve-detail.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ─── Paths ───────────────────────────────────────────────────────────────────
const STORAGE_STATE_PATH = path.join(ROOT, ".auth/jobright-storage-state.json");
const PIPELINE_PATH = path.join(ROOT, "data/pipeline.md");
const SCAN_HISTORY_PATH = path.join(ROOT, "data/scan-history.tsv");
const APPLICATIONS_PATH = path.join(ROOT, "data/applications.md");

// ─── Load config ─────────────────────────────────────────────────────────────
let cfg = {
  jobright: {
    base_url: "https://jobright.ai",
    lists: ["saved", "recommended"],
    sync: {
      max_jobs_per_run: 100,
      skip_duplicates: true,
      write_to_pipeline: true,
      write_to_scan_history: true,
      page_delay_ms: 1500,
    },
    extraction: {
      prefer_external_url: true,
      strip_tracking_params: true,
    },
  },
};

try {
  // Try loading yaml — gracefully skip if js-yaml is not installed
  const { default: yaml } = await import("js-yaml").catch((err) => {
    // Only suppress "module not found" errors — warn on anything else
    if (!err.message?.includes("Cannot find") && !err.code?.includes("ERR_MODULE_NOT_FOUND")) {
      console.warn(`  ⚠️  Failed to import js-yaml: ${err.message}`);
    }
    return { default: null };
  });
  if (yaml) {
    const raw = fs.readFileSync(path.join(ROOT, "config/jobright.yml"), "utf8");
    cfg = yaml.load(raw);
  }
} catch {
  // use defaults
}

const BASE_URL = cfg.jobright.base_url ?? "https://jobright.ai";
const LISTS = cfg.jobright.lists ?? ["saved", "recommended"];
const MAX_JOBS = cfg.jobright.sync?.max_jobs_per_run ?? 100;
const SKIP_DUPS = cfg.jobright.sync?.skip_duplicates !== false;
const WRITE_PIPELINE = cfg.jobright.sync?.write_to_pipeline !== false;
const WRITE_HISTORY = cfg.jobright.sync?.write_to_scan_history !== false;
const PAGE_DELAY = cfg.jobright.sync?.page_delay_ms ?? 1500;
const STRIP_TRACKING = cfg.jobright.extraction?.strip_tracking_params !== false;

// List-page URL templates for each Jobright list type
const LIST_URLS = {
  saved: `${BASE_URL}/jobs?tab=saved`,
  recommended: `${BASE_URL}/jobs?tab=recommended`,
  applied: `${BASE_URL}/jobs?tab=applied`,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a file safely, returning empty string if missing */
function readSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/** Build a dedup set from all known URLs in pipeline + history + applications */
function buildKnownUrlSet() {
  const known = new Set();

  // scan-history.tsv (col 0 = url)
  for (const line of readSafe(SCAN_HISTORY_PATH).split("\n").slice(1)) {
    const url = line.split("\t")[0]?.trim();
    if (url) known.add(normalizeUrl(url));
  }

  // pipeline.md — extract bare URLs from both pending and processed lines
  for (const line of readSafe(PIPELINE_PATH).split("\n")) {
    const match = line.match(/https?:\/\/[^\s|>]+/);
    if (match) known.add(normalizeUrl(match[0].trim()));
  }

  // applications.md — extract URLs
  for (const line of readSafe(APPLICATIONS_PATH).split("\n")) {
    const match = line.match(/https?:\/\/[^\s|)>]+/);
    if (match) known.add(normalizeUrl(match[0].trim()));
  }

  return known;
}

/** Normalize a URL for dedup comparison (lowercase host, strip trailing slash) */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.toLowerCase() + u.pathname).replace(/\/$/, "") + u.search;
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

/** Append a line to data/pipeline.md under the "## Pendientes" section */
function appendToPipeline(entry) {
  // entry format: "- [ ] {canonical_url} | {company} | {title} | source:jobright | source_url:{source_url}"
  if (!WRITE_PIPELINE) return;

  let content = readSafe(PIPELINE_PATH);

  if (!content) {
    content = "## Pendientes\n\n## Procesadas\n";
  }

  // Insert before "## Procesadas" or at end of Pendientes section
  if (content.includes("## Procesadas")) {
    content = content.replace("## Procesadas", `${entry}\n\n## Procesadas`);
  } else if (content.includes("## Pendientes")) {
    content = content.replace("## Pendientes\n", `## Pendientes\n${entry}\n`);
  } else {
    content = `## Pendientes\n${entry}\n\n## Procesadas\n`;
  }

  // Ensure data/ directory exists
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(PIPELINE_PATH, content, "utf8");
}

/** Append a row to data/scan-history.tsv */
function appendToScanHistory(url, title, company, status) {
  if (!WRITE_HISTORY) return;
  const today = new Date().toISOString().slice(0, 10);
  const row = [url, today, "Jobright", title, company, status].join("\t");

  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });

  if (!fs.existsSync(SCAN_HISTORY_PATH)) {
    fs.writeFileSync(SCAN_HISTORY_PATH, "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n", "utf8");
  }
  fs.appendFileSync(SCAN_HISTORY_PATH, row + "\n", "utf8");
}

/** Collect all listing cards from a Jobright list page */
async function collectListings(page, listUrl) {
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(2000); // wait for SPA hydration

  // Jobright renders job cards with links to detail pages.
  // Try multiple selector patterns in case the layout changes.
  const listings = await page.evaluate(() => {
    const results = [];

    // Pattern A: anchor tags that link to /jobs/ detail pages
    document.querySelectorAll("a[href*='/jobs/']").forEach((el) => {
      const href = el.href;
      if (!href || href.includes("?tab=") || href === window.location.href) return;
      if (results.find((r) => r.detail_url === href)) return;

      // Try to find title and company from nearby elements
      const card = el.closest("[data-testid='job-card'], .job-card, article, li") ?? el;
      const title =
        card.querySelector("h2, h3, [data-testid='job-title'], .job-title")?.innerText?.trim() ??
        el.innerText?.trim() ??
        "";
      const company =
        card.querySelector("[data-testid='company-name'], .company-name")?.innerText?.trim() ?? "";
      const location =
        card.querySelector("[data-testid='job-location'], .job-location")?.innerText?.trim() ?? "";

      if (title || company) {
        results.push({ title, company, location, detail_url: href });
      }
    });

    return results;
  });

  return listings;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("────────────────────────────────────────────────────────");
  console.log("  Jobright.ai Sync");
  console.log("────────────────────────────────────────────────────────");
  console.log(`  Lists: ${LISTS.join(", ")}`);
  console.log(`  Max jobs: ${MAX_JOBS}`);
  console.log(`  Skip duplicates: ${SKIP_DUPS}`);
  console.log("");

  // Check session state exists
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    console.error("❌ No saved session found.");
    console.error(`   Expected: ${STORAGE_STATE_PATH}`);
    console.error("   Run: node scripts/jobright-login.mjs");
    process.exit(1);
  }

  const knownUrls = SKIP_DUPS ? buildKnownUrlSet() : new Set();
  console.log(`  Known URLs (dedup): ${knownUrls.size}`);
  console.log("");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  const stats = {
    total_found: 0,
    skipped_dup: 0,
    added: 0,
    failed: 0,
    external_resolved: 0,
    fallback_jobright: 0,
  };

  const added_entries = [];

  for (const listType of LISTS) {
    if (stats.added >= MAX_JOBS) break;

    const listUrl = LIST_URLS[listType];
    if (!listUrl) {
      console.warn(`  ⚠️  Unknown list type: ${listType} — skipping`);
      continue;
    }

    console.log(`  📋 Scanning list: ${listType} (${listUrl})`);

    let listings = [];
    try {
      listings = await collectListings(page, listUrl);
    } catch (err) {
      console.error(`  ❌ Failed to collect ${listType} listings: ${err.message}`);
      continue;
    }

    console.log(`     Found ${listings.length} cards`);
    stats.total_found += listings.length;

    for (const listing of listings) {
      if (stats.added >= MAX_JOBS) break;

      const jobrightUrl = listing.detail_url;

      // ── Resolve canonical external URL from detail page ─────────────────
      let resolved;
      try {
        resolved = await resolveCanonicalUrl(page, jobrightUrl, {
          stripTracking: STRIP_TRACKING,
        });
      } catch (err) {
        console.warn(`  ⚠️  Failed to resolve: ${jobrightUrl} — ${err.message}`);
        appendToScanHistory(jobrightUrl, listing.title, listing.company, "error");
        stats.failed++;
        continue;
      }

      // Use canonical URL as the dedup key
      const canonicalKey = normalizeUrl(resolved.canonical_url);
      const jobrightKey = normalizeUrl(jobrightUrl);

      if (SKIP_DUPS && (knownUrls.has(canonicalKey) || knownUrls.has(jobrightKey))) {
        appendToScanHistory(resolved.canonical_url, resolved.title || listing.title, resolved.company || listing.company, "skipped_dup");
        stats.skipped_dup++;
        continue;
      }

      // Track resolution method
      if (resolved.resolved_via === "source_url") {
        stats.fallback_jobright++;
      } else {
        stats.external_resolved++;
      }

      // Build pipeline entry
      const title = resolved.title || listing.title || "Unknown Role";
      const company = resolved.company || listing.company || "Unknown Company";
      const canonicalUrl = resolved.canonical_url;
      const sourceUrl = resolved.source_url;

      // Pipeline line format:
      //   - [ ] {canonical_url} | {company} | {title} | source:jobright | source_url:{source_url}
      const pipelineLine =
        `- [ ] ${canonicalUrl} | ${company} | ${title} | source:jobright | source_url:${sourceUrl}`;

      appendToPipeline(pipelineLine);
      appendToScanHistory(canonicalUrl, title, company, "added");

      // Also record the Jobright source URL to prevent re-processing
      knownUrls.add(canonicalKey);
      knownUrls.add(jobrightKey);

      stats.added++;
      added_entries.push({ company, title, canonical_url: canonicalUrl, resolved_via: resolved.resolved_via });

      console.log(`  ✅ Added: ${company} — ${title}`);
      console.log(`     canonical: ${canonicalUrl}`);
      if (resolved.resolved_via !== "source_url") {
        console.log(`     via: ${resolved.resolved_via}`);
      }

      // Rate limiting between detail page navigations
      if (PAGE_DELAY > 0) await page.waitForTimeout(PAGE_DELAY);
    }

    console.log("");
  }

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("────────────────────────────────────────────────────────");
  console.log("  Jobright Sync — Summary");
  console.log("────────────────────────────────────────────────────────");
  console.log(`  Total listings found:     ${stats.total_found}`);
  console.log(`  Skipped (duplicates):     ${stats.skipped_dup}`);
  console.log(`  Failed (errors):          ${stats.failed}`);
  console.log(`  Added to pipeline:        ${stats.added}`);
  console.log(`    External URL resolved:  ${stats.external_resolved}`);
  console.log(`    Fallback (Jobright URL): ${stats.fallback_jobright}`);
  console.log("");

  if (added_entries.length > 0) {
    console.log("  New entries:");
    for (const e of added_entries) {
      console.log(`  + ${e.company} | ${e.title} | ${e.resolved_via}`);
    }
    console.log("");
    console.log("→ Run /career-ops pipeline to evaluate the new offers.");
  } else {
    console.log("  No new offers added (all already seen or no listings found).");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
