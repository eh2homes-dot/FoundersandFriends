/**
 * lead-sheet.js — roles from the master leads sheet, via the weekly job search
 * ---------------------------------------------------------------------------
 * The board's own scraper works from config.js, a hand-kept list. The master
 * leads sheet ("SYNDEO Real Estate Hiring Leads", OpCo + PropTech tabs) is the
 * list Evan actually maintains, and the weekly job search in
 * eh2homes-dot/syndeo-jobsearch already reads every company on it, including
 * boards this scraper has no adapter for (Dayforce, Paycom, isolved, JazzHR,
 * Jobvite, and careers pages that only render in a browser).
 *
 * That is why the board showed 5 operators while the OpCo tab lists 42: the
 * two never met. This module brings the weekly search's results in, so every
 * company on the sheet can reach the board:
 *
 *   - a config.js company with no scrape method, or whose scrape fails, falls
 *     back to the sheet's rows for it
 *   - a sheet company config.js has never heard of is added
 *   - a config.js company that scrapes fine keeps its own rows (daily, with
 *     descriptions) — the sheet never overrides a working scrape
 *
 * Rows go through every filter run.js applies to any other source (not a job,
 * outside the US, off-board titles, corporate scope), so nothing here widens
 * what the board publishes. It only widens which companies are read.
 *
 * Sources, newest first, from the public syndeo-jobsearch repo:
 *   out/opco-jobs-all-YYYY-MM-DD.csv        OpCo tab, every open role
 *   output/YYYY-MM-DD/all_open_roles.csv    Master/PropTech tabs, every open role
 *
 * Override either with a local path or URL for testing:
 *   LEADS_OPCO_CSV=... LEADS_PROPTECH_CSV=... node run.js --dry
 *
 * Never fatal. If GitHub is unreachable or the files are missing, the run
 * carries on with config.js alone and says so in the log.
 */

import { readFile } from 'node:fs/promises';

const REPO = 'eh2homes-dot/syndeo-jobsearch';
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const API = `https://api.github.com/repos/${REPO}/contents`;

/* The weekly search runs Sundays. Rows older than this are more likely closed
   than open, and the board's own carry-over limit is the same 14 days. */
const MAX_AGE_DAYS = 14;

/* ---- CSV ------------------------------------------------------------------ */

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/* ---- names ---------------------------------------------------------------- */

/* The sheet and config.js spell the same company differently: "PURE Homeriver
   Group" / "PURE HomeRiver Group", "Evernest Property Management" / "Evernest",
   "Key Renter Property Managment" (sic) / "Keyrenter Property Management".
   Matching on a stripped key catches all three without a hand-kept alias list. */
const NOISE = /\b(inc|llc|l\.?p|corp|corporation|company|co|group|holdings|the|property management|property managment|properties|real estate|living|homes?)\b/g;

/* Abbreviations the sheet uses for a company config.js spells out. */
const ALIASES = { pmi: 'propertymanagementinc' };

export function nameKey(name) {
  const base = String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/&/g, ' and ');
  const plain = base.replace(/[^a-z0-9]+/g, '');
  // "Property Management Inc" is nothing but noise words, so it would strip to
  // an empty key and match nothing. Fall back to the unstripped name.
  const key = base.replace(NOISE, ' ').replace(/[^a-z0-9]+/g, '') || plain;
  return ALIASES[key] || key;
}

function slug(name) {
  return String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* A sheet company with no config.js entry needs a hub. OpCo-tab rows are
   operators by definition; Master/PropTech rows go by their segment, because
   the Master tab mixes operators ("SFR Operator", "Multifamily Property
   Manager") in with software. */
const OPERATOR = /\b(sfr|operator|property manag|multifamily|reit|landlord|build[- ]to[- ]rent|btr|single[- ]family)\b/i;
const SOFTWARE = /\b(software|platform|tech|saas|marketplace|fintech|insur|data|analytics|app)\b/i;

function hubFor(source, segment) {
  if (source === 'opco') return 'opco';
  return OPERATOR.test(segment || '') && !SOFTWARE.test(segment || '') ? 'opco' : 'proptech';
}

/* ---- fetching ------------------------------------------------------------- */

async function fetchText(src) {
  if (!/^https?:/i.test(src)) return readFile(src, 'utf8');
  const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src}`);
  return res.text();
}

async function listDir(path) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`${API}/${path}`, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub listing of ${path}: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body.map((e) => e.name) : [];
}

const dateOf = (s) => (String(s).match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null;

/** Newest OpCo file: out/opco-jobs-all-YYYY-MM-DD.csv */
async function latestOpco() {
  const names = (await listDir('out')).filter((n) => /^opco-jobs-all-\d{4}-\d{2}-\d{2}\.csv$/.test(n)).sort();
  const name = names.at(-1);
  if (!name) throw new Error('no opco-jobs-all-*.csv in syndeo-jobsearch/out');
  return { url: `${RAW}/out/${name}`, date: dateOf(name) };
}

/** Newest scheduled PropTech run: output/YYYY-MM-DD/all_open_roles.csv
    (on-demand runs live under output/on-demand and are ignored). */
async function latestProptech() {
  const dirs = (await listDir('output')).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  for (const d of dirs.slice(0, 4)) {
    const url = `${RAW}/output/${d}/all_open_roles.csv`;
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (res?.ok) return { url, date: d };
  }
  throw new Error('no recent output/*/all_open_roles.csv in syndeo-jobsearch');
}

/* ---- rows ----------------------------------------------------------------- */

/* The PropTech file re-checks links. A role whose page 404s is not shown,
   even though the ATS still lists it — a dead link costs the candidate. */
const DEAD_LINK = /link check failed \(HTTP 4\d\d\)/i;

function toRaw(r) {
  return {
    sourceId: r.url,
    title: r.title,
    location: r.location || 'See posting',
    url: r.url,
    description: '',
    postedAt: /^\d{4}-\d{2}-\d{2}/.test(r.posted || r.posted_at || '') ? (r.posted || r.posted_at).slice(0, 10) : null,
    min: null, max: null,
  };
}

async function loadSource(source, override, finder, log) {
  let src = override, date = null;
  try {
    if (!src) ({ url: src, date } = await finder());
    const text = await fetchText(src);
    date = date || dateOf(src);
    const age = date ? (Date.now() - Date.parse(date)) / 86400000 : 0;
    if (age > MAX_AGE_DAYS) {
      log(`leads     ${source}: newest weekly file is ${Math.floor(age)} days old (${date}) — not used`);
      return [];
    }
    const rows = parseCsv(text).filter((r) => r.company && r.title && r.url && !DEAD_LINK.test(r.link_status || ''));
    log(`leads     ${source}: ${rows.length} roles across ${new Set(rows.map((r) => r.company)).size} companies` +
      (date ? ` (weekly search of ${date})` : ''));
    return rows.map((r) => ({ ...r, _source: source }));
  } catch (err) {
    log(`leads     ${source}: unavailable (${err.message}) — continuing without it`);
    return [];
  }
}

/**
 * Load the sheet's roles and work out which companies they belong to.
 *
 * @param companies  every config.js + database company (active or not)
 * @returns {
 *   rowsFor(company) -> raw rows for that company, or [] ,
 *   added            -> new company objects for sheet companies config.js lacks,
 *   matched          -> Set of config.js ids the sheet has rows for,
 * }
 */
export async function loadLeadSheet(companies, log = console.log) {
  const [opco, proptech] = await Promise.all([
    loadSource('opco', process.env.LEADS_OPCO_CSV, latestOpco, log),
    loadSource('proptech', process.env.LEADS_PROPTECH_CSV, latestProptech, log),
  ]);
  const rows = [...opco, ...proptech];

  const byKey = new Map();
  for (const c of companies) {
    const k = nameKey(c.name);
    if (k && !byKey.has(k)) byKey.set(k, c);
  }

  const groups = new Map();   // company id -> raw rows
  const added = new Map();    // id -> new company
  const seenUrl = new Set();

  for (const r of rows) {
    if (seenUrl.has(r.url)) continue;   // a company on both tabs
    seenUrl.add(r.url);

    let c = byKey.get(nameKey(r.company));
    if (!c) {
      const id = 'lead-' + slug(r.company);
      c = added.get(id);
      if (!c) {
        c = {
          id, name: r.company,
          hub: hubFor(r._source, r.segment),
          segment: r.segment || (r._source === 'opco' ? 'Operator' : null),
          state: r.state || null,
          careersUrl: r.column_d || null,
          verified: true, active: true, method: 'leadsheet', fromLeadSheet: true,
        };
        added.set(id, c);
        byKey.set(nameKey(r.company), c);
      }
    }
    if (!groups.has(c.id)) groups.set(c.id, []);
    groups.get(c.id).push(toRaw(r));
  }

  return {
    rowsFor: (company) => groups.get(company.id) || [],
    has: (company) => groups.has(company.id),
    added: [...added.values()],
    matched: new Set([...groups.keys()].filter((id) => !added.has(id))),
  };
}
