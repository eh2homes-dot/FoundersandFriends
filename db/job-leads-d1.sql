-- job_leads — who pressed Apply Now, captured before they leave for the
-- employer's posting.
--
-- The Worker creates this table itself on the first lead (see ensureLeadsTable
-- in worker.js), so running this file is optional. It is here so the schema is
-- written down, and for running by hand in the D1 console if you prefer:
--
--   npx wrangler d1 execute founders-clicks --remote --file=db/job-leads-d1.sql

create table if not exists job_leads (
  id              integer primary key autoincrement,
  created_at      text    not null default (datetime('now')),
  first_name      text,
  last_name       text,
  email           text    not null,
  phone           text,
  current_company text,
  linkedin        text,
  job_id          text,
  job_title       text,
  company         text,     -- the hiring company, not the candidate's
  hub             text,
  apply_url       text,
  referrer        text,
  country         text,     -- from Cloudflare, where the request came from
  repeat_count    integer not null default 1   -- same person, same role, pressed again
);

-- One row per person per role. A second press updates the row instead of
-- adding a duplicate, and bumps repeat_count.
create unique index if not exists job_leads_email_job on job_leads (email, job_id);
create index if not exists job_leads_created on job_leads (created_at);
create index if not exists job_leads_company on job_leads (company);
