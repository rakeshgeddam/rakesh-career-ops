#!/usr/bin/env node
/**
 * jobright-resolve-detail.mjs
 *
 * Helper module: given a Jobright job detail page URL and an active
 * Playwright browser context, navigates to the page and extracts the
 * actual external job posting / apply URL.
 *
 * Resolution order (first match wins):
 *   1. "Apply Now" / "Apply" button href (external ATS link)
 *   2. "View Original Posting" / "View Job Posting" link href
 *   3. og:url or <link rel="canonical"> meta tag
 *   4. Fall back to the original Jobright detail URL
 *
 * Exports:
 *   resolveCanonicalUrl(page, detailUrl, options?) → Promise<ResolvedJob>
 *
 * ResolvedJob shape:
 *   {
 *     source:        "jobright",
 *     source_url:    "https://jobright.ai/jobs/...",
 *     canonical_url: "https://job-boards.greenhouse.io/...",  // best external URL found
 *     title:         "Senior Data Engineer",
 *     company:       "Acme Corp",
 *     location:      "Remote",
 *     resolved_via:  "apply_button" | "external_link" | "og_url" | "source_url"
 *   }
 */

/** Common tracking query params to strip from canonical URLs */
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "referrer", "gh_src", "lever-origin", "source",
];

/**
 * Strip common tracking query parameters from a URL string.
 * Returns the cleaned URL or the original if parsing fails.
 * @param {string} url
 * @returns {string}
 */
export function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Return true if the URL is an external job posting (not on jobright.ai).
 * @param {string} url
 * @returns {boolean}
 */
export function isExternalJobUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return !host.includes("jobright.ai") && !host.includes("jobright.com");
  } catch {
    return false;
  }
}

/**
 * Navigate to a Jobright job detail page and extract the canonical external URL.
 *
 * @param {import('playwright').Page} page - Active Playwright page (already authenticated)
 * @param {string} detailUrl - Jobright job detail URL (e.g. https://jobright.ai/jobs/abc123)
 * @param {object} [options]
 * @param {boolean} [options.stripTracking=true] - Strip tracking params from canonical URL
 * @param {string[]} [options.applySelectors]    - Custom apply button CSS selectors
 * @param {string[]} [options.externalSelectors] - Custom external link CSS selectors
 * @returns {Promise<ResolvedJob>}
 */
export async function resolveCanonicalUrl(page, detailUrl, options = {}) {
  const stripTracking = options.stripTracking !== false;

  const defaultApplySelectors = [
    "a[data-testid='apply-button']",
    "a.apply-btn",
    "a[href*='greenhouse.io']",
    "a[href*='lever.co']",
    "a[href*='ashbyhq.com']",
    "a[href*='workable.com']",
    "a[href*='smartrecruiters.com']",
    "a[href*='myworkdayjobs.com']",
    "a[href*='icims.com']",
    "a[href*='taleo.net']",
  ];
  const defaultExternalSelectors = [
    "a[data-testid='original-posting']",
    "a[data-testid='view-job']",
    "a:has-text('View Original')",
    "a:has-text('Original Posting')",
    "a:has-text('View Job Posting')",
    "a:has-text('View on Company Site')",
  ];

  const applySelectors = options.applySelectors ?? defaultApplySelectors;
  const externalSelectors = options.externalSelectors ?? defaultExternalSelectors;

  // Navigate to the detail page
  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500); // allow SPA to hydrate

  // Extract metadata (title, company, location) from the page
  const meta = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.innerText?.trim() ?? "";
    const getMeta = (name) =>
      document.querySelector(`meta[property='${name}']`)?.getAttribute("content") ??
      document.querySelector(`meta[name='${name}']`)?.getAttribute("content") ??
      "";

    return {
      title: getText("h1") || getMeta("og:title"),
      company:
        getText("[data-testid='company-name']") ||
        getText(".company-name") ||
        getMeta("og:site_name"),
      location: getText("[data-testid='job-location']") || getText(".job-location"),
      og_url: getMeta("og:url"),
      canonical:
        document.querySelector("link[rel='canonical']")?.getAttribute("href") ?? "",
    };
  });

  // --- Strategy 1: Apply button with an ATS/external href ---
  const pageUrl = page.url();
  for (const selector of applySelectors) {
    try {
      const rawHref = await page
        .locator(selector)
        .first()
        .getAttribute("href", { timeout: 2000 });
      if (!rawHref) continue;
      // Resolve relative URLs against the current page URL
      const href = new URL(rawHref, pageUrl).toString();
      if (isExternalJobUrl(href)) {
        const canonical = stripTracking ? stripTrackingParams(href) : href;
        return buildResult(meta, detailUrl, canonical, "apply_button");
      }
    } catch {
      // selector not found — try next
    }
  }

  // --- Strategy 2: "View Original Posting" / external link ---
  for (const selector of externalSelectors) {
    try {
      const rawHref = await page
        .locator(selector)
        .first()
        .getAttribute("href", { timeout: 2000 });
      if (!rawHref) continue;
      const href = new URL(rawHref, pageUrl).toString();
      if (isExternalJobUrl(href)) {
        const canonical = stripTracking ? stripTrackingParams(href) : href;
        return buildResult(meta, detailUrl, canonical, "external_link");
      }
    } catch {
      // selector not found — try next
    }
  }

  // --- Strategy 3: og:url or <link rel="canonical"> ---
  for (const candidate of [meta.og_url, meta.canonical]) {
    if (candidate && isExternalJobUrl(candidate)) {
      const canonical = stripTracking ? stripTrackingParams(candidate) : candidate;
      return buildResult(meta, detailUrl, canonical, "og_url");
    }
  }

  // --- Fallback: return the Jobright detail URL as canonical ---
  return buildResult(meta, detailUrl, detailUrl, "source_url");
}

/**
 * @param {object} meta
 * @param {string} sourceUrl
 * @param {string} canonicalUrl
 * @param {string} resolvedVia
 * @returns {ResolvedJob}
 */
function buildResult(meta, sourceUrl, canonicalUrl, resolvedVia) {
  return {
    source: "jobright",
    source_url: sourceUrl,
    canonical_url: canonicalUrl,
    title: meta.title || "",
    company: meta.company || "",
    location: meta.location || "",
    resolved_via: resolvedVia,
  };
}
