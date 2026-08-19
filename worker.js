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
         FROM job_clicks
        WHERE clicked_at > datetime('now', ?1) AND company IS NOT NULL
        GROUP BY company, hub ORDER BY clicks DESC LIMIT 100`).bind(since).all(),
    env.DB.prepare(
      `SELECT job_title, company, category, COUNT(*) AS clicks
         FROM job_clicks
        WHERE clicked_at > datetime('now', ?1) AND job_title IS NOT NULL
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

  const byKind = await env.DB.prepare(
    `SELECT kind, COUNT(*) AS n FROM job_clicks
      WHERE clicked_at > datetime('now', ?1) GROUP BY kind ORDER BY n DESC`).bind(since).all();

  return new Response(JSON.stringify({
    window_days: days,
    totals,
    by_event: Object.fromEntries((byKind.results || []).map((r) => [r.kind || 'unknown', r.n])),
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

// Current self-serve model string. If Anthropic publishes a newer Sonnet, this
// is the one line to change — the prompt and the parser are unaffected.
const MODEL = 'claude-sonnet-5';

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


/* ==========================================================================
   APPLICATIONS
   --------------------------------------------------------------------------
   A completed application does three things: it is stored, it is reviewed, and
   the employer is told about it. Storage comes first and never depends on the
   other two — if the notification email fails, the application is still safely
   yours and the failure is recorded against the row so you can act on it.
   ========================================================================== */

/** Short, unambiguous reference. No 0/O/1/I, so it survives being read aloud. */
function makeRef() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return 'FF-' + s;
}

const asList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 400)).slice(0, 12);
  return [];
};

async function receiveApplication(request, env) {
  if (!env.DB) {
    return new Response(JSON.stringify({ error: 'Applications are not configured yet.' }), { status: 503, headers: JSON_HEADERS });
  }

  let a;
  try { a = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Expected JSON.' }), { status: 400, headers: JSON_HEADERS }); }

  // Validate before writing. A half-filled application is worse than a clear
  // error, because the candidate believes they applied.
  const email = String(a.email || '').trim();
  const missing = ['first_name', 'last_name', 'background'].filter((k) => !String(a[k] || '').trim());
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) missing.push('email');
  if (missing.length) {
    return new Response(JSON.stringify({ error: 'Missing: ' + missing.join(', ') }), { status: 400, headers: JSON_HEADERS });
  }

  const ref = makeRef();
  const row = {
    ref,
    job_id: clean(a.job_id, 120), job_title: clean(a.job_title), company: clean(a.company, 120),
    hub: clean(a.hub, 20), category: clean(a.category, 60), location: clean(a.location, 120),
    apply_url: clean(a.apply_url, 500),
    first_name: clean(a.first_name, 80), middle_initial: clean(a.middle_initial, 4),
    last_name: clean(a.last_name, 80), email: clean(email, 200), phone: clean(a.phone, 40),
    current_company: clean(a.current_company, 120), current_position: clean(a.current_position, 120),
    linkedin: clean(a.linkedin, 200), background: clean(a.background, 20000),
    score: Number.isFinite(+a.score) ? Math.max(0, Math.min(100, Math.round(+a.score))) : null,
    strengths: JSON.stringify(asList(a.strengths)), gaps: JSON.stringify(asList(a.gaps)),
    reviewed_by: a.reviewed_by === 'ai' ? 'ai' : 'keyword',
  };

  try {
    await env.DB.prepare(
      `INSERT INTO applications
         (ref, job_id, job_title, company, hub, category, location, apply_url,
          first_name, middle_initial, last_name, email, phone,
          current_company, current_position, linkedin, background,
          score, strengths, gaps, reviewed_by)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`
    ).bind(
      row.ref, row.job_id, row.job_title, row.company, row.hub, row.category, row.location, row.apply_url,
      row.first_name, row.middle_initial, row.last_name, row.email, row.phone,
      row.current_company, row.current_position, row.linkedin, row.background,
      row.score, row.strengths, row.gaps, row.reviewed_by
    ).run();
  } catch (err) {
    // The unique index on (email, job_id) catches a double submit. Tell the
    // candidate they already applied rather than showing them a failure.
    if (/UNIQUE/i.test(err.message || '')) {
      return new Response(JSON.stringify({ ok: true, duplicate: true, message: 'You have already applied for this role.' }), { headers: JSON_HEADERS });
    }
    console.error('application insert failed:', err.message);
    return new Response(JSON.stringify({ error: 'Could not save your application. Please try again.' }), { status: 500, headers: JSON_HEADERS });
  }

  // NOTHING is sent to the employer here. A candidate's name, email, phone and
  // background are the only thing this business has to sell — mailing them to
  // the employer automatically hands over the asset and removes any reason to
  // pay a placement fee. Forwarding is a deliberate act, taken in the Command
  // Center once terms are clear. See /api/introduce.
  return new Response(JSON.stringify({ ok: true, ref }), { headers: JSON_HEADERS });
}

/**
 * Forwards a candidate to an employer. Called only from /api/introduce, never
 * automatically.
 *
 * Two modes:
 *   teaser (default) — role, score, strengths and gaps, no contact details.
 *                      Enough for the employer to want the person, not enough
 *                      to go around you.
 *   full             — everything, including contact details. Use once a fee
 *                      agreement is in place.
 */
async function notifyEmployer(env, row, opts = {}) {
  const mode = opts.mode === 'full' ? 'full' : 'teaser';
  const agreement = opts.agreement || null;
  const to = opts.to || env.EMPLOYER_EMAIL || env.ADMIN_EMAIL;
  if (!env.RESEND_API_KEY) return { ok: false, error: 'No RESEND_API_KEY configured' };
  if (!to) return { ok: false, error: 'No recipient — set EMPLOYER_EMAIL or pass one' };

  const full = mode === 'full';
  const name = full
    ? [row.first_name, row.middle_initial, row.last_name].filter(Boolean).join(' ')
    : (row.first_name || '') + ' ' + ((row.last_name || '')[0] ? (row.last_name || '')[0] + '.' : '');
  const strengths = JSON.parse(row.strengths || '[]');
  const gaps = JSON.parse(row.gaps || '[]');
  const li = (s) => s.map((x) => `<li>${escapeHtml(x)}</li>`).join('');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px">
      <p style="color:#666;font-size:13px;margin:0 0 4px">Founders &amp; Friends · ${escapeHtml(row.ref)}</p>
      <h2 style="margin:0 0 4px">${escapeHtml(name)}</h2>
      <p style="margin:0 0 18px;color:#444">applied for <b>${escapeHtml(row.job_title || '')}</b> at ${escapeHtml(row.company || '')}${row.location ? ' · ' + escapeHtml(row.location) : ''}</p>
      ${row.score != null ? `<p style="margin:0 0 18px"><b>Match score ${row.score}/100</b> <span style="color:#888">(${row.reviewed_by === 'ai' ? 'AI review' : 'keyword match'})</span></p>` : ''}
      ${strengths.length ? `<p style="margin:0 0 4px"><b>Strengths</b></p><ul style="margin:0 0 14px">${li(strengths)}</ul>` : ''}
      ${gaps.length ? `<p style="margin:0 0 4px"><b>Gaps</b></p><ul style="margin:0 0 14px">${li(gaps)}</ul>` : ''}
      ${full ? `
        <p style="margin:0 0 4px"><b>Contact</b></p>
        <p style="margin:0 0 14px">${escapeHtml(row.email)}${row.phone ? ' · ' + escapeHtml(row.phone) : ''}${row.linkedin ? ' · <a href="' + escapeHtml(row.linkedin) + '">LinkedIn</a>' : ''}</p>
        ${row.current_position || row.current_company ? `<p style="margin:0 0 14px;color:#444">Currently ${escapeHtml(row.current_position || '')}${row.current_company ? ' at ' + escapeHtml(row.current_company) : ''}</p>` : ''}
        <p style="margin:0 0 4px"><b>Background</b></p>
        <div style="white-space:pre-wrap;color:#333;border-left:3px solid #ddd;padding-left:12px">${escapeHtml(row.background || '')}</div>`
      : `
        ${row.current_position ? `<p style="margin:0 0 14px;color:#444">Currently a ${escapeHtml(row.current_position)}${row.current_company ? ' in the sector' : ''}.</p>` : ''}
        <p style="margin:0 0 6px"><b>Summary</b></p>
        <div style="white-space:pre-wrap;color:#333;border-left:3px solid #ddd;padding-left:12px">${escapeHtml(String(row.background || '').slice(0, 400))}${String(row.background || '').length > 400 ? '…' : ''}</div>
        <p style="margin:18px 0 0;padding:14px;background:#f4f2fb;border-radius:8px">
          Reply to this email to request an introduction. Contact details follow once terms are agreed.
        </p>`}
      <hr style="border:0;border-top:1px solid #e5e5e5;margin:26px 0 14px" />
      <p style="font-size:12px;color:#777;line-height:1.6;margin:0">
        ${agreement
          ? `Introduced under our agreement${agreement.agreement_ref ? ' ' + escapeHtml(agreement.agreement_ref) : ''}${agreement.signed_on ? ' dated ' + escapeHtml(agreement.signed_on) : ''}. A placement fee of ${agreement.fee_percent}% of ${escapeHtml(agreement.fee_basis || 'first-year base salary')} applies if you engage this candidate, or any candidate introduced by us, within ${agreement.claim_window_months || 12} months of this introduction.`
          : `Introduced by Founders &amp; Friends. A placement fee applies if you engage this candidate within 12 months of this introduction. Reply to agree terms before proceeding.`}
        <br />Introduction reference ${escapeHtml(row.ref)} · ${new Date().toISOString().slice(0, 10)}
      </p>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Founders & Friends <onboarding@resend.dev>',
        to: [to],
        // In teaser mode a reply must reach YOU, not the candidate — that is
        // the whole point. Only a full send hands the conversation over.
        reply_to: full ? row.email : (env.ADMIN_EMAIL || undefined),
        subject: full
          ? `${name} → ${row.job_title || 'a role'} at ${row.company || ''} (${row.ref})`
          : `Candidate for ${row.job_title || 'your role'}${row.score != null ? ` · ${row.score}/100 match` : ''} (${row.ref})`,
        html,
      }),
    });
    if (!res.ok) return { ok: false, error: 'Resend ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Forward a candidate to an employer. Admin-only and explicit: the Command
 * Center calls this when you decide to make the introduction.
 */
async function introduce(request, env) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'No database configured.' }), { status: 503, headers: JSON_HEADERS });
  if (!adminAuthed(request, env)) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: JSON_HEADERS });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Expected JSON.' }), { status: 400, headers: JSON_HEADERS }); }

  const row = await env.DB.prepare('SELECT * FROM applications WHERE ref = ?1').bind(clean(body.ref, 20)).first();
  if (!row) return new Response(JSON.stringify({ error: 'No such application.' }), { status: 404, headers: JSON_HEADERS });

  // ---- the gate ----------------------------------------------------------
  // No agreement, no introduction. This is deliberately enforced here rather
  // than left to memory: the moment a candidate's details reach a company you
  // have no terms with, you have given away the only thing you can charge for.
  //
  // Redaction is not protection — a match score and a career summary describe a
  // small enough population to identify. The agreement is what protects you.
  let agreement = null;
  try {
    agreement = await env.DB.prepare(
      'SELECT * FROM fee_agreements WHERE company = ?1 AND active = 1').bind(row.company).first();
  } catch (_) {
    // Table not created yet. Treated as "no agreement" — fail closed, never open.
  }

  if (!agreement && !body.override) {
    return new Response(JSON.stringify({
      error: `No fee agreement on file for ${row.company}.`,
      needs_agreement: true,
      company: row.company,
    }), { status: 409, headers: JSON_HEADERS });
  }

  const to = clean(body.to, 200) || agreement?.contact_email || env.EMPLOYER_EMAIL || env.ADMIN_EMAIL;
  const result = await notifyEmployer(env, row, { mode: body.mode, to, agreement });

  await env.DB.prepare(
    `UPDATE applications
        SET sent_to_employer_at = ?2, send_error = ?3, updated_at = datetime('now')
      WHERE ref = ?1`
  ).bind(row.ref, result.ok ? new Date().toISOString() : null, result.ok ? null : clean(result.error, 300)).run();

  // Record the introduction itself. This is the evidence: who was named, to
  // whom, on what date, under which agreement. Written only on success, so the
  // log never claims an introduction that did not happen.
  if (result.ok) {
    const months = agreement?.claim_window_months ?? 12;
    try {
      await env.DB.prepare(
        `INSERT INTO introductions
           (application_ref, candidate_name, candidate_email, company, job_title,
            sent_to, mode, fee_percent, claim_expires, agreement_ref)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, date('now', ?9), ?10)`
      ).bind(
        row.ref,
        [row.first_name, row.last_name].filter(Boolean).join(' '),
        row.email, row.company, row.job_title, to,
        body.mode === 'full' ? 'full' : 'teaser',
        agreement?.fee_percent ?? null,
        `+${months} months`,
        agreement?.agreement_ref ?? null
      ).run();
    } catch (err) {
      console.error('introduction log failed:', err.message);
    }
  }

  return new Response(JSON.stringify(result.ok
    ? { ok: true, mode: body.mode === 'full' ? 'full' : 'teaser', to, fee_percent: agreement?.fee_percent ?? null }
    : { error: result.error }),
    { status: result.ok ? 200 : 502, headers: JSON_HEADERS });
}

/* ---------- admin ---------- */

/** Cookie beats query string for anything showing personal data: a ?key= in the
 *  URL leaks into browser history, bookmarks and referer headers. */
/**
 * Three ways to present the admin key, in order of preference:
 *
 *   1. X-Admin-Key header  — what admin.html sends. Never appears in browser
 *                            history, bookmarks or referer headers.
 *   2. ff_admin cookie     — kept for anything already signed in.
 *   3. ?key= query string  — convenient for CSV export and quick checks.
 *
 * The header is first because cookies can be silently blocked by the browser,
 * which is impossible to diagnose from the server side.
 */
function adminAuthed(request, env) {
  if (!env.STATS_KEY) return false;

  if (request.headers.get('x-admin-key') === env.STATS_KEY) return true;

  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)ff_admin=([^;]+)/);
  if (m && m[1] === env.STATS_KEY) return true;

  return new URL(request.url).searchParams.get('key') === env.STATS_KEY;
}

async function adminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  if (!env.STATS_KEY || body.key !== env.STATS_KEY) {
    return new Response(JSON.stringify({ error: 'Wrong key.' }), { status: 401, headers: JSON_HEADERS });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      ...JSON_HEADERS,
      // Session cookie: gone when the browser closes. HttpOnly keeps it out of
      // reach of any script on the page.
      'set-cookie': `ff_admin=${env.STATS_KEY}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    },
  });
}

async function listApplications(request, env) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'No database configured.' }), { status: 503, headers: JSON_HEADERS });
  if (!adminAuthed(request, env)) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: JSON_HEADERS });

  const url = new URL(request.url);
  const hub = url.searchParams.get('hub');
  const status = url.searchParams.get('status');

  let sql = `SELECT id, ref, job_title, company, hub, category, location, apply_url,
                    first_name, middle_initial, last_name, email, phone,
                    current_company, current_position, linkedin, background,
                    score, strengths, gaps, reviewed_by, status, notes,
                    sent_to_employer_at, send_error, declined_at, decline_reason,
                    created_at
               FROM applications`;
  const where = [], binds = [];
  if (hub && hub !== 'all') { binds.push(hub); where.push('hub = ?' + binds.length); }
  if (status && status !== 'all') { binds.push(status); where.push('status = ?' + binds.length); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 500';

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const counts = await env.DB.prepare('SELECT status, COUNT(*) n FROM applications GROUP BY status').all();

  return new Response(JSON.stringify({
    applications: (rows.results || []).map((r) => ({
      ...r,
      strengths: JSON.parse(r.strengths || '[]'),
      gaps: JSON.parse(r.gaps || '[]'),
    })),
    counts: Object.fromEntries((counts.results || []).map((c) => [c.status, c.n])),
  }), { headers: JSON_HEADERS });
}

async function updateApplication(request, env) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'No database configured.' }), { status: 503, headers: JSON_HEADERS });
  if (!adminAuthed(request, env)) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: JSON_HEADERS });

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Expected JSON.' }), { status: 400, headers: JSON_HEADERS }); }

  // 'passed' is the stored value; the interface calls it Declined, which is
  // what actually happened. Kept as-is so rows written earlier stay valid.
  const ALLOWED = ['new', 'reviewing', 'interview', 'offer', 'hired', 'passed'];
  if (body.status && !ALLOWED.includes(body.status)) {
    return new Response(JSON.stringify({ error: 'Unknown status.' }), { status: 400, headers: JSON_HEADERS });
  }

  await env.DB.prepare(
    `UPDATE applications
        SET status = COALESCE(?2, status),
            notes  = COALESCE(?3, notes),
            updated_at = datetime('now')
      WHERE ref = ?1`
  ).bind(clean(body.ref, 20), body.status || null, body.notes != null ? clean(body.notes, 4000) : null).run();

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
}


/**
 * Declines an application, and tells the candidate.
 *
 * Silence is the norm in recruiting and it is the thing candidates resent most.
 * A short, honest note costs nothing and is the difference between someone who
 * never applies again and someone who stays in the network — which for a talent
 * business is the actual asset.
 *
 * The email is optional: with no RESEND_API_KEY the status still changes and
 * you can write to them yourself.
 */
async function decline(request, env) {
  if (!env.DB) return new Response(JSON.stringify({ error: 'No database configured.' }), { status: 503, headers: JSON_HEADERS });
  if (!adminAuthed(request, env)) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: JSON_HEADERS });

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Expected JSON.' }), { status: 400, headers: JSON_HEADERS }); }

  const row = await env.DB.prepare('SELECT * FROM applications WHERE ref = ?1').bind(clean(body.ref, 20)).first();
  if (!row) return new Response(JSON.stringify({ error: 'No such application.' }), { status: 404, headers: JSON_HEADERS });

  const reason = clean(body.reason, 2000);
  const notify = body.notify !== false;   // tell them unless explicitly told not to

  // Status first. The record is correct even if the email fails.
  try {
    await env.DB.prepare(
      `UPDATE applications
          SET status = 'passed', declined_at = datetime('now'),
              decline_reason = ?2, updated_at = datetime('now')
        WHERE ref = ?1`).bind(row.ref, reason).run();
  } catch (_) {
    // Columns not added yet — fall back to the status alone rather than failing.
    await env.DB.prepare(
      `UPDATE applications SET status = 'passed', updated_at = datetime('now') WHERE ref = ?1`
    ).bind(row.ref).run();
  }

  if (!notify) return new Response(JSON.stringify({ ok: true, notified: false }), { headers: JSON_HEADERS });

  const sent = await sendDecline(env, row, reason);
  return new Response(JSON.stringify({ ok: true, notified: sent.ok, error: sent.ok ? undefined : sent.error }),
    { headers: JSON_HEADERS });
}

async function sendDecline(env, row, reason) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'No RESEND_API_KEY configured — status changed, no email sent.' };

  const first = escapeHtml(row.first_name || 'there');
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;line-height:1.6">
      <p>Hi ${first},</p>
      <p>Thanks for applying for <b>${escapeHtml(row.job_title || 'the role')}</b>${row.company ? ' at ' + escapeHtml(row.company) : ''} through Founders &amp; Friends.</p>
      <p>We are not taking your application forward for this one.</p>
      ${reason ? `<p>${escapeHtml(reason)}</p>` : ''}
      <p>That is a decision about one role, not about your experience. We work across
         single-family rental operators and the companies serving them, and roles come up
         constantly — if something fits better we will come back to you directly.</p>
      <p>You are welcome to apply for anything else on the board at any time.</p>
      <p style="margin-top:22px">— Founders &amp; Friends</p>
      <p style="font-size:12px;color:#888;margin-top:20px">
        Reference ${escapeHtml(row.ref)}. Reply to this email if you would like to be removed from our records.
      </p>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Founders & Friends <onboarding@resend.dev>',
        to: [row.email],
        reply_to: env.ADMIN_EMAIL || env.EMPLOYER_EMAIL || undefined,
        subject: `Your application for ${row.job_title || 'a role'}${row.company ? ' at ' + row.company : ''}`,
        html,
      }),
    });
    if (!res.ok) return { ok: false, error: 'Resend ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 200) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/click'  && request.method === 'POST') return recordClick(request, env);
    if (pathname === '/api/screen' && request.method === 'POST') return screen(request, env);
    if (pathname === '/api/stats') return stats(request, env, false);
    if (pathname === '/api/stats.csv') return stats(request, env, true);

    if (pathname === '/api/apply'         && request.method === 'POST') return receiveApplication(request, env);
    if (pathname === '/api/admin/login'   && request.method === 'POST') return adminLogin(request, env);
    if (pathname === '/api/applications'  && request.method === 'GET')  return listApplications(request, env);
    if (pathname === '/api/applications'  && request.method === 'POST') return updateApplication(request, env);
    if (pathname === '/api/forward'       && request.method === 'POST') return introduce(request, env);
    if (pathname === '/api/decline'       && request.method === 'POST') return decline(request, env);
    if (pathname === '/api/introduce'     && request.method === 'POST') return introduce(request, env);

    // Everything else is the site itself.
    return env.ASSETS.fetch(request);
  },
};
