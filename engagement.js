/* ===========================================================================
   engagement.js — rank roles by what people actually did, not by what a
   title-scorer guesses is good.

     topPerformers(jobs, events, opts) → the best-performing roles, ranked
     companyPerformance(jobs, events)  → the same, aggregated per company

   Input shapes, both plain arrays:

     jobs   [{ id, title, company, location, min, max, firstSeen }]
     events [{ jobId, type, ts }]        type: 'view' | 'click' | 'apply'

   Map your D1 rows into those two shapes and nothing else here needs to know
   your schema. `firstSeen` and `ts` may be ISO strings or epoch millis.

   ---------------------------------------------------------------------------
   The trap this is built around

   Raw totals rank by age: a role live for six weeks beats a better role live
   for three days, every time. Raw RATES rank by luck: a job with 2 views and
   2 clicks scores 100% and tops the list on a sample of two.

   So rates are smoothed toward the board average, in proportion to how little
   evidence there is (PRIOR_WEIGHT below). A job with thousands of views keeps
   its own number; a job with nine gets pulled most of the way back to average
   until it earns otherwise. Totals are then divided by days live, so the
   ranking is per-day performance rather than a seniority list.
   =========================================================================== */

const PRIOR_WEIGHT = 25;   // evidence, in events, before a rate is trusted alone
const MIN_EVENTS   = 12;   // below this a role is reported but not ranked
const GRACE_DAYS   = 2.5;  // added to age when computing per-day rates, so a
                           // role live for one day cannot post a huge daily
                           // average off a single application

const ms = (v) => {
  if (!v) return 0;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};
const daysLive = (job, now) => {
  const t = ms(job.firstSeen);
  if (!t) return 1;
  return Math.max(1, (now - t) / 86400000);
};

function tally(jobs, events){
  const rows = new Map();
  for (const j of jobs || []) rows.set(String(j.id), { job: j, views: 0, clicks: 0, applies: 0 });
  for (const e of events || []){
    const r = rows.get(String(e.jobId));
    if (!r) continue;
    if (e.type === 'view') r.views++;
    else if (e.type === 'click') r.clicks++;
    else if (e.type === 'apply') r.applies++;
  }
  return rows;
}

/**
 * @param opts.limit        how many to return (default 10)
 * @param opts.now          timestamp to measure age against (default Date.now())
 * @param opts.perCompany   optional cap per company; off by default, because a
 *                          performance ranking should report what happened
 * @param opts.window       only count events from the last N days (default 7)
 */
export function topPerformers(jobs, events, opts = {}){
  const { limit = 10, now = Date.now(), perCompany = 0, window = 7 } = opts;
  const cutoff = now - window * 86400000;
  const inWindow = (events || []).filter(e => !e.ts || ms(e.ts) >= cutoff);

  const rows = [...tally(jobs, inWindow).values()];

  // Board averages, which are what a thin sample gets pulled toward.
  const tot = rows.reduce((a, r) => ({
    views: a.views + r.views, clicks: a.clicks + r.clicks, applies: a.applies + r.applies,
  }), { views: 0, clicks: 0, applies: 0 });
  const avgCtr   = tot.views  ? tot.clicks  / tot.views  : 0.05;
  const avgApply = tot.clicks ? tot.applies / tot.clicks : 0.08;

  const scored = rows.map(r => {
    const days = daysLive(r.job, now);
    const events_ = r.views + r.clicks + r.applies;

    // Smoothed rates: own number when there is evidence, board average when
    // there is not. This is the whole defence against small-sample winners.
    const ctr = (r.clicks + PRIOR_WEIGHT * avgCtr) / (r.views + PRIOR_WEIGHT);
    const applyRate = (r.applies + PRIOR_WEIGHT * avgApply) / (r.clicks + PRIOR_WEIGHT);

    // Per-day volume, so a long-running role does not win on age alone. The
    // grace period is the other half of that: without it, dividing by a very
    // small age turns one application on day one into "one per day" and a
    // day-old role outranks a proven one.
    const clicksPerDay = r.clicks / (days + GRACE_DAYS);
    const appliesPerDay = r.applies / (days + GRACE_DAYS);

    // Applications are the outcome that matters, clicks are intent, views are
    // only exposure — weighted accordingly.
    const score = (appliesPerDay * 100) + (clicksPerDay * 12) + (ctr * 60) + (applyRate * 120);

    return {
      ...r.job,
      views: r.views, clicks: r.clicks, applies: r.applies,
      ctr, applyRate, clicksPerDay, appliesPerDay,
      daysLive: Math.round(days * 10) / 10,
      events: events_,
      thin: events_ < MIN_EVENTS,
      score: Math.round(score * 10) / 10,
    };
  });

  const ranked = scored
    .filter(r => !r.thin)
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Map();
  for (const r of ranked){
    if (picked.length >= limit) break;
    if (perCompany){
      const n = seen.get(r.company) || 0;
      if (n >= perCompany) continue;
      seen.set(r.company, n + 1);
    }
    picked.push(r);
  }

  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const text = [
    `Most-engaged roles on the board, past ${window} days`,
    '',
    ...picked.map((r, i) =>
      `${i + 1}. ${r.title} — ${r.company}\n` +
      `   ${r.views} views · ${r.clicks} clicks (${pct(r.ctr)}) · ${r.applies} applications`),
    '',
    `Full board: propertyandtechnologyjobs.com`,
  ].join('\n');

  return {
    data: {
      picked,
      excludedThin: scored.filter(r => r.thin).length,
      board: { avgCtr, avgApply, totals: tot },
    },
    text,
  };
}

/** The same signal rolled up per company — which employers are drawing interest. */
export function companyPerformance(jobs, events, { now = Date.now(), window = 7 } = {}){
  const cutoff = now - window * 86400000;
  const rows = [...tally(jobs, (events || []).filter(e => !e.ts || ms(e.ts) >= cutoff)).values()];

  const byCo = new Map();
  for (const r of rows){
    const co = r.job.company || 'Unknown';
    if (!byCo.has(co)) byCo.set(co, { company: co, roles: 0, views: 0, clicks: 0, applies: 0 });
    const c = byCo.get(co);
    c.roles++; c.views += r.views; c.clicks += r.clicks; c.applies += r.applies;
  }

  const out = [...byCo.values()].map(c => ({
    ...c,
    ctr: c.views ? c.clicks / c.views : 0,
    appliesPerRole: c.roles ? c.applies / c.roles : 0,
  })).sort((a, b) => b.applies - a.applies || b.clicks - a.clicks);

  return { data: out };
}
