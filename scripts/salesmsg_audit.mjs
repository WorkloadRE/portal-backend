#!/usr/bin/env node
/*
 * Salesmsg foreclosure-lead location audit
 *
 * Logs into Salesmsg, filters contacts by the `foreclosure` tag,
 * walks each conversation, extracts any U.S. locations mentioned by
 * the lead (not by you/your team), and writes a CSV.
 *
 * Standalone — not wired into portal-backend. Copy this file to your
 * machine and run it there.
 *
 * Setup (run once on your machine):
 *   npm init -y
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Run:
 *   SALESMSG_EMAIL='you@example.com' \
 *   SALESMSG_PASSWORD='...' \
 *   node salesmsg_audit.mjs
 *
 * Optional env vars:
 *   SALESMSG_TAG          tag to filter by (default: foreclosure)
 *   SALESMSG_BASE_URL     base URL (default: https://app.salesmsg.com)
 *   OUTPUT_CSV            output path (default: ./salesmsg_foreclosure_audit.csv)
 *   HEADLESS              "false" to watch the browser (default: true)
 *   MAX_CONTACTS          cap for testing (default: no cap)
 *   DEBUG_SCREENSHOTS     "true" to dump screenshots on error (default: true)
 *
 * NOTE ON SELECTORS: Salesmsg does not publish a stable DOM contract.
 * The selectors in the SELECTORS block below are best-guess and WILL
 * likely need tweaking the first time you run this. Run with
 * HEADLESS=false the first time, watch where it stops, and adjust.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const EMAIL = process.env.SALESMSG_EMAIL;
const PASSWORD = process.env.SALESMSG_PASSWORD;
const TAG = process.env.SALESMSG_TAG || 'foreclosure';
const BASE_URL = (process.env.SALESMSG_BASE_URL || 'https://app.salesmsg.com').replace(/\/$/, '');
const OUTPUT_CSV = process.env.OUTPUT_CSV || './salesmsg_foreclosure_audit.csv';
const HEADLESS = process.env.HEADLESS !== 'false';
const MAX_CONTACTS = process.env.MAX_CONTACTS ? parseInt(process.env.MAX_CONTACTS, 10) : Infinity;
const DEBUG_SCREENSHOTS = process.env.DEBUG_SCREENSHOTS !== 'false';

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: set SALESMSG_EMAIL and SALESMSG_PASSWORD env vars.');
  process.exit(1);
}

// --- Selectors (adjust if Salesmsg UI differs) ---------------------------
const SELECTORS = {
  loginEmail: 'input[type="email"], input[name="email"]',
  loginPassword: 'input[type="password"], input[name="password"]',
  loginSubmit: 'button[type="submit"]',
  loggedInMarker: '[data-testid="sidebar"], nav, aside',
  contactsNav: 'a[href*="/contacts"]',
  tagFilterTrigger: 'button:has-text("Tag"), button:has-text("Tags"), [data-testid*="tag-filter"]',
  tagSearchInput: 'input[placeholder*="Search" i], input[type="search"]',
  contactRow: '[data-testid="contact-row"], tr[role="row"], a[href*="/contacts/"]',
  conversationMessage: '[data-testid="message"], [class*="message"][class*="bubble"], li[class*="message"]',
  inboundMessageMarker: '[data-direction="inbound"], [class*="inbound"], [class*="received"]',
  conversationLoadMore: 'button:has-text("Load older"), button:has-text("Load more")',
  contactName: 'h1, h2, [data-testid="contact-name"]',
  contactPhone: '[data-testid="contact-phone"], a[href^="tel:"]',
};

// --- US state lookup for location extraction ----------------------------
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};
const STATE_NAMES = new Set(Object.values(US_STATES).map(s => s.toLowerCase()));
const STATE_ABBR = new Set(Object.keys(US_STATES));

const INTENT_KEYWORDS = [
  'interested', 'looking', 'buy', 'buying', 'purchase', 'purchasing',
  'move', 'moving', 'relocate', 'relocating', 'invest', 'investing',
  'searching', 'shopping', 'want to live', 'considering',
];

/**
 * Extract candidate locations from message text.
 * Returns a deduped list of strings like "Tampa, FL", "Phoenix", "33647".
 */
function extractLocations(text) {
  if (!text) return [];
  const found = new Set();

  // "<City>, <ST>" pattern — strongest signal
  const cityState = /\b([A-Z][a-zA-Z.\-]+(?:\s+[A-Z][a-zA-Z.\-]+){0,3}),\s+([A-Z]{2})\b/g;
  for (const m of text.matchAll(cityState)) {
    if (STATE_ABBR.has(m[2])) found.add(`${m[1]}, ${m[2]}`);
  }

  // "<City> <State full name>"
  const cityFullState = new RegExp(
    `\\b([A-Z][a-zA-Z.\\-]+(?:\\s+[A-Z][a-zA-Z.\\-]+){0,3}),?\\s+(${Object.values(US_STATES).join('|')})\\b`,
    'g',
  );
  for (const m of text.matchAll(cityFullState)) found.add(`${m[1]}, ${m[2]}`);

  // ZIP codes
  for (const m of text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)) found.add(m[1]);

  // Intent keyword + following proper-noun phrase
  for (const kw of INTENT_KEYWORDS) {
    const re = new RegExp(
      `\\b${kw}\\b[^.?!\\n]{0,40}?\\bin\\s+([A-Z][a-zA-Z.\\-]+(?:\\s+[A-Z][a-zA-Z.\\-]+){0,3})`,
      'gi',
    );
    for (const m of text.matchAll(re)) {
      const candidate = m[1].trim();
      if (!STATE_NAMES.has(candidate.toLowerCase())) found.add(candidate);
    }
  }

  // Standalone state names mentioned after intent words
  for (const stateName of Object.values(US_STATES)) {
    const re = new RegExp(
      `\\b(?:${INTENT_KEYWORDS.join('|')})\\b[^.?!\\n]{0,40}?\\b${stateName}\\b`,
      'i',
    );
    if (re.test(text)) found.add(stateName);
  }

  return [...found];
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function snapshot(page, name) {
  if (!DEBUG_SCREENSHOTS) return;
  try {
    const dir = path.join(path.dirname(OUTPUT_CSV), 'salesmsg_debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.error(`  [debug screenshot] ${file}`);
  } catch {}
}

async function login(page) {
  console.log(`[1/4] Logging into ${BASE_URL} ...`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill(SELECTORS.loginEmail, EMAIL);
  await page.fill(SELECTORS.loginPassword, PASSWORD);
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.click(SELECTORS.loginSubmit),
  ]);
  try {
    await page.waitForSelector(SELECTORS.loggedInMarker, { timeout: 20_000 });
  } catch (e) {
    await snapshot(page, 'login_failed');
    throw new Error('Login did not complete — check credentials, 2FA, or selectors.');
  }
  console.log('      logged in.');
}

async function openContactsFilteredByTag(page) {
  console.log(`[2/4] Filtering contacts by tag "${TAG}" ...`);
  // Try direct URL first (Salesmsg often supports ?tags= query); fall back to UI.
  const directUrl = `${BASE_URL}/contacts?tags=${encodeURIComponent(TAG)}`;
  await page.goto(directUrl, { waitUntil: 'networkidle' });

  const hasRows = await page.locator(SELECTORS.contactRow).count();
  if (hasRows > 0) {
    console.log(`      direct URL returned ${hasRows} row(s) on first page.`);
    return;
  }

  // UI fallback — click tag filter, search the tag, apply.
  console.log('      direct URL did not show rows, falling back to UI filter.');
  await page.goto(`${BASE_URL}/contacts`, { waitUntil: 'networkidle' });
  try {
    await page.click(SELECTORS.tagFilterTrigger, { timeout: 5000 });
    const input = page.locator(SELECTORS.tagSearchInput).first();
    await input.fill(TAG);
    await page.click(`text=/^${TAG}$/i`);
    await page.keyboard.press('Escape');
    await page.waitForLoadState('networkidle');
  } catch (e) {
    await snapshot(page, 'tag_filter_failed');
    throw new Error(`Could not apply tag filter via UI. Inspect screenshot and adjust SELECTORS.tagFilterTrigger / tagSearchInput.`);
  }
}

async function collectContactLinks(page) {
  console.log('[3/4] Collecting contact links ...');
  // Scroll until no new rows appear, with a hard cap.
  let lastCount = 0;
  for (let i = 0; i < 50; i++) {
    const count = await page.locator(SELECTORS.contactRow).count();
    if (count === lastCount) break;
    lastCount = count;
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(400);
  }
  const hrefs = await page.locator(SELECTORS.contactRow).evaluateAll((els) => {
    const out = [];
    for (const el of els) {
      const a = el.tagName === 'A' ? el : el.querySelector('a[href*="/contacts/"]');
      if (a && a.href && !out.includes(a.href)) out.push(a.href);
    }
    return out;
  });
  console.log(`      found ${hrefs.length} contact link(s).`);
  return hrefs.slice(0, MAX_CONTACTS);
}

async function scrapeContact(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });

  // Try to load older messages a few times.
  for (let i = 0; i < 5; i++) {
    const btn = page.locator(SELECTORS.conversationLoadMore).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
    } else break;
  }

  const name = (await page.locator(SELECTORS.contactName).first().textContent().catch(() => '') || '').trim();
  const phone = (await page.locator(SELECTORS.contactPhone).first().textContent().catch(() => '') || '').trim();

  // Pull inbound message text. We err on the side of including everything
  // and filtering by direction marker class if present.
  const messages = await page.locator(SELECTORS.conversationMessage).evaluateAll((els) => {
    return els.map(el => {
      const cls = (el.className || '').toString().toLowerCase();
      const dir = el.getAttribute('data-direction') || '';
      const isOutbound = cls.includes('outbound') || cls.includes('sent') || dir === 'outbound';
      return { text: (el.innerText || '').trim(), isOutbound };
    });
  });

  const inboundText = messages.filter(m => !m.isOutbound).map(m => m.text).join('\n');
  const locations = extractLocations(inboundText);

  return {
    name,
    phone,
    url,
    inboundMessageCount: messages.filter(m => !m.isOutbound).length,
    locations,
  };
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const rows = [];
  try {
    await login(page);
    await openContactsFilteredByTag(page);
    const links = await collectContactLinks(page);

    console.log(`[4/4] Scraping ${links.length} conversation(s) ...`);
    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      try {
        const r = await scrapeContact(page, url);
        console.log(`  (${i + 1}/${links.length}) ${r.name || '(no name)'} — ${r.locations.length} location(s)`);
        if (r.locations.length > 0) rows.push(r);
      } catch (e) {
        console.error(`  (${i + 1}/${links.length}) FAILED ${url}: ${e.message}`);
        await snapshot(page, `contact_${i}_failed`);
      }
    }
  } finally {
    await browser.close();
  }

  // Write CSV.
  const header = ['contact_name', 'phone', 'locations_mentioned', 'inbound_message_count', 'conversation_url'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.name),
      csvEscape(r.phone),
      csvEscape(r.locations.join('; ')),
      csvEscape(r.inboundMessageCount),
      csvEscape(r.url),
    ].join(','));
  }
  fs.writeFileSync(OUTPUT_CSV, lines.join('\n'));
  console.log(`\nDone. ${rows.length} contact(s) with location mentions written to ${OUTPUT_CSV}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
