#!/usr/bin/env node
/**
 * run.js — job scraper
 * ---------------------------------------------------------------------------
 * Pulls open roles from company career pages and writes site/jobs.json beside
 * site/index.html, which the page reads directly. No database.
 *
 *   node run.js                          # every company with a known method
 *   node run.js --hub=opco               # one hub
 *   node run.js --only=entrata           # one company
 *   node run.js --dry                    # scrape, print, write nothing
 *   node run.js --out=site/jobs.json     # default
 *
 * THE RULE, INHERITED FROM THE ORIGINAL SCRAPER: a source that fails is logged
 * as an error. It never contributes invented or stale rows. If a source fails
 * mid-run, its previously-seen jobs are carried over from the existing feed
 * rather than silently disappearing — a scrape failure is not evidence that a
 * company stopped hiring.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { COMPANIES } from './config.js';

/* ---- options -------------------------------------------------------------- */
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const OUT = args.out || 'site/jobs.json';
const TIMEOUT_MS = 20000;
const CONCURRENCY = 4;          // polite: four career sites at a time, not 123
const DELAY_MS = 350;           // between batches
const UA = 'FoundersAndFriendsBot/1.0 (+https://propertyandtechnology.com)';

/* ---- helpers -------------------------------------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  return fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/html', ...opts.headers },
    redirect: 'follow',
    signal: ctl.signal,
  }).finally(() => clearTimeout(timer));
}

/** Strip HTML to readable text — descriptions arrive as markup from every ATS. */
/**
 * HTML to readable text.
 *
 * Greenhouse and some Workday tenants return content that is HTML-ESCAPED —
 * `&lt;p&gt;` rather than `<p>`. Stripping tags before decoding entities would
 * leave those escaped tags behind as visible text, which is exactly what
 * happened. So: decode first, strip second, and repeat while the string keeps
 * changing to catch double-escaping.
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&hellip;|&#8230;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/gi, '&');          // last, or it re-creates other entities
}

function stripTags(s) {
  return String(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
}

function toText(html) {
  if (!html) return '';
  let s = String(html);

  // Alternate decode/strip until it settles. Two passes handles the normal
  // double-escaped case; the cap stops a pathological input looping.
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = stripTags(decodeEntities(s));
    if (s === before) break;
  }

  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** First couple of sentences, for the card. */
function summarise(text, max = 180) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…');
}

/**
 * Compensation, when a posting states it. Deliberately conservative: a wrong
 * salary is worse than none, so anything ambiguous returns nulls.
 */
function parseComp(text) {
  if (!text) return { min: null, max: null };
  const t = String(text).replace(/,/g, '');

  // "$120,000 - $150,000" or "$120k–$150k"
  const range = t.match(/\$\s?(\d{2,3})(k|000)?\s*(?:-|–|—|to)\s*\$?\s?(\d{2,3})(k|000)?/i);
  if (range) {
    const scale = (n, suffix) => (suffix && suffix.toLowerCase() === 'k' ? +n * 1000 : (+n < 1000 ? +n * 1000 : +n));
    const min = scale(range[1], range[2]);
    const max = scale(range[3], range[4]);
    // sanity: real salaries, right way round
    if (min >= 20000 && max <= 1000000 && min <= max) return { min, max };
  }
  return { min: null, max: null };
}

/**
 * Which role family a posting belongs to. These become the left-hand nodes in
 * the matching web, so the buckets have to be few and stable.
 */
function categorise(title = '') {
  const t = title.toLowerCase();
  if (/\b(ceo|coo|cto|cfo|chief|president|vp|vice president|head of|director)\b/.test(t)) return 'Leadership';
  if (/\b(leasing|leasing agent|leasing consultant|lease)\b/.test(t)) return 'Leasing';
  if (/\b(maintenance|technician|tech|hvac|plumb|electric|turn|make.?ready|facilit)\b/.test(t)) return 'Maintenance';
  if (/\b(asset manage|portfolio|acquisition|underwrit|analyst|revenue|pricing|valuation)\b/.test(t)) return 'Asset Management';
  if (/\b(construct|renovat|project manager|capex|rehab)\b/.test(t)) return 'Construction';
  if (/\b(engineer|developer|software|product|data|ai|ml|devops|security|design|qa)\b/.test(t)) return 'Technology';
  return 'General';
}

/** Best-effort seniority, used only as a chip in the drawer. */
function levelOf(title = '') {
  const t = title.toLowerCase();
  if (/\b(chief|ceo|coo|cto|cfo|president|founder)\b/.test(t)) return 'C-Suite';
  if (/\b(vp|vice president|head of)\b/.test(t)) return 'VP';
  if (/\bdirector\b/.test(t)) return 'Director';
  if (/\b(manager|lead|supervisor|superintendent|principal|senior|sr\.?)\b/.test(t)) return 'Manager';
  if (/\b(technician|associate|coordinator|assistant|specialist|representative|agent|intern|junior|jr\.?)\b/.test(t)) return 'Field';
  return 'Manager';
}

const segmentOf = (company) => (company.hub === 'proptech' ? 'PropTech' : 'Single-Family');

/* ==========================================================================
   ADAPTERS
   Each returns an array of raw jobs, or throws. Throwing is how a source
   reports failure — the caller decides what to do about it.
   ========================================================================== */

async function greenhouse(company) {
  const slug = company.atsSlug;
  if (!slug) throw new Error('no atsSlug for greenhouse');
  const res = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  if (!res.ok) throw new Error('greenhouse HTTP ' + res.status);
  const body = await res.json();
  if (!Array.isArray(body.jobs)) throw new Error('greenhouse returned no jobs array');

  return body.jobs.map((j) => {
    const text = toText(j.content);
    return {
      sourceId: String(j.id),
      title: j.title,
      location: j.location?.name || 'Remote',
      url: j.absolute_url,
      description: text,
      postedAt: j.updated_at || j.first_published || null,
      ...parseComp(text),
    };
  });
}

async function lever(company) {
  const slug = company.atsSlug;
  if (!slug) throw new Error('no atsSlug for lever');
  const res = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res.ok) throw new Error('lever HTTP ' + res.status);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('lever returned no array');

  return body.map((j) => {
    const text = toText([j.descriptionPlain || j.description, ...(j.lists || []).map((l) => l.content)].join('\n'));
    return {
      sourceId: String(j.id),
      title: j.text,
      location: j.categories?.location || 'Remote',
      url: j.hostedUrl || j.applyUrl,
      description: text,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      ...parseComp(text + ' ' + (j.salaryRange ? JSON.stringify(j.salaryRange) : '')),
    };
  });
}

async function workday(company) {
  // Workday's CXS endpoint needs a tenant and a site path, both of which vary
  // per client and both of which live in the careers URL:
  //     {tenant}.wdN.myworkdayjobs.com/{site}
  const host = company.atsSlug || '';
  const m = (company.careersUrl || '').match(/myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  const site = company.atsSite || (m && m[1]);
  if (!host || !site) throw new Error('workday needs atsSlug (the host) and a site path');

  const tenant = host.split('.')[0];
  const url = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;

  // This endpoint is a POST with a JSON body, not a GET. A GET returns 405 and
  // looks like the company simply has no openings, which is worse than an error.
  // It also pages 20 at a time, so a large operator needs several calls.
  const all = [];
  const PAGE = 20;
  for (let offset = 0; offset < 400; offset += PAGE) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: '' }),
    });
    if (!res.ok) throw new Error('workday HTTP ' + res.status);

    const body = await res.json();
    const posts = body.jobPostings || [];
    all.push(...posts);

    const total = body.total ?? all.length;
    if (posts.length < PAGE || all.length >= total) break;
    await sleep(200);              // be polite between pages
  }

  if (!all.length) throw new Error('workday returned no jobPostings');

  return all.map((j) => ({
    sourceId: String(j.bulletFields?.[0] || j.externalPath),
    title: j.title,
    location: j.locationsText || 'Remote',
    // externalPath already starts with a slash, and the public job URL lives
    // under the site path rather than the bare host
    url: `https://${host}/${site}${j.externalPath}`,
    description: '',               // full text needs a second call per job
    postedAt: /^\d{4}-\d{2}-\d{2}/.test(j.startDate || '') ? j.startDate : null,
    ...parseComp(j.title),
  }));
}

/**
 * Generic DOM scrape. Only viable where the careers page server-renders its
 * job links; a JavaScript-rendered board returns nothing here, which is why
 * detect-ats.js refuses to assign this method unless it sees real links.
 */
/**
 * Navigation and call-to-action links live under /careers/ too, and the DOM
 * adapter cannot tell them from postings by URL alone. "See all opportunities"
 * got through an earlier exact-match filter and appeared on the board as a
 * role, which is worse than missing a real one — it makes the whole feed look
 * untrustworthy. When in doubt, drop it.
 */
function isNotAJob(title) {
  const t = title.trim().toLowerCase().replace(/[.!→>»]+$/, '').trim();

  // Whole-phrase CTAs and nav labels.
  if (/^(apply|apply now|view|view all|view more|view jobs?|see all|see more|see jobs?|learn more|read more|explore|explore all|search|search jobs?|browse|browse jobs?|all jobs?|all openings?|open (roles?|positions?|jobs?)|current openings?|join us|join our team|work (with|for) us|careers?|jobs?|opportunities|life at .*|our (culture|team|values|benefits)|benefits|culture|diversity.*|back|next|previous|home|contact( us)?|sign in|log ?in|register|subscribe|newsletter|privacy.*|terms.*|cookie.*)$/i.test(t)) return true;

  // Phrases that begin like a CTA — "See all opportunities", "View our openings".
  if (/^(see|view|browse|explore|search|find|discover|check out|learn)\b.{0,40}\b(job|jobs|role|roles|opening|openings|opportunit\w*|position|positions|career|careers|team)\b/i.test(t)) return true;

  // Location or department index pages rather than a specific posting.
  if (/^(all|browse by|filter by|jobs in|careers in|openings in)\b/i.test(t)) return true;

  // A bare number, a date, or a single short word is not a job title.
  if (/^[\d\s\-–—/,.]+$/.test(t)) return true;
  if (!/\s/.test(t) && t.length < 8) return true;

  return false;
}

async function dom(company) {
  const res = await get(company.careersUrl);
  if (!res.ok) throw new Error('dom HTTP ' + res.status);
  const html = await res.text();

  const seen = new Map();
  const re = /<a[^>]+href="([^"]*\/(?:job|jobs|careers|opening|position)s?\/[^"#?]+)"[^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const title = toText(m[2]).split('\n')[0].trim();
    if (!title || title.length < 3 || title.length > 140) continue;
    if (isNotAJob(title)) continue;
    const url = href.startsWith('http') ? href : new URL(href, res.url).href;
    if (!seen.has(url)) seen.set(url, { sourceId: url, title, location: 'See posting', url, description: '', postedAt: null, min: null, max: null });
  }

  const jobs = [...seen.values()];
  if (!jobs.length) throw new Error('dom found no job links — page is probably JS-rendered');
  return jobs;
}

const ADAPTERS = { greenhouse, lever, workday, dom };

/* ==========================================================================
   RUN
   ========================================================================== */

function normalise(raw, company) {
  const description = raw.description || '';
  return {
    id: `${company.method}:${company.id}:${raw.sourceId}`,
    hub: company.hub,
    title: String(raw.title).trim(),
    company: company.name,
    company_id: company.id,
    priority: company.priority === true,
    category: categorise(raw.title),
    segment: segmentOf(company),
    level: levelOf(raw.title),
    location: String(raw.location || 'Remote').trim(),
    employment_type: /intern/i.test(raw.title) ? 'contract' : 'full-time',
    comp_min: raw.min,
    comp_max: raw.max,
    summary: summarise(description) || `${raw.title} at ${company.name}.`,
    description,
    apply_url: raw.url,
    source: company.method,
    posted_at: raw.postedAt,
    scraped_at: new Date().toISOString(),
    status: 'open',
  };
}

async function scrapeOne(company) {
  const adapter = ADAPTERS[company.method];
  if (!adapter) return { company, ok: false, skipped: true, reason: 'no scrape method set', jobs: [] };
  try {
    const raw = await adapter(company);
    const jobs = raw
      .filter((j) => j && j.title && j.sourceId)
      .map((j) => normalise(j, company));
    return { company, ok: true, jobs };
  } catch (err) {
    return { company, ok: false, reason: err.message, jobs: [] };
  }
}

/** Jobs from the last successful run, so a failing source does not vanish. */
async function loadPrevious(path) {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const jobs = Array.isArray(data) ? data : data.jobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

const targets = COMPANIES
  .filter((c) => c.active !== false)
  .filter((c) => (args.hub ? c.hub === args.hub : true))
  .filter((c) => (args.only ? c.id === args.only : true));

const ready = targets.filter((c) => c.method);
const pending = targets.filter((c) => !c.method);

console.log(`Scraping ${ready.length} companies` +
  (pending.length ? `, skipping ${pending.length} with no method set` : '') + '\n');

const results = [];
for (let i = 0; i < ready.length; i += CONCURRENCY) {
  const batch = await Promise.all(ready.slice(i, i + CONCURRENCY).map(scrapeOne));
  for (const r of batch) {
    const label = r.company.name.padEnd(30).slice(0, 30);
    console.log(r.ok
      ? `  ok    ${label} ${r.jobs.length} role${r.jobs.length === 1 ? '' : 's'}`
      : `  FAIL  ${label} ${r.reason}`);
  }
  results.push(...batch);
  if (i + CONCURRENCY < ready.length) await sleep(DELAY_MS);
}

const okResults = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok && !r.skipped);
const fresh = okResults.flatMap((r) => r.jobs);

// Carry over jobs from sources that failed this run. A scrape failure is not
// evidence that a company stopped hiring, and dropping them would make the
// board look like the market emptied out.
const failedIds = new Set(failed.map((r) => r.company.id));
const previous = await loadPrevious(OUT);
const carried = previous.filter((j) => failedIds.has(j.company_id));

const all = [...fresh, ...carried];

console.log('\n' + '-'.repeat(60));
console.log(`scraped   ${fresh.length} roles from ${okResults.length} sources`);
if (carried.length) console.log(`carried   ${carried.length} roles from ${failed.length} failed source(s)`);
if (pending.length) console.log(`skipped   ${pending.length} companies with no method — run scripts/detect-ats.js`);
if (failed.length) {
  console.log(`\nfailed ${failed.length}:`);
  failed.forEach((r) => console.log(`  ${r.company.name.padEnd(30).slice(0, 30)} ${r.reason}`));
}

// A priority company failing empties the hub it anchors, so say so loudly
// rather than leaving it as one line among forty.
const priorityFailed = failed.filter((r) => r.company.priority);
if (priorityFailed.length) {
  console.log('\n' + '!'.repeat(60));
  console.log('PRIORITY COMPANIES FAILED — the board will look empty without these:');
  priorityFailed.forEach((r) => console.log(`  ${r.company.name}: ${r.reason}`));
  console.log('!'.repeat(60));
}

// Per-hub totals, so "no OpCo roles" is visible in the log rather than only
// on the live site.
for (const h of ['opco', 'proptech']) {
  const n = all.filter((j) => j.hub === h).length;
  const src = new Set(all.filter((j) => j.hub === h).map((j) => j.company)).size;
  console.log(`${h.padEnd(9)} ${String(n).padStart(4)} roles from ${src} companies`);
  if (n === 0) console.log(`          ^ nothing for the ${h} hub — check the failures above`);
}

// Refuse to publish an empty feed. Better to leave yesterday's file in place
// than to replace a working board with nothing.
if (!all.length) {
  console.error('\nNo jobs collected — refusing to write an empty feed.');
  process.exit(1);
}

if (args.dry) {
  console.log('\ndry run — nothing written');
  process.exit(0);
}

// Every source failing is an outage, not a quiet day. The feed still holds
// carried-over roles so the board keeps working, but the run is marked failed
// so GitHub emails you instead of the problem going unnoticed for weeks.
const totalFailure = ready.length > 0 && okResults.length === 0;

const feed = {
  generated_at: new Date().toISOString(),
  count: all.length,
  sources_ok: okResults.length,
  sources_failed: failed.length,
  jobs: all.sort((a, b) => (b.posted_at || '').localeCompare(a.posted_at || '')),
};

await writeFile(OUT, JSON.stringify(feed, null, 2) + '\n');
console.log(`\nwrote ${OUT} — ${all.length} roles`);

if (totalFailure) {
  console.error('\nEvery source failed. The feed kept its previous roles, but this needs looking at.');
  process.exit(1);
}
