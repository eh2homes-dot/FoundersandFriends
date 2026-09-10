#!/usr/bin/env node
/**
 * find-careers-url.js
 * ---------------------------------------------------------------------------
 * Finds a working careers page for companies whose configured careers_url is
 * dead, and proposes a replacement.
 *
 *   node scripts/find-careers-url.js                  # every broken company
 *   node scripts/find-careers-url.js --hub=opco       # one hub
 *   node scripts/find-careers-url.js --only=amh       # one company
 *   node scripts/find-careers-url.js --all            # ignore the broken filter
 *   node scripts/find-careers-url.js --write          # patch config.js
 *
 * Reports only, unless --write is passed. That default is deliberate: a wrong
 * careers_url is worse than a missing one, because it produces a page that
 * scrapes cleanly to zero roles and looks exactly like a company that is not
 * hiring. Read the candidates, then write.
 *
 * The detector's own output is the input here. 27 companies failed with a 404
 * and 6 with a network error — a third of everything unresolved, none of it a
 * code problem. This script exists to turn that pile into a list a human can
 * confirm in a few minutes rather than a few hours.
 */

import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const TIMEOUT_MS = 20000;
const CONCURRENCY = 4;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* Paths worth trying, roughly in order of how often they are the real one.
   Kept short on purpose: every entry costs one request per company, and the
   homepage crawl below catches the unusual cases far more reliably than a
   longer guess list would. */
const PATHS = [
  '/careers', '/careers/', '/jobs', '/about/careers', '/company/careers',
  '/join-us', '/work-with-us', '/about/jobs', '/company/jobs',
  '/careers/open-positions', '/careers/jobs', '/about-us/careers', '/join',
];

/* An href pointing at one of these is a direct hit — it is the job board
   itself, not a page that might link to one. Ranked above everything else. */
const ATS_HOSTS = [
  /boards\.greenhouse\.io|job-boards\.greenhouse\.io/i,
  /jobs\.lever\.co/i,
  /jobs\.ashbyhq\.com/i,
  /apply\.workable\.com/i,
  /[a-z0-9-]+\.breezy\.hr/i,
  /[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com/i,
];

/* Same idea, but for platforms with no adapter yet. Still worth surfacing:
   knowing a company sits on UKG is what makes the adapter decision evidence
   rather than a guess. */
const KNOWN_HOSTS = [
  [/icims\.com/i, 'iCIMS'], [/\.bamboohr\.com/i, 'BambooHR'],
  [/recruiting\.paylocity\.com/i, 'Paylocity'], [/smartrecruiters\.com/i, 'SmartRecruiters'],
  [/dayforcehcm\.com/i, 'Dayforce'], [/taleo\.net/i, 'Taleo'],
  [/successfactors\.(com|eu)|sapsf\.(com|eu)/i, 'SuccessFactors'],
  [/ultipro\.com|\.ukg\.(com|net)/i, 'UKG'], [/applytojob\.com|jazzhr\.com/i, 'JazzHR'],
  [/ats\.rippling\.com|rippling-ats\.com/i, 'Rippling'], [/phenompeople\.com/i, 'Phenom'],
  [/oraclecloud\.com/i, 'Oracle HCM'], [/workforcenow\.adp\.com|myjobs\.adp\.com/i, 'ADP'],
  [/paycomonline\.net/i, 'Paycom'], [/isolvedhire\.com/i, 'isolved'],
  [/jobvite\.com/i, 'Jobvite'], [/teamtailor\.com/i, 'Teamtailor'],
];

/* --------------------------------------------------------------------------- */

async function get(url, attempt = 0) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: ctl.signal });
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 2500));
      return get(url, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 2500));
      return get(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Origin to probe: the company website if set, otherwise whatever host the
 *  dead careers_url pointed at. A 404 usually means a moved page, not a moved
 *  company, so the old host is still the best guess. */
function baseOrigin(company) {
  for (const raw of [company.website, company.careers_url]) {
    if (!raw) continue;
    try { return new URL(raw).origin; } catch { /* keep looking */ }
  }
  return null;
}

/** Every link on a page, absolute, deduped. */
function links(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try { out.add(new URL(m[1], base).toString()); } catch { /* skip junk hrefs */ }
  }
  return [...out];
}

/** How good a candidate is. Higher wins. */
function scorePage(url, html) {
  const all = links(html, url);

  const atsLink = all.find((h) => ATS_HOSTS.some((re) => re.test(h)));
  if (atsLink) return { score: 100, why: 'links to a supported ATS', evidence: atsLink };

  if (ATS_HOSTS.some((re) => re.test(url))) {
    return { score: 95, why: 'is a supported ATS board', evidence: url };
  }

  const knownLink = all.find((h) => KNOWN_HOSTS.some(([re]) => re.test(h)));
  if (knownLink) {
    const name = KNOWN_HOSTS.find(([re]) => re.test(knownLink))[1];
    return { score: 70, why: `links to ${name} (no adapter yet)`, evidence: knownLink };
  }

  const jobLinks = all.filter((h) => /\/(job|jobs|careers|opening|position)s?\//i.test(h)).length;
  if (jobLinks >= 3) return { score: 60, why: `${jobLinks} job links on the page`, evidence: null };

  if (/"@type"\s*:\s*"JobPosting"/i.test(html)) {
    return { score: 55, why: 'JobPosting structured data present', evidence: null };
  }

  if (/\b(open positions|current openings|join our team|view all jobs)\b/i.test(html)) {
    return { score: 30, why: 'reads like a careers page, no job links found', evidence: null };
  }

  return { score: 10, why: 'responds 200, nothing job-shaped on it', evidence: null };
}

async function probe(url) {
  try {
    const res = await get(url);
    if (!res.ok) return null;
    const html = await res.text().catch(() => '');
    const finalUrl = res.url || url;
    return { url: finalUrl, ...scorePage(finalUrl, html) };
  } catch {
    return null;
  }
}

/** Careers links found on the homepage. Catches the paths a guess list never
 *  would — /company/life-at-x, /who-we-are/opportunities, and so on. */
async function fromHomepage(origin) {
  try {
    const res = await get(origin);
    if (!res.ok) return [];
    const html = await res.text().catch(() => '');
    const base = res.url || origin;

    return links(html, base)
      .filter((h) => /career|job|join|opening|work-with|life-at|opportunit/i.test(h))
      .filter((h) => {
        // Keep same-site links and ATS links; drop social and share URLs.
        if (ATS_HOSTS.some((re) => re.test(h)) || KNOWN_HOSTS.some(([re]) => re.test(h))) return true;
        try { return new URL(h).origin === new URL(base).origin; } catch { return false; }
      })
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function discover(company) {
  const origin = baseOrigin(company);
  if (!origin) return { ...company, candidates: [], note: 'no website or careers_url to work from' };

  const tried = new Set();
  const candidates = [];

  // Guessed paths first — cheap, and right more often than not.
  for (const p of PATHS) {
    const url = origin + p;
    if (tried.has(url)) continue;
    tried.add(url);
    const hit = await probe(url);
    if (hit) candidates.push(hit);
    // A direct ATS hit ends the search; nothing scores higher.
    if (hit && hit.score >= 95) break;
  }

  // Then the homepage crawl, if nothing convincing turned up.
  if (!candidates.some((c) => c.score >= 60)) {
    for (const url of await fromHomepage(origin)) {
      if (tried.has(url)) continue;
      tried.add(url);
      const hit = await probe(url);
      if (hit) candidates.push(hit);
      if (hit && hit.score >= 95) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return { ...company, candidates };
}

/* --------------------------------------------------------------------------- */

const CONFIG_PATH = new URL('../config.js', import.meta.url);

async function loadCompanies() {
  const mod = await import(CONFIG_PATH);
  return mod.COMPANIES.map((c) => ({
    id: c.id, name: c.name, hub: c.hub,
    careers_url: c.careersUrl, website: c.website, scrape_method: c.method,
  }));
}

/** Patches careersUrl in place, same surgical approach detect-ats.js uses:
 *  find the company's object literal by id, replace one line inside it, leave
 *  the comments and REVIEW markers alone. */
async function writeBack(results) {
  const picks = results
    .map((r) => ({ r, best: r.candidates?.[0] }))
    .filter(({ best }) => best && best.score >= 60);

  if (!picks.length) return 0;

  let src = await readFile(CONFIG_PATH, 'utf8');
  let n = 0;

  for (const { r, best } of picks) {
    const idAt = src.indexOf(`id: ${JSON.stringify(r.id)},`);
    if (idAt === -1) continue;
    const end = src.indexOf('\n  },', idAt);
    if (end === -1) continue;

    const before = src.slice(idAt, end);
    if (!/careersUrl: /.test(before)) continue;
    const after = before.replace(/careersUrl: [^,]+,/, `careersUrl: ${JSON.stringify(best.url)},`);
    if (after === before) continue;

    src = src.slice(0, idAt) + after + src.slice(end);
    n += 1;
  }

  await writeFile(CONFIG_PATH, src);
  return n;
}

/* --------------------------------------------------------------------------- */

const all = await loadCompanies();

const targets = all
  .filter((c) => (args.hub ? c.hub === args.hub : true))
  .filter((c) => (args.only ? c.id === args.only : true))
  // By default: companies with no working scrape method. Those are the ones
  // whose careers_url is worth questioning.
  .filter((c) => (args.all ? true : !c.scrape_method));

console.log(`Looking for careers pages: ${targets.length} companies (concurrency ${CONCURRENCY})\n`);

const results = [];
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = await Promise.all(targets.slice(i, i + CONCURRENCY).map(discover));
  batch.forEach((r) => {
    const label = (r.name || r.id).padEnd(34).slice(0, 34);
    const best = r.candidates?.[0];
    if (!best) {
      console.log(`  --    ${label} nothing found${r.note ? ' — ' + r.note : ''}`);
    } else {
      const mark = best.score >= 95 ? 'ATS ' : best.score >= 60 ? 'ok  ' : '?   ';
      console.log(`  ${mark}  ${label} ${best.url}`);
      console.log(`        ${''.padEnd(34)} ${best.why}${best.evidence ? ' → ' + best.evidence : ''}`);
    }
  });
  results.push(...batch);
}

/* ---- summary ---- */

const strong = results.filter((r) => r.candidates?.[0]?.score >= 60);
const weak = results.filter((r) => r.candidates?.[0] && r.candidates[0].score < 60);
const none = results.filter((r) => !r.candidates?.length);

console.log('\n' + '-'.repeat(64));
console.log(`confident   ${strong.length}  — a real board, safe to write`);
console.log(`uncertain   ${weak.length}  — responds, but nothing job-shaped; check by hand`);
console.log(`not found   ${none.length}`);

if (strong.length) {
  console.log('\nready to write:');
  strong.forEach((r) => {
    console.log(`  ${(r.name || r.id).padEnd(34).slice(0, 34)} ${r.candidates[0].url}`);
    if (r.careers_url) console.log(`  ${''.padEnd(34)} was: ${r.careers_url}`);
  });
}

if (weak.length) {
  console.log('\nworth a manual look:');
  weak.forEach((r) => console.log(`  ${(r.name || r.id).padEnd(34).slice(0, 34)} ${r.candidates[0].url}  (${r.candidates[0].why})`));
}

if (args.write) {
  const n = await writeBack(results);
  console.log(`\nwrote ${n} careers_url values into config.js`);
  console.log('Run detect-ats.js next — a fixed URL is only useful once its ATS is known.');
} else {
  console.log('\nNothing written. Re-run with --write to apply the confident ones.');
}
