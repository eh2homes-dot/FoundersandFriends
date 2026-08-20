#!/usr/bin/env node
/**
 * signals.js — what the hiring data is telling you.
 * ---------------------------------------------------------------------------
 * Reads /api/history and writes it up as something readable: which senior
 * roles were filled, which just opened, how long they took, and where several
 * companies are hiring for the same thing at once.
 *
 *   HISTORY_URL=https://your-site HISTORY_KEY=your-key node scripts/signals.js
 *   node scripts/signals.js --days=90
 *   node scripts/signals.js --format=text
 *
 * WHAT THIS CAN AND CANNOT SAY
 *
 * This is job data, not people data. A senior role closing means SOMEONE was
 * hired — it does not say who, or where they came from. So the language here
 * stays inside what the data supports:
 *
 *   "Progress Residential filled their VP of Operations in 34 days"   ← true
 *   "Jane Doe joined Progress Residential as VP"                      ← not
 *                                                                       known
 *
 * Getting the second would need a people layer — who holds the role now, who
 * held it before — which is LinkedIn-shaped data and a different product.
 * Claiming it from job postings alone would be a guess dressed as a fact, and
 * the first time someone catches it the whole feed loses credibility.
 * ---------------------------------------------------------------------------
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));

const URL_BASE = args.url || process.env.HISTORY_URL;
const KEY      = args.key || process.env.HISTORY_KEY || process.env.STATS_KEY;
const DAYS     = Number(args.days) || 30;
const PLAIN    = args.format === 'text';

if (!URL_BASE || !KEY) {
  console.error('Set HISTORY_URL and HISTORY_KEY (or pass --url= and --key=).');
  process.exit(1);
}

const res = await fetch(`${URL_BASE.replace(/\/$/, '')}/api/history?days=${DAYS}`, {
  headers: { 'X-Admin-Key': KEY },
});
if (!res.ok) {
  console.error(`History API returned ${res.status}. ` +
    (res.status === 401 ? 'Check HISTORY_KEY.' : 'Is worker.js deployed?'));
  process.exit(1);
}
const h = await res.json();

/* ---------- is the record trustworthy? ---------- */

// A gap in the scrape record makes "filled" and "opened" unreliable, so say so
// rather than quietly reporting numbers built on missing days.
const runs = h.recent_runs || [];
const badRuns = runs.filter((r) => r.ok === 0).length;
const days = new Set(runs.map((r) => r.day)).size;
const expected = Math.min(DAYS, 30);
const gaps = Math.max(0, expected - days);

/* ---------- shape the findings ---------- */

const filled = h.senior_roles_filled || [];
const opened = h.senior_roles_opened || [];
const hiring = h.hiring_now || [];

// Same title opening at more than one company is the market signal — a single
// company hiring a Head of Maintenance is news about them; three doing it in a
// month is news about the industry.
const normTitle = (t) => String(t || '')
  .replace(/\b(senior|sr\.?|junior|jr\.?|lead|i{1,3}|\d+)\b/gi, '')
  .replace(/[^a-z ]/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();

const byTitle = new Map();
for (const r of opened) {
  const k = normTitle(r.title);
  if (!k) continue;
  if (!byTitle.has(k)) byTitle.set(k, { title: r.title, companies: new Set() });
  byTitle.get(k).companies.add(r.company);
}
const clusters = [...byTitle.values()]
  .filter((c) => c.companies.size >= 2)
  .sort((a, b) => b.companies.size - a.companies.size);

const withDays = filled.filter((r) => Number.isFinite(r.days_open));
const medianDays = withDays.length
  ? withDays.map((r) => r.days_open).sort((a, b) => a - b)[Math.floor(withDays.length / 2)]
  : null;

/* ---------- write ---------- */

const out = [];
const H = (s) => out.push(PLAIN ? s.toUpperCase() : `## ${s}`, '');
const line = (s) => out.push(s);
const bullet = (s) => out.push(PLAIN ? `  ${s}` : `- ${s}`);

H(`Hiring signals — last ${DAYS} days`);

if (gaps > 2 || badRuns > 0) {
  line(PLAIN
    ? `NOTE: the record has ${gaps} missing day(s)${badRuns ? ` and ${badRuns} unreliable run(s)` : ''}. Treat these numbers as indicative.`
    : `> The scrape record has ${gaps} missing day${gaps === 1 ? '' : 's'}${badRuns ? ` and ${badRuns} run${badRuns === 1 ? '' : 's'} flagged unreliable` : ''}. Treat the numbers below as indicative rather than exact.`);
  line('');
}

if (filled.length) {
  H('Roles that were filled');
  line(PLAIN ? '' : 'These senior roles disappeared from the board, which means someone was hired.');
  line('');
  filled.slice(0, 12).forEach((r) => {
    const d = Number.isFinite(r.days_open) ? ` — open ${r.days_open} day${r.days_open === 1 ? '' : 's'}` : '';
    bullet(`**${r.title}** at ${r.company}${d}`);
  });
  line('');
  if (medianDays != null) {
    line(`Median time to fill: **${medianDays} days** across ${withDays.length} senior role${withDays.length === 1 ? '' : 's'}.`);
    line('');
  }
}

if (opened.length) {
  H('Senior roles that just opened');
  line(PLAIN ? '' : 'A senior seat opening usually means someone left, or the team is growing.');
  line('');
  opened.slice(0, 12).forEach((r) => {
    bullet(`**${r.title}** at ${r.company}${r.location ? ` · ${r.location}` : ''}`);
  });
  line('');
}

if (clusters.length) {
  H('Where the market is moving');
  line(PLAIN ? '' : 'The same role opening at several companies at once is worth more than any single posting.');
  line('');
  clusters.slice(0, 6).forEach((c) => {
    bullet(`**${c.title}** — hiring at ${[...c.companies].join(', ')}`);
  });
  line('');
}

if (hiring.length) {
  H('Hiring hardest right now');
  line('');
  hiring.slice(0, 10).forEach((c) => {
    bullet(`${c.company} — ${c.open_now} open role${c.open_now === 1 ? '' : 's'}`);
  });
  line('');
}

if (!filled.length && !opened.length) {
  line('No senior movement recorded in this window.');
  line('');
  line(runs.length < 3
    ? 'The history table is still filling up — this gets useful after a couple of weeks of daily scrapes.'
    : 'The record looks healthy; the market was simply quiet.');
}

console.log(out.join('\n'));
