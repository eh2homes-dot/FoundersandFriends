-- Founders & Friends — discovery queue (Cloudflare D1)
-- ---------------------------------------------------------------------------
-- Staging for companies proposed by /api/discover, before any of them reach
-- the board. Nothing here is live: a row is a candidate awaiting review in the
-- admin Command Center, and only an approved row is copied into companies.
--
-- HOW TO RUN — Cloudflare dashboard:
--   Storage & Databases → D1 → founders-clicks → Console → paste → Run
-- Safe to run more than once.
--
-- Run this against founders-clicks, the database the Worker binds as DB.
-- ---------------------------------------------------------------------------

create table if not exists discoveries (
  id            text primary key,           -- slug of the proposed name
  name          text not null,
  hub           text,                       -- 'opco' | 'proptech'
  careers_url   text,
  website       text,
  segment       text,
  why           text,                       -- one line on why it fits

  -- Verification happens before the row is written, not after approval. A
  -- proposal whose careers page yields no live roles cannot be approved at
  -- all — the queue exists so nothing unproven reaches the board.
  verified      integer not null default 0,
  method        text,                       -- adapter that worked during verification
  ats_slug      text,
  ats_site      text,
  live_roles    integer,                    -- how many roles verification actually saw
  sample_titles text,                       -- JSON array, for eyeballing relevance
  verify_error  text,                       -- why verification failed, when it did

  status        text not null default 'pending',   -- pending | approved | rejected
  reviewed_at   text,
  found_at      text not null default (datetime('now')),
  source        text                        -- discovery run id, e.g. '2026-09-09T12:04'
);

create index if not exists discoveries_status_idx   on discoveries (status);
create index if not exists discoveries_hub_idx      on discoveries (hub);
create index if not exists discoveries_found_idx    on discoveries (found_at desc);
create index if not exists discoveries_verified_idx on discoveries (verified);

-- ---------------------------------------------------------------------------
-- Useful queries:
--
--   -- what is waiting for review
--   select name, hub, live_roles, why from discoveries
--    where status = 'pending' and verified = 1
--    order by live_roles desc;
--
--   -- proposals that failed verification, and why
--   select name, careers_url, verify_error from discoveries
--    where status = 'pending' and verified = 0;
--
--   -- how well discovery is doing over time
--   select source,
--          count(*) proposed,
--          sum(verified) verified,
--          sum(status = 'approved') approved
--     from discoveries group by source order by source desc;
-- ---------------------------------------------------------------------------
