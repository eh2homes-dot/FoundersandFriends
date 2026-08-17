/**
 * worker.js — the site, plus its own click tracking.
 * ---------------------------------------------------------------------------
 * Everything runs on Cloudflare. No Supabase, no analytics vendor, no third
 * party seeing your visitors. Clicks go into a D1 database you own.
 *
 * Routes
 *   POST /api/click            record a click            (public, rate limited)
 *   GET  /api/stats?key=SECRET read the numbers          (protected)
 *   GET  /api/stats.csv?key=…  same, as a spreadsheet    (protected)
 *   anything else              the static site
 *
 * If the D1 binding is missing the site still serves normally and clicks are
 * quietly dropped — a tracking outage must never take the board down.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/* A click is a small, fixed shape. Anything longer is truncated rather than
   rejected, so a long job title never costs you the row. */
function clean(value, max = 200) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, max);
}

async function recordClick(request, env) {
  if (!env.DB) return new Response(null, { status: 204 });   // tracking off

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'expected JSON' }), { status: 400, headers: JSON_HEADERS });
  }

  // Cloudflare gives us country and a ray id for free — no cookies, no
  // fingerprinting, nothing that identifies a person.
  const cf = request.cf || {};

  try {
    await env.DB.prepare(
      `INSERT INTO job_clicks
         (job_id, job_title, company, hub, category, url, source, kind, country, referer, clicked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))`
    ).bind(
      clean(body.job_id, 120),
      clean(body.job_title),
      clean(body.company, 120),
      clean(body.hub, 20),
      clean(body.category, 60),
      clean(body.url, 500),
      clean(body.source, 40),
      clean(body.kind, 20),
      clean(cf.country, 4),
      clean(request.headers.get('referer'), 200)
    ).run();
  } catch (err) {
    // A failed insert is logged for you and invisible to the visitor.
    console.error('click insert failed:', err.message);
  }

  // 204 with no body: the browser has nothing to wait for.
  return new Response(null, { status: 204 });
}

async function stats(request, env, asCsv) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'No D1 binding. See db/click-tracking-d1.sql.' }), { status: 503, headers: JSON_HEADERS });
  }

  // The stats endpoint is the only thing worth protecting here: clicks are
  // write-only to the public, and this is the read side.
  const key = new URL(request.url).searchParams.get('key');
  if (!env.STATS_KEY || key !== env.STATS_KEY) {
    return new Response(JSON.stringify({ error: 'Add ?key= with your STATS_KEY.' }), { status: 401, headers: JSON_HEADERS });
  }

  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 30));
  const since = `-${days} days`;

  const [byCompany, byRole, byDay, totals] = await Promise.all([
    env.DB.prepare(
      `SELECT company, hub, COUNT(*) AS clicks
         FROM job_clicks WHERE clicked_at > datetime('now', ?1)
        GROUP BY company, hub ORDER BY clicks DESC LIMIT 100`).bind(since).all(),
    env.DB.prepare(
      `SELECT job_title, company, category, COUNT(*) AS clicks
         FROM job_clicks WHERE clicked_at > datetime('now', ?1)
        GROUP BY job_title, company, category ORDER BY clicks DESC LIMIT 100`).bind(since).all(),
    env.DB.prepare(
      `SELECT date(clicked_at) AS day, COUNT(*) AS clicks
         FROM job_clicks WHERE clicked_at > datetime('now', ?1)
        GROUP BY day ORDER BY day`).bind(since).all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS clicks,
              COUNT(DISTINCT company) AS companies,
              COUNT(DISTINCT job_id)  AS roles
         FROM job_clicks WHERE clicked_at > datetime('now', ?1)`).bind(since).first(),
  ]);

  if (asCsv) {
    const rows = [['company', 'hub', 'clicks'],
      ...(byCompany.results || []).map((r) => [r.company, r.hub, r.clicks])];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="clicks-${days}d.csv"`,
      },
    });
  }

  return new Response(JSON.stringify({
    window_days: days,
    totals,
    by_company: byCompany.results || [],
    by_role: byRole.results || [],
    by_day: byDay.results || [],
  }, null, 2), { headers: JSON_HEADERS });
}


/* ==========================================================================
   AI SCREENING
   --------------------------------------------------------------------------
   Reads a candidate's background against the role and returns strengths, gaps
   and a score. Ported from the earlier project, with the same key rule: the
   Anthropic key lives on the server and never reaches the browser.

   Without ANTHROPIC_API_KEY set, this returns 503 and the page falls back to
   its own keyword analysis — so the wizard works either way.
   ========================================================================== */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

function buildPrompt({ hub, jobTitle, company, resume, linkedin }) {
  const role = hub === 'proptech'
    ? 'a proptech recruiter who places people at the technology companies serving property operators'
    : 'a senior single-family rental recruiter';
  const li = linkedin ? `LinkedIn: ${linkedin}\n` : '';

  return `You are ${role}. Assess this candidate for "${jobTitle}" at ${company}.

Be specific and useful to the candidate. Name real gaps rather than flattering
them, and where the background is strong, say what makes it strong. Judge on
transferable substance, not keyword overlap — someone from multifamily moving
into single-family may be an excellent fit.

Respond in EXACTLY this format and nothing else:

STRENGTHS:
- ...
- ...
GAPS:
- ...
- ...
MATCH SCORE: XX/100

${li}Background:
${resume}`;
}

async function screen(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'AI screening is not configured.' }), { status: 503, headers: JSON_HEADERS });
  }

  let input;
  try { input = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Expected JSON.' }), { status: 400, headers: JSON_HEADERS }); }

  const resume = String(input.resume || '').trim();
  if (resume.length < 40) {
    return new Response(JSON.stringify({ error: 'Add a little more about your background.' }), { status: 400, headers: JSON_HEADERS });
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: buildPrompt({
          hub: input.hub,
          jobTitle: String(input.jobTitle || 'this role').slice(0, 200),
          company: String(input.company || 'the company').slice(0, 120),
          resume: resume.slice(0, 12000),
          linkedin: String(input.linkedin || '').slice(0, 200),
        }),
      }],
    }),
  });

  if (!res.ok) {
    // Log the detail for you; never leak auth or quota specifics to the browser.
    console.error('Anthropic ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 400));
    return new Response(JSON.stringify({ error: 'The review service is unavailable.' }), { status: 502, headers: JSON_HEADERS });
  }

  const data = await res.json();
  const analysis = data?.content?.[0]?.text || '';
  return new Response(JSON.stringify({ analysis }), { headers: JSON_HEADERS });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/click'  && request.method === 'POST') return recordClick(request, env);
    if (pathname === '/api/screen' && request.method === 'POST') return screen(request, env);
    if (pathname === '/api/stats') return stats(request, env, false);
    if (pathname === '/api/stats.csv') return stats(request, env, true);

    // Everything else is the site itself.
    return env.ASSETS.fetch(request);
  },
};
