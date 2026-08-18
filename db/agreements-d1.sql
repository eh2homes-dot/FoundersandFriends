create table if not exists fee_agreements (
  company        text primary key,
  contact_name   text,
  contact_email  text,
  fee_percent    real,
  fee_basis      text default 'first-year base salary',
  guarantee_days integer default 90,
  signed_on      text,
  agreement_ref  text,
  claim_window_months integer default 12,
  notes          text,
  active         integer not null default 1,
  created_at     text not null default (datetime('now'))
);

create table if not exists introductions (
  id             integer primary key autoincrement,
  application_ref text not null,
  candidate_name text not null,
  candidate_email text,
  company        text not null,
  job_title      text,
  sent_to        text not null,
  mode           text not null,
  fee_percent    real,
  claim_expires  text,
  agreement_ref  text,
  sent_at        text not null default (datetime('now'))
);

create index if not exists introductions_company_idx on introductions (company);
create index if not exists introductions_ref_idx     on introductions (application_ref);
create index if not exists introductions_sent_idx    on introductions (sent_at desc);
