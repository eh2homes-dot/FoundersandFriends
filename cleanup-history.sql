-- Founders & Friends — remove junk already recorded in job_history
-- ---------------------------------------------------------------------------
-- The scraper's filters were tightened after this table started collecting, so
-- rows written by the older, looser rules are still in here. They distort every
-- number the Signals view produces: a "Job Search" link counted as a role that
-- opened and closed makes time-to-fill and hiring velocity meaningless.
--
-- RUN THE SELECT FIRST. Look at what it returns before deleting anything.
--
-- HOW TO RUN — Cloudflare dashboard:
--   Storage & Databases → D1 → founders-clicks → Console
-- ---------------------------------------------------------------------------

-- STEP 1 — see what would go. Run this on its own and read the list.
select company, title, first_seen, closed_at
  from job_history
 where lower(trim(title)) in (
         'job search','search jobs','jobs','careers','career','apply','apply now',
         'view all jobs','see all jobs','all jobs','open opportunities','current openings',
         'open roles','available positions','general application','talent community',
         'talent network','talent pool','future openings','open application',
         'engineering','sales','marketing','product','design','operations','finance',
         'legal','people','hr','human resources','support','data','security','it',
         'technology','corporate','general','other','full-time','part-time','remote',
         'contract','internship','benefits','culture','home','contact','contact us')
    or title like 'Don''t see%'
    or title like 'Didn''t see%'
    or title like '%talent network%'
    or title like '%talent community%'
    or title like 'Join our talent%'
    or length(title) > 110
 order by company, title;

-- STEP 2 — only after reading the above, delete them.
-- delete from job_history
--  where lower(trim(title)) in (
--          'job search','search jobs','jobs','careers','career','apply','apply now',
--          'view all jobs','see all jobs','all jobs','open opportunities','current openings',
--          'open roles','available positions','general application','talent community',
--          'talent network','talent pool','future openings','open application',
--          'engineering','sales','marketing','product','design','operations','finance',
--          'legal','people','hr','human resources','support','data','security','it',
--          'technology','corporate','general','other','full-time','part-time','remote',
--          'contract','internship','benefits','culture','home','contact','contact us')
--     or title like 'Don''t see%'
--     or title like 'Didn''t see%'
--     or title like '%talent network%'
--     or title like '%talent community%'
--     or title like 'Join our talent%'
--     or length(title) > 110;

-- ---------------------------------------------------------------------------
-- Useful checks afterwards:
--
--   -- what is left, by company
--   select company, count(*) from job_history group by company order by 2 desc;
--
--   -- anything still looking like a nav label
--   select distinct title from job_history
--    where title not like '% %' order by title;
--
-- Do NOT delete from `applications` or `introductions`. Those are the record of
-- who applied and who you introduced, and they are evidence behind any fee.
-- ---------------------------------------------------------------------------
