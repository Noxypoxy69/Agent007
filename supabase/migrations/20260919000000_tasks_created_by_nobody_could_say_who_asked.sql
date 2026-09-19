-- A task nobody can attribute, in a table nobody could write to.
--
-- TWO GAPS, ONE MIGRATION.
--
-- 1. THERE IS NO WAY TO CREATE A TASK. `assign_task` assigns an EXISTING task
--    and refuses otherwise, the CLI has no create command, and this table is
--    written only by the edge function and by migrations. So the table CLAUDE.md
--    names as the one mechanism that would have caught the sixty-five-minute and
--    the nine-minute duplication holds four rows -- two demo fixtures and one
--    labelled PROOF ONLY -- because nobody could add a fifth. Sixteen real items
--    went out as prose in messages on 2026-09-18 for exactly this reason.
--
-- 2. THERE IS NOWHERE TO RECORD WHO ASKED. Every other ledger in this schema
--    carries its author: owner_decisions has created_by, tasks record
--    assigned_by, returned_by, accepted_by, cancelled_by and reviewed_by. The
--    one field missing is the first one -- who wanted this done. The sixteen
--    rows written on 2026-09-18 are anonymous, and their assigned_by reads
--    "chatgpt-work coordinator", a party whose authority Danny revoked on
--    2026-09-16, because that is the only coordinator label that exists.
--
-- NULLABLE, DELIBERATELY. Four rows predate this column and inventing an author
-- for them would be worse than admitting there isn't one -- the same judgement
-- the null-is-unknown contract makes everywhere else in this system. New rows
-- get it from the authenticated token label, which is the only attribution the
-- server can establish rather than accept.

alter table agentbridge.tasks
  add column if not exists created_by text;

comment on column agentbridge.tasks.created_by is
  'Who asked for this task. Taken from the authenticated token label at creation, '
  'never from the request body -- a caller-supplied author is a claim, not a record. '
  'NULL for rows created before 2026-09-19, when no create path existed and nothing '
  'could record it.';

-- public.tasks IS A VIEW WITH AN EXPLICIT COLUMN LIST, and a view does not grow
-- when its table does. That exact omission caused a PGRST204 outage once already,
-- so the view is recreated here rather than left to be discovered.
--
-- security_invoker = true is preserved. Without it the view runs as owner and
-- bypasses RLS, which is the other way this has gone wrong before.
drop view if exists public.tasks;

create view public.tasks
with (security_invoker = true)
as select
  task_id, title, state, lane_id, repo_id, base_sha,
  allowed_paths, forbidden_paths, shared_paths, depends_on,
  assigned_agent, assigned_session, assigned_at, assigned_by,
  created_at, created_by, updated_at,
  returned_by, returned_at, returned_head_sha, returned_notes,
  accepted_by, accepted_at, accepted_head_sha,
  cancelled_by, cancelled_at, cancelled_reason,
  lease_token, lease_expires_at, attempt,
  reviewer, review_lease_token, review_lease_expires_at,
  review_decision, review_reasons, reviewed_by, reviewed_at,
  fix_of, fix_task_id
from agentbridge.tasks;

-- DROP DISCARDS THE ACL, AND THE DEFAULT PRIVILEGES PUT IT BACK WRONG.
--
-- This is the only tasks-view migration that uses drop+create rather than
-- `create or replace` -- it has to, because created_by is inserted mid-list and
-- replace cannot reorder columns. The cost is that DROP takes the object's
-- grants with it, and `pg_default_acl` for schema public on this project grants
-- ALL to anon and authenticated on every new relation. So without these two
-- lines the view comes back with anon and authenticated holding
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES, silently undoing a
-- revoke that 20260915133357 and 20260916180034 both issued deliberately.
--
-- MEASURED LIVE, READ-ONLY, BY A BLIND AUDIT: public.attempts is a view created
-- without these lines, and it carries exactly that grant today. Not a
-- hypothesis about what the defaults do -- an observation of what they did.
--
-- NOT EXPLOITABLE THE MOMENT IT LANDS, and that is not a reason to omit it:
-- security_invoker = true holds, the agentbridge schema ACL is {postgres=UC,
-- service_role=U}, and agentbridge.tasks has RLS, so anon still hits
-- "permission denied for schema agentbridge". It becomes data exposure the
-- moment anything grants usage on that schema or a later recreate loses
-- security_invoker. Defence in depth is exactly the thing whose erosion is
-- invisible until the layer in front of it fails.
revoke all on public.tasks from anon, authenticated;
grant select, insert, update on public.tasks to service_role;
