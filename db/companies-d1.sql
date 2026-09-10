-- Founders & Friends — company registry (Cloudflare D1)
-- ---------------------------------------------------------------------------
-- The list of companies the board scrapes, and the ATS details needed to
-- scrape each one.
--
-- HOW TO RUN — Cloudflare dashboard:
--   Storage & Databases → D1 → founders-clicks → Console → paste → Run
-- Safe to run more than once.
--
-- Run this against founders-clicks, the database the Worker binds as DB.
-- D1 cannot query across databases, so a table created in the wrong one is
-- invisible to the Worker and every read of it fails silently.
-- ---------------------------------------------------------------------------

create table if not exists companies (
  id                text primary key,          -- slug, e.g. "invitation-homes"
  name              text not null,
  hub               text not null,             -- 'opco' (operators) | 'proptech' (vendors)
  careers_url       text not null,
  website           text,
  state             text,
  segment           text,                      -- e.g. 'SFR REIT', 'maintenance software'
  asset_class       text,                      -- scattered-site, multifamily, etc.
  priority          integer not null default 0,

  -- How run.js should scrape this company. NULL means unresolved: the company
  -- is skipped rather than guessed at, because a wrong method returns zero
  -- roles and reads as "not hiring" instead of as a failure.
  method            text,                      -- greenhouse | lever | workday | ashby | workable | breezy | jsonld | reffie | dom
  ats_slug          text,                      -- board token, or Workday host
  ats_site          text,                      -- Workday site path
  list_url          text,
  sitemap           text,                      -- required by the jsonld adapter
  link_override     text,

  -- Detection bookkeeping, so a company that keeps failing is visible rather
  -- than quietly retried forever.
  detect_attempts   integer not null default 0,
  detect_last_at    text,
  detect_last_error text,

  active            integer not null default 1,
  added_by          text,                      -- 'discovery' when it came from the review queue
  created_at        text not null default (datetime('now')),
  updated_at        text not null default (datetime('now'))
);

create index if not exists companies_hub_idx      on companies (hub);
create index if not exists companies_active_idx   on companies (active);
create index if not exists companies_method_idx   on companies (method);
create index if not exists companies_priority_idx on companies (priority desc);

-- ---------------------------------------------------------------------------
-- Useful queries:
--
--   -- coverage: how many companies can actually be scraped
--   select hub,
--          count(*) total,
--          sum(method is not null) scrapeable,
--          sum(method is null) unresolved
--     from companies where active = 1 group by hub;
--
--   -- which adapters carry the list
--   select method, count(*) n from companies
--    where active = 1 and method is not null
--    group by method order by n desc;
--
--   -- companies that keep failing detection
--   select name, detect_attempts, detect_last_error from companies
--    where method is null and detect_attempts > 2
--    order by detect_attempts desc;
-- ---------------------------------------------------------------------------
