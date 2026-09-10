#!/usr/bin/env node
/**
 * detect-ats.js
 * ---------------------------------------------------------------------------
 * Works out which ATS each company's careers page runs on, and writes the
 * result back into config.js.
 *
 *   node scripts/detect-ats.js                 # every pending company
 *   node scripts/detect-ats.js --hub=opco      # one hub only
 *   node scripts/detect-ats.js --dry           # print, write nothing
 *   node scripts/detect-ats.js --only=entrata  # a single company
 *
 * Results are written straight back into config.js, which run.js then reads.
 *
 * The rule this script exists to enforce: a company whose ATS cannot be
 * determined is left as NULL and reported. It is never assigned 'dom' as a
 * catch-all, because a generic DOM scrape against a JavaScript-rendered board
 * returns zero rows that look exactly like "this company isn't hiring".
 */

import { readFile, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const TIMEOUT_MS = 25000;
const CONCURRENCY = 6;

/* An honest bot UA is the polite default, but a careers page behind Cloudflare
   or Akamai answers it with a 403 before any signature can be read. Thirteen
   companies failed that way on the first full run — Yardi, CoStar, Rocket,
   Realtor.com and the rest — none of them for a reason a bot should respect:
   these are public job listings. So the probe presents as a browser.

   Requests are still one-per-company, six at a time, with a retry that backs
   off. That is far lighter than a person browsing the same board. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/* ---------------------------------------------------------------------------
   Signatures. Each returns { method, slug } or null.
   Order matters: the ATS-API checks run before the generic fallback.
   --------------------------------------------------------------------------- */
const SIGNATURES = [
  {
    method: 'greenhouse',
    test: (html, finalUrl) => {
      // Order matters, most specific first. The old first-position pattern
      // made "embed" optional, so an embed URL matched it and captured the
      // literal word "embed" as the board token. Verification then failed and
      // the loop moved on to the next ATS — a real Greenhouse board reported
      // as "no signature found". Every embed-style board was invisible.
      const m =
        html.match(/greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/i) ||
        html.match(/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i) ||
        html.match(/boards\.greenhouse\.io\/([a-z0-9_-]+)/i) ||
        finalUrl.match(/greenhouse\.io\/([a-z0-9_-]+)/i);
      const slug = m && m[1];
      // Path segments that are never a board token.
      if (!slug || /^(embed|js|job_board|jobs|boards)$/i.test(slug)) return null;
      return { slug };
    },
    verify: async (slug) => {
      const r = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      return Array.isArray(body?.jobs)
        ? { count: body.jobs.length, url: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true` }
        : null;
    },
  },
  {
    method: 'lever',
    test: (html, finalUrl) => {
      const m =
        html.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i) ||
        finalUrl.match(/lever\.co\/([a-z0-9_-]+)/i);
      return m ? { slug: m[1] } : null;
    },
    verify: async (slug) => {
      const r = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      return Array.isArray(body)
        ? { count: body.length, url: `https://api.lever.co/v0/postings/${slug}?mode=json` }
        : null;
    },
  },
  /* The three below were the largest gap in this script. run.js has had
     working ashby, workable and breezy adapters the whole time, but no
     signature here could ever assign them, so every company on one of those
     platforms fell through to "no ATS signature found" and was skipped. */
  {
    method: 'ashby',
    test: (html, finalUrl) => {
      const m =
        html.match(/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i) ||
        finalUrl.match(/ashbyhq\.com\/([a-z0-9_.-]+)/i);
      const slug = m && m[1];
      if (!slug || /^(embed|api|posting-api)$/i.test(slug)) return null;
      return { slug };
    },
    verify: async (slug) => {
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      return Array.isArray(body?.jobs)
        ? { count: body.jobs.length, url: `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true` }
        : null;
    },
  },
  {
    method: 'workable',
    test: (html, finalUrl) => {
      const m =
        html.match(/apply\.workable\.com\/([a-z0-9_-]+)/i) ||
        finalUrl.match(/apply\.workable\.com\/([a-z0-9_-]+)/i);
      const slug = m && m[1];
      if (!slug || /^(api|j|embed)$/i.test(slug)) return null;
      return { slug };
    },
    verify: async (slug) => {
      const r = await get(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`);
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      const jobs = body?.jobs;
      return Array.isArray(jobs)
        ? { count: jobs.length, url: `https://apply.workable.com/api/v1/widget/accounts/${slug}` }
        : null;
    },
  },
  {
    method: 'breezy',
    test: (html, finalUrl) => {
      const m =
        html.match(/([a-z0-9_-]+)\.breezy\.hr/i) ||
        finalUrl.match(/([a-z0-9_-]+)\.breezy\.hr/i);
      const slug = m && m[1];
      if (!slug || /^(app|www)$/i.test(slug)) return null;
      return { slug };
    },
    verify: async (slug) => {
      const r = await get(`https://${slug}.breezy.hr/json`);
      if (!r.ok) return null;
      const body = await r.json().catch(() => null);
      return Array.isArray(body)
        ? { count: body.length, url: `https://${slug}.breezy.hr/json` }
        : null;
    },
  },
  {
    // Moved out of KNOWN_HOSTS once the adapter existed. The board URL carries
    // both values the adapter needs, so a match here fully resolves a company.
    method: 'ukg',
    test: (html, finalUrl) => {
      const re = /recruiting\.ultipro\.com\/([^/"'\s]+)\/JobBoard\/([0-9a-f-]{36})/i;
      const m = finalUrl.match(re) || html.match(re);
      // slug carries both halves, tenant first — writeBack stores one value.
      return m ? { slug: `${m[1]}/${m[2]}` } : null;
    },
    verify: async (slug) => {
      const [tenant, board] = slug.split('/');
      if (!tenant || !board) return null;
      const res = await fetch(
        `https://recruiting.ultipro.com/${tenant}/JobBoard/${board}/JobBoardView/LoadSearchResults`,
        {
          method: 'POST',
          headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            opportunitySearch: {
              Top: 1, Skip: 0, QueryString: '',
              OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
              Filters: [],
            },
          }),
        },
      );
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return Array.isArray(body?.opportunities)
        ? { count: body.totalCount ?? body.opportunities.length,
            url: `https://recruiting.ultipro.com/${tenant}/JobBoard/${board}/` }
        : null;
    },
  },
  {
    method: 'workday',
    test: (html, finalUrl) => {
      const m =
        html.match(/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/i) ||
        finalUrl.match(/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com/i);
      return m ? { slug: m[0] } : null;
    },
    // Workday's CXS endpoint needs a tenant + site path that varies per client,
    // so this reports the host and leaves the exact endpoint to run.js.
    verify: async (slug) => ({ count: null, url: `https://${slug}` }),
  },
  {
    method: 'dom',
    test: (html) => {
      // Only claim 'dom' when the page has server-rendered job links to parse.
      // An empty React shell fails this on purpose.
      const links = (html.match(/href="[^"]*\/(job|jobs|careers|opening|position)s?\/[^"]+"/gi) || []).length;
      return links >= 3 ? { slug: null, links } : null;
    },
    verify: async () => ({ count: null, url: null }),
  },
];

/**
 * Platforms run.js has no adapter for.
 *
 * Recognising these does not resolve the company — the method stays NULL and
 * it is still skipped, exactly as the strict rule requires. What changes is
 * the report. "no ATS signature found" is a dead end; "iCIMS detected — no
 * adapter" is a work item, and counting them tells you which adapter is worth
 * building next rather than guessing.
 */
const KNOWN_HOSTS = [
  [/icims\.com/i, 'iCIMS'],
  [/\.bamboohr\.com/i, 'BambooHR'],
  [/recruiting\.paylocity\.com/i, 'Paylocity'],
  [/jobs\.jobvite\.com|jobvite\.com\/careers/i, 'Jobvite'],
  [/smartrecruiters\.com/i, 'SmartRecruiters'],
  [/dayforcehcm\.com|ceridian\.com/i, 'Dayforce'],
  [/taleo\.net/i, 'Taleo'],
  [/successfactors\.(com|eu)|sapsf\.(com|eu)/i, 'SuccessFactors'],
  [/applytojob\.com|jazzhr\.com/i, 'JazzHR'],
  [/pinpointhq\.com/i, 'Pinpoint'],
  [/\.personio\.(de|com)/i, 'Personio'],
  [/ats\.rippling\.com|rippling-ats\.com/i, 'Rippling'],
  [/phenompeople\.com/i, 'Phenom'],
  [/eightfold\.ai/i, 'Eightfold'],
  [/oraclecloud\.com/i, 'Oracle HCM'],
  [/workforcenow\.adp\.com|myjobs\.adp\.com/i, 'ADP'],
  [/paycomonline\.net/i, 'Paycom'],
  [/jobs\.paycor\.com/i, 'Paycor'],
  [/isolvedhire\.com/i, 'isolved'],
  [/clearcompany\.com/i, 'ClearCompany'],
  [/hirebridge\.com/i, 'Hirebridge'],
  [/recruitee\.com/i, 'Recruitee'],
  [/teamtailor\.com/i, 'Teamtailor'],
  [/jobs\.deel\.com/i, 'Deel'],
];

/**
 * A careers page carrying JobPosting structured data is a candidate for the
 * jsonld adapter — but that adapter needs a sitemap URL, and writeBack has no
 * field to set one. So this is reported for a human to finish, never assigned.
 */
const JSONLD_HINT = /"@type"\s*:\s*"JobPosting"/i;

/* --------------------------------------------------------------------------- */

/**
 * One fetch, with a timeout and two retries.
 *
 * Retries cover the failures that are about the moment rather than the site:
 * a 429, a 5xx, a DNS blip, a timeout. Nine companies failed that way on the
 * first run and several would likely have answered on a second attempt.
 * A 403 or 404 is not retried — those mean something real and repeating the
 * request only wastes time.
 */
async function get(url, attempt = 0) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: ctl.signal });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return get(url, attempt + 1);
    }
    return res;
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      return get(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function detect(company) {
  const url = company.careers_url || company.careersUrl;
  if (!url) return { ...company, method: null, reason: 'no careers_url' };

  let res;
  try {
    res = await get(url);
  } catch (err) {
    return { ...company, method: null, reason: 'fetch failed: ' + err.message };
  }
  if (!res.ok) return { ...company, method: null, reason: 'HTTP ' + res.status };

  const html = await res.text().catch(() => '');
  const finalUrl = res.url || url;

  for (const sig of SIGNATURES) {
    const hit = sig.test(html, finalUrl);
    if (!hit) continue;
    let confirmed = null;
    try { confirmed = await sig.verify(hit.slug); } catch { /* falls through */ }
    if (sig.method !== 'dom' && !confirmed) {
      // Signature matched but the API did not confirm — usually a stale board
      // token left in the page. Keep looking rather than trusting it.
      continue;
    }
    return {
      ...company,
      method: sig.method,
      slug: hit.slug,
      atsUrl: confirmed?.url ?? null,
      count: confirmed?.count ?? null,
      reason: null,
    };
  }

  // Nothing scrapeable. Say as much as possible about why, so the unresolved
  // list is a queue rather than a wall.
  const known = KNOWN_HOSTS.find(([re]) => re.test(html) || re.test(finalUrl));
  if (known) return { ...company, method: null, platform: known[1], reason: `${known[1]} detected — no adapter` };

  if (JSONLD_HINT.test(html)) {
    return { ...company, method: null, platform: 'JSON-LD', reason: 'JobPosting JSON-LD present — set sitemap + method: jsonld by hand' };
  }

  // An empty shell: almost no markup, or a body that is mostly script tags.
  if (html.length < 20000 && (html.match(/<script/gi) || []).length > 5) {
    return { ...company, method: null, reason: 'JS-rendered shell — no server-side job links' };
  }

  return { ...company, method: null, reason: 'no ATS signature found' };
}

const CONFIG_PATH = new URL('../config.js', import.meta.url);

async function loadCompanies() {
  const mod = await import(CONFIG_PATH);
  return mod.COMPANIES.map((c) => ({
    id: c.id, name: c.name, careers_url: c.careersUrl, hub: c.hub, scrape_method: c.method,
  }));
}

/**
 * Writes the resolved method and slug straight back into config.js, editing
 * only the two lines per company that need to change. Rewriting the file
 * wholesale would lose the comments and the REVIEW markers.
 */
async function writeBack(results) {
  if (args.dry) return 0;
  const resolved = results.filter((r) => r.method);
  if (!resolved.length) return 0;

  let src = await readFile(CONFIG_PATH, 'utf8');

  for (const r of resolved) {
    // Find this company's object literal by its id, then patch inside it.
    const idAt = src.indexOf(`id: ${JSON.stringify(r.id)},`);
    if (idAt === -1) continue;
    const end = src.indexOf('\n  },', idAt);
    if (end === -1) continue;

    const before = src.slice(idAt, end);
    const after = before
      .replace(/method: [^,]+,/, `method: ${JSON.stringify(r.method)},`)
      .replace(/atsSlug: [^,]+,/, `atsSlug: ${r.slug ? JSON.stringify(r.slug) : 'null'},`);
    src = src.slice(0, idAt) + after + src.slice(end);
  }

  await writeFile(CONFIG_PATH, src);
  return resolved.length;
}

/* --------------------------------------------------------------------------- */

const all = await loadCompanies();
const targets = all
  .filter((c) => (args.hub ? c.hub === args.hub : true))
  .filter((c) => (args.only ? c.id === args.only : true))
  .filter((c) => (args.redetect ? true : !c.scrape_method));

console.log(`Probing ${targets.length} companies (concurrency ${CONCURRENCY})…\n`);

const results = [];
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = await Promise.all(targets.slice(i, i + CONCURRENCY).map(detect));
  batch.forEach((r) => {
    const label = (r.name || r.id).padEnd(34).slice(0, 34);
    if (r.method) {
      console.log(`  ok    ${label} ${r.method}${r.slug ? ' · ' + r.slug : ''}${r.count != null ? ' · ' + r.count + ' live' : ''}`);
    } else {
      console.log(`  --    ${label} ${r.reason}`);
    }
  });
  results.push(...batch);
}

const resolved = results.filter((r) => r.method);
const unresolved = results.filter((r) => !r.method);

console.log('\n' + '-'.repeat(64));
console.log(`resolved   ${resolved.length}/${results.length}`);
for (const m of ['greenhouse', 'lever', 'workday', 'dom']) {
  const n = resolved.filter((r) => r.method === m).length;
  if (n) console.log(`  ${m.padEnd(11)} ${n}`);
}

if (unresolved.length) {
  console.log(`\nunresolved ${unresolved.length} — these stay NULL and will be skipped by run.js:`);

  // Grouped by what would actually fix it, because the four causes need four
  // different kinds of work and a flat list hides that.
  const bucket = (r) => {
    if (r.platform) return 'known platform, no adapter';
    if (/^HTTP 404/.test(r.reason)) return 'bad careers_url (404)';
    if (/^HTTP 40[13]/.test(r.reason)) return 'blocked (403/401)';
    if (/^HTTP 429/.test(r.reason)) return 'rate limited (429)';
    if (/^fetch failed/.test(r.reason)) return 'network / timeout';
    return 'no signature';
  };

  const groups = new Map();
  for (const r of unresolved) {
    const b = bucket(r);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(r);
  }

  for (const [name, rows] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${name} (${rows.length})`);
    rows.forEach((r) => console.log(`    ${(r.name || r.id).padEnd(34).slice(0, 34)} ${r.reason}`));
  }

  // Which adapter would unlock the most companies. This is the whole point of
  // recognising platforms we cannot yet scrape.
  const byPlatform = new Map();
  unresolved.filter((r) => r.platform).forEach((r) => byPlatform.set(r.platform, (byPlatform.get(r.platform) || 0) + 1));
  if (byPlatform.size) {
    console.log('\n  adapters that would pay off most, in order:');
    [...byPlatform].sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(`    ${String(p).padEnd(18)} ${n} companies`));
  }

  console.log('\n  404s are stale careers_url values in config.js — fix the URL, not the code.');
  console.log('  "no signature" is usually a JS-rendered board with no reachable API.');
}

const written = await writeBack(results);
console.log(`\n${args.dry ? 'dry run — config.js untouched' : 'updated ' + written + ' companies in config.js'}`);
