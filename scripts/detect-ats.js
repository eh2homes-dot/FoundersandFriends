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

const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;
const UA = 'FoundersAndFriendsBot/1.0 (+https://propertyandtechnology.com)';

/* ---------------------------------------------------------------------------
   Signatures. Each returns { method, slug } or null.
   Order matters: the ATS-API checks run before the generic fallback.
   --------------------------------------------------------------------------- */
const SIGNATURES = [
  {
    method: 'greenhouse',
    test: (html, finalUrl) => {
      const m =
        html.match(/boards\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i) ||
        html.match(/job-boards\.greenhouse\.io\/([a-z0-9_-]+)/i) ||
        html.match(/greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9_-]+)/i) ||
        finalUrl.match(/greenhouse\.io\/([a-z0-9_-]+)/i);
      return m ? { slug: m[1] } : null;
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

/* --------------------------------------------------------------------------- */

function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  return fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow', signal: ctl.signal })
    .finally(() => clearTimeout(timer));
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
  unresolved.forEach((r) => console.log(`  ${(r.name || r.id).padEnd(34).slice(0, 34)} ${r.reason}`));
  console.log('\nMost will be JavaScript-rendered boards. Options: find the underlying');
  console.log('ATS URL by hand and set scrape_method directly, or leave them out.');
}

const written = await writeBack(results);
console.log(`\n${args.dry ? 'dry run — config.js untouched' : 'updated ' + written + ' companies in config.js'}`);
