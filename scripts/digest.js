#!/usr/bin/env node
/**
 * digest.js — turn the feed into newsletter copy.
 * ---------------------------------------------------------------------------
 * Reads site/jobs.json, picks the roles worth writing about, and prints
 * markdown you can paste straight into Beehiiv.
 *
 *   node scripts/digest.js                 # since the last digest
 *   node scripts/digest.js --days=7        # a fixed window instead
 *   node scripts/digest.js --limit=12      # more or fewer roles
 *   node scripts/digest.js --hub=opco      # one hub only
 *   node scripts/digest.js --format=text   # plain text, no markdown
 *
 * WHY THIS FILTERS HARD
 *
 * "Everything new this week" out of 398 roles is forty maintenance technicians
 * and nobody finishes reading it. A digest people finish beats a list they
 * skim, so this scores roles and keeps the top handful.
 *
 * Weighting, highest first:
 *
 *   seniority          a Head of Revenue outranks twenty field roles
 *   first-time company a vendor that has never posted before is news
 *   disclosed pay      rare in this industry, and it draws clicks
 *   unusual title      "Director of AI" at an operator says something
 *   operator over      the board's positioning is scattered-site operators;
 *   vendor             vendors are the supporting cast
 *
 * A state file (.digest-state.json) records what has already been sent, so
 * consecutive runs never repeat a role.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));

const FEED   = args.feed || 'site/jobs.json';
const STATE  = args.state || '.digest-state.json';
const LIMIT  = Number(args.limit) || 10;
const HUB    = args.hub || 'all';
const DAYS   = args.days ? Number(args.days) : null;
const PLAIN  = args.format === 'text';

/* ---------- load ---------- */

if (!fs.existsSync(FEED)) {
  console.error(`No feed at ${FEED}. Run the scraper first.`);
  process.exit(1);
}
const feed = JSON.parse(fs.readFileSync(FEED, 'utf8'));
const jobs = (feed.jobs || []).filter((j) => HUB === 'all' || j.hub === HUB);

let state = { sent: [], lastRun: null };
if (fs.existsSync(STATE)) {
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* start fresh */ }
}
const alreadySent = new Set(state.sent || []);

/* ---------- which roles are new ---------- */

// Prefer the employer's own posted date; fall back to when we first saw it.
const dateOf = (j) => new Date(j.posted_at || j.scraped_at || 0);
const cutoff = DAYS
  ? new Date(Date.now() - DAYS * 86400000)
  : (state.lastRun ? new Date(state.lastRun) : new Date(Date.now() - 7 * 86400000));

// Companies that had never appeared before this digest. Computed against the
// sent list rather than the feed, because the feed is only ever "now".
const seenCompanies = new Set((state.companies || []));

// On the very first run there is no history, so nothing can honestly be called
// "first time on the board" — everything would be, which tells the reader
// nothing. The flag stays off until there is a baseline to compare against.
const haveBaseline = seenCompanies.size > 0;

const candidates = jobs.filter((j) => !alreadySent.has(j.id) && dateOf(j) >= cutoff);

/* ---------- score ---------- */

const LEVEL_SCORE = { 'C-Suite': 60, VP: 45, Director: 35, Manager: 12, Field: 2 };

// Titles that signal where the market is moving rather than routine backfill.
const NOTABLE = /\b(ai|artificial intelligence|machine learning|data|automation|revenue operations|revops|growth|strategy|transformation|innovation)\b/i;

function score(j) {
  let s = LEVEL_SCORE[j.level] ?? 10;

  if (haveBaseline && !seenCompanies.has(j.company)) s += 25;   // first time we've seen them hire
  if (j.comp_min) s += 15;                          // pay disclosed
  if (NOTABLE.test(j.title)) s += 20;               // says something about the market
  if (j.hub === 'opco') s += 10;                    // operators are the positioning

  // Two roles from one company is a theme; five is a wall.
  return s;
}

const ranked = candidates
  .map((j) => ({ j, s: score(j) }))
  .sort((a, b) => b.s - a.s);

// Cap any one company at two roles, so a single big poster cannot fill the
// digest and crowd out everyone else.
const perCompany = new Map();
const picked = [];
for (const { j } of ranked) {
  const n = perCompany.get(j.company) || 0;
  if (n >= 2) continue;
  perCompany.set(j.company, n + 1);
  picked.push(j);
  if (picked.length >= LIMIT) break;
}

/* ---------- write ---------- */

const money = (j) => {
  if (!j.comp_min) return '';
  const k = (n) => '$' + Math.round(n / 1000) + 'k';
  return j.comp_min === j.comp_max ? ` · ${k(j.comp_min)}` : ` · ${k(j.comp_min)}–${k(j.comp_max)}`;
};

const isNewCompany = (j) => haveBaseline && !seenCompanies.has(j.company);

if (!picked.length) {
  console.log('Nothing new worth writing about since the last digest.');
  console.log(`(${candidates.length} new roles, none scored high enough — or the window is too short.)`);
  process.exit(0);
}

const opco = picked.filter((j) => j.hub === 'opco');
const pt   = picked.filter((j) => j.hub === 'proptech');

const out = [];

if (PLAIN) {
  out.push(`NEW ON THE BOARD — ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`);
  out.push('');
  const list = (label, arr) => {
    if (!arr.length) return;
    out.push(label.toUpperCase());
    arr.forEach((j) => out.push(`  ${j.title} — ${j.company} · ${j.location}${money(j)}`));
    out.push('');
  };
  list('Operators', opco);
  list('Technology', pt);
} else {
  out.push(`## New on the board`);
  out.push('');
  // Say what is actually true: how many are new, and that this is a selection.
  out.push(candidates.length > picked.length
    ? `${candidates.length} roles went up since the last issue. Here are ${picked.length} worth a look.`
    : `${picked.length} new role${picked.length === 1 ? '' : 's'} since the last issue.`);
  out.push('');

  const section = (label, arr) => {
    if (!arr.length) return;
    out.push(`### ${label}`);
    out.push('');
    arr.forEach((j) => {
      const flag = isNewCompany(j) ? ' *(first time on the board)*' : '';
      out.push(`**[${j.title}](${j.apply_url || '#'})** — ${j.company}  `);
      out.push(`${j.location}${money(j)}${flag}`);
      out.push('');
    });
  };
  section('Operators', opco);
  section('Technology', pt);

  out.push('---');
  out.push('');
  out.push(`[See all ${feed.count} open roles →](https://foundersandfriends.eh2homes.workers.dev)`);
}

console.log(out.join('\n'));

/* ---------- remember ---------- */

if (!args['dry-run']) {
  fs.writeFileSync(STATE, JSON.stringify({
    lastRun: new Date().toISOString(),
    sent: [...alreadySent, ...picked.map((j) => j.id)].slice(-2000),
    companies: [...new Set([...seenCompanies, ...jobs.map((j) => j.company)])],
  }, null, 2));
  console.error(`\n(state written to ${STATE} — ${picked.length} roles marked as sent)`);
}
