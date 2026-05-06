#!/usr/bin/env node
/**
 * jobright-login.mjs
 *
 * One-time browser login for Jobright.ai.
 * Opens a visible browser window, waits for you to log in manually,
 * then saves the browser session (cookies + localStorage) to
 * .auth/jobright-storage-state.json so future sync runs can reuse it.
 *
 * Usage:
 *   node scripts/jobright-login.mjs
 *
 * After running this once, run:
 *   node scripts/jobright-sync.mjs
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUTH_DIR = path.join(ROOT, ".auth");
const STORAGE_STATE_PATH = path.join(AUTH_DIR, "jobright-storage-state.json");

// Read config for base_url
let config = { jobright: { base_url: "https://jobright.ai" } };
try {
  const yaml = await import("js-yaml").then((m) => m.default).catch(() => null);
  if (yaml) {
    const raw = fs.readFileSync(path.join(ROOT, "config/jobright.yml"), "utf8");
    config = yaml.load(raw);
  }
} catch {
  // yaml not installed — use default
}

const BASE_URL = config?.jobright?.base_url ?? "https://jobright.ai";

// Ensure .auth directory exists
fs.mkdirSync(AUTH_DIR, { recursive: true });

console.log("────────────────────────────────────────────────────────");
console.log("  Jobright.ai — One-time Login");
console.log("────────────────────────────────────────────────────────");
console.log("");
console.log("A browser window will open. Please:");
console.log("  1. Log in to Jobright.ai (Google/LinkedIn/Email)");
console.log("  2. Navigate to your saved jobs or recommendations");
console.log("     to confirm the session is fully established");
console.log("  3. Come back here and press Enter to save the session");
console.log("");
console.log(`Session will be saved to: ${STORAGE_STATE_PATH}`);
console.log("");

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(BASE_URL);
console.log("Browser opened. Log in and press Enter here when ready...");

// Wait for user to press Enter
await new Promise((resolve) => {
  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  process.stdin.once("data", () => {
    process.stdin.pause();
    resolve();
  });
  process.stdout.write("> ");
});

// Save session state
await context.storageState({ path: STORAGE_STATE_PATH });
console.log("");
console.log(`✅ Session saved to: ${STORAGE_STATE_PATH}`);
console.log("");
console.log("Next step: node scripts/jobright-sync.mjs");

await browser.close();
