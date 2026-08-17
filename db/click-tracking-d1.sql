-- Founders & Friends — click tracking (Cloudflare D1)
-- ---------------------------------------------------------------------------
-- Self-hosted. No Supabase, no analytics vendor, no third party seeing your
-- visitors. The Worker writes here; only you can read it.
--
-- HOW TO RUN — Cloudflare dashboard:
--   Storage & Databases → D1 → your database → Console → paste → Run
-- Safe to run more than once.
-- ---------------------------------------------------------------------------

create table if not exists job_clicks (
  id          integer primary key autoincrement,
  job_id      text,      -- the listing id, e.g. "greenhouse:appfolio:12345"
  job_title   text,
  company     text,
  hub         text,      -- 'opco' or 'proptech'
  category    text,      -- role family, e.g. 'Maintenance'
  url         text,      -- where the visitor was sent
  source      text,      -- 'greenhouse' | 'lever' | 'workday' | 'dom'
  kind        text,      -- 'apply' | 'source' | 'link'
  country     text,      -- from Cloudflare, country only — never an address
  referer     text,
  clicked_at  text not null default (datetime('now'))
);

create index if not exists job_clicks_time_idx    on job_clicks (clicked_at desc);
create index if not exists job_clicks_company_idx on job_clicks (company);
create index if not exists job_clicks_hub_idx     on job_clicks (hub);
create index if not exists job_clicks_job_idx     on job_clicks (job_id);

-- ---------------------------------------------------------------------------
-- Nothing here identifies a person: no cookie, no IP, no device fingerprint.
-- Country comes from Cloudflare's edge and is as specific as it gets.
--
-- Queries you can run in the same console:
--
--   -- most clicked companies
--   select company, hub, count(*) clicks from job_clicks
--    group by company, hub order by clicks desc limit 20;
--
--   -- most clicked roles
--   select job_title, company, count(*) clicks from job_clicks
--    group by job_title, company order by clicks desc limit 20;
--
--   -- which role families get attention
--   select category, count(*) clicks from job_clicks
--    group by category order by clicks desc;
--
--   -- last 14 days, by day
--   select date(clicked_at) day, count(*) clicks from job_clicks
--    where clicked_at > datetime('now','-14 days')
--    group by day order by day;
-- ---------------------------------------------------------------------------
