/**
 * admin-reports.js — the two autoreports, for admin.html.
 * ---------------------------------------------------------------------------
 *   GET /api/report/top?days=7     best-performing roles, by real engagement
 *   GET /api/report/brief?days=7   what moved: opened, closed, senior changes
 *
 * Both are admin-only and both return { data, text }. `data` drives the UI,
 * `text` is a finished block to paste into LinkedIn or the newsletter.
 *
 * Written against the schema as it actually is:
 *   job_clicks    job_id, job_title, company, hub, category, clicked_at
 *   applications  job_id, job_title, company, hub, created_at
 *   job_history   company, hub, title, level, location, first_seen, closed_at
 *   scrape_runs   ran_at, total_roles, sources_failed, new_roles, closed_roles, ok
 *
 * There is no impressions table, so there is no click-through rate. Ranking
 * runs on clicks and applications, which is the stronger half of the funnel
 * anyway — an impression is exposure, a click is intent, an application is
 * the outcome.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/* Below this much evidence a role is counted but not ranked. Without it, one
   click on a role posted yesterday reads as a perfect daily average and tops
   the list over something with fifty times the history. */
const MIN_EVENTS = 12;

/* Added to a role's age before dividing. Same guard, other direction: without
   it, dividing by a very small number of days turns a single application into
   "one per day". */
const GRACE_DAYS = 2.5;

const deny = () =>
  new Response(JSON.stringify({ error: 'admin only' }), { status: 401, headers: JSON_HEADERS });

const ok = (payload) =>
  new Response(JSON.stringify(payload), { headers: JSON_HEADERS });

const windowDays = (request, fallback = 7) => {
  const n = parseInt(new URL(request.url).searchParams.get('days') || '', 10);
  return Number.isFinite(n) && n > 0 && n <= 90 ? n : fallback;
};

/* --------------------------------------------------------------------------
   1. Top performing roles
   -------------------------------------------------------------------------- */

export async function topRolesReport(request, env) {
  if (!adminAuthed(request, env)) return deny();
  if (!env.DB) return ok({ error: 'no database bound', data: null, text: '' });

  const days = windowDays(request);
  const since = `-${days} days`;

  const [clickRows, applyRows] = await Promise.all([
    // MIN(clicked_at) stands in for how long the role has been drawing
    // attention. job_history has no job_id to join on, and the first click is
    // a good enough proxy for the age of a listing's exposure.
    env.DB.prepare(
      `SELECT job_id, job_title, company, hub, category,
              COUNT(*) AS clicks,
              MIN(clicked_at) AS first_click
         FROM job_clicks
        WHERE clicked_at > datetime('now', ?1)
          AND job_id IS NOT NULL AND job_title IS NOT NULL
        GROUP BY job_id`).bind(since).all(),

    env.DB.prepare(
      `SELECT job_id, COUNT(*) AS applies
         FROM applications
        WHERE created_at > datetime('now', ?1) AND job_id IS NOT NULL
        GROUP BY job_id`).bind(since).all(),
  ]);

  const applies = new Map((applyRows.results || []).map(r => [String(r.job_id), r.applies]));
  const now = Date.now();

  const scored = (clickRows.results || []).map(r => {
    const seen = Date.parse((r.first_click || '').replace(' ', 'T') + 'Z');
    const live = Math.max(1, Number.isFinite(seen) ? (now - seen) / 86400000 : days);
    const a = applies.get(String(r.job_id)) || 0;
    const events = r.clicks + a;

    const clicksPerDay = r.clicks / (live + GRACE_DAYS);
    const appliesPerDay = a / (live + GRACE_DAYS);

    // An application is worth far more than a click: it is the outcome, not
    // the intent. The 8:1 weighting reflects that, not the raw counts.
    const score = appliesPerDay * 100 + clicksPerDay * 12;

    return {
      job_id: r.job_id, title: r.job_title, company: r.company,
      hub: r.hub, category: r.category,
      clicks: r.clicks, applies: a,
      daysLive: Math.round(live * 10) / 10,
      score: Math.round(score * 10) / 10,
      thin: events < MIN_EVENTS,
    };
  });

  const ranked = scored.filter(r => !r.thin).sort((x, y) => y.score - x.score).slice(0, 10);
  const held = scored.length - scored.filter(r => !r.thin).length;

  const text = [
    `Most-engaged roles on the board, past ${days} days`,
    '',
    ...ranked.map((r, i) =>
      `${i + 1}. ${r.title} — ${r.company}\n` +
      `   ${r.clicks} clicks · ${r.applies} application${r.applies === 1 ? '' : 's'}`),
    '',
    'Full board: propertyandtechnologyjobs.com',
  ].join('\n');

  return ok({
    data: {
      window_days: days,
      ranked,
      held_back_thin: held,
      totals: {
        clicks: scored.reduce((n, r) => n + r.clicks, 0),
        applies: scored.reduce((n, r) => n + r.applies, 0),
        roles: scored.length,
      },
    },
    text,
  });
}

/* --------------------------------------------------------------------------
   2. Movement brief
   -------------------------------------------------------------------------- */

export async function movementBriefReport(request, env) {
  if (!adminAuthed(request, env)) return deny();
  if (!env.DB) return ok({ error: 'no database bound', data: null, text: '' });

  const days = windowDays(request);
  const since = `-${days} days`;

  const [opened, closed, net, seniorOut, seniorIn, health] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_history WHERE first_seen > datetime('now', ?1)`).bind(since).first(),

    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_history WHERE closed_at > datetime('now', ?1)`).bind(since).first(),

    env.DB.prepare(
      `SELECT company, hub,
              SUM(CASE WHEN first_seen > datetime('now', ?1) THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN closed_at  > datetime('now', ?1) THEN 1 ELSE 0 END) AS closed,
              SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open_now
         FROM job_history
        GROUP BY company, hub
       HAVING opened > 0 OR closed > 0
        ORDER BY (opened - closed) DESC`).bind(since).all(),

    // Senior roles that closed. Reported as CLOSED, never as "hired" — a
    // listing can vanish because it was filled, cancelled, expired, or missed
    // by the scraper, and those look identical from outside. Naming a person
    // or a hire on this evidence would eventually be publicly wrong.
    env.DB.prepare(
      `SELECT company, hub, title, level, days_open, closed_at
         FROM job_history
        WHERE closed_at > datetime('now', ?1)
          AND (level IN ('Executive','Leadership') OR title LIKE '%Director%'
               OR title LIKE '%VP%' OR title LIKE '%Head of%' OR title LIKE '%Chief%')
        ORDER BY closed_at DESC LIMIT 15`).bind(since).all(),

    env.DB.prepare(
      `SELECT company, hub, title, level, location, first_seen
         FROM job_history
        WHERE first_seen > datetime('now', ?1)
          AND (level IN ('Executive','Leadership') OR title LIKE '%Director%'
               OR title LIKE '%VP%' OR title LIKE '%Head of%' OR title LIKE '%Chief%')
        ORDER BY first_seen DESC LIMIT 15`).bind(since).all(),

    env.DB.prepare(
      `SELECT ran_at, total_roles, sources_failed, ok
         FROM scrape_runs ORDER BY ran_at DESC LIMIT 2`).all(),
  ]);

  const rows = net.results || [];
  const growing = rows.filter(r => r.opened - r.closed > 0).slice(0, 6);
  const shrinking = rows.filter(r => r.opened - r.closed < 0).slice(0, 6);

  // If the last run lost a large share of the board or had sources fail, the
  // closures below are probably a scraper problem rather than a hiring story.
  const [last, prior] = health.results || [];
  const drop = last && prior && prior.total_roles
    ? last.total_roles / prior.total_roles : 1;
  const reliable = !!last && last.ok !== 0 && drop >= 0.75;

  const lines = [`SFR + proptech hiring, past ${days} days`, ''];
  lines.push(`${opened?.n || 0} roles opened · ${closed?.n || 0} closed.`);

  if (growing.length) {
    lines.push('', 'Adding roles:');
    growing.forEach(r => lines.push(`  ${r.company}  +${r.opened - r.closed}  (${r.open_now} open)`));
  }
  if (shrinking.length) {
    lines.push('', 'Winding down:');
    shrinking.forEach(r => lines.push(`  ${r.company}  ${r.opened - r.closed}  (${r.open_now} open)`));
  }
  if ((seniorIn.results || []).length) {
    lines.push('', 'Senior roles opened:');
    seniorIn.results.forEach(r => lines.push(`  ${r.title} — ${r.company}${r.location ? ' · ' + r.location : ''}`));
  }
  if ((seniorOut.results || []).length) {
    lines.push('', 'Senior roles closed:');
    seniorOut.results.forEach(r => lines.push(`  ${r.title} — ${r.company} (open ${r.days_open} days)`));
  }
  if (!reliable) {
    lines.push('', `[CHECK BEFORE PUBLISHING] The last scrape `
      + (last?.sources_failed ? `had ${last.sources_failed} source(s) fail` : 'looks incomplete')
      + ` and the board is at ${Math.round(drop * 100)}% of the previous run.`
      + ` Closures in this brief may be missing listings rather than filled roles.`);
  }

  return ok({
    data: {
      window_days: days, reliable, drop,
      totals: { opened: opened?.n || 0, closed: closed?.n || 0 },
      growing, shrinking,
      senior_opened: seniorIn.results || [],
      senior_closed: seniorOut.results || [],
    },
    text: lines.join('\n'),
  });
}
