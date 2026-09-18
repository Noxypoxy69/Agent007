-- CLOSING THE LOOP: a task can now be RETURNED and ACCEPTED, not only assigned.
-- Applied to ornbhvaijcpsbcgquzhd as version 20260915133357.
--
-- assign_task shipped alone, so the hosted plane could hand work out and had no
-- way to take it back. The columns below are the evidence each step leaves.
--
-- WHO WRITES WHAT, AND WHY THEY ARE DIFFERENT PARTIES:
--
--   assigned_*   the coordinator: "do this"
--   returned_*   THE WORKER: "I did this, here is the commit"
--   accepted_*   the coordinator: "I looked, it counts"
--
-- The middle set is the worker's own testimony about its own work. A
-- coordinator that could write returned_* would be authoring the evidence it
-- then signs off -- one party on both sides of a review -- which is exactly
-- what a `returned` state exists to prevent. That was the tempting shortcut:
-- three coordinator tools closes the loop on screen and proves nothing.
--
-- accepted_head_sha is pinned FROM returned_head_sha at accept time rather than
-- re-read, because the reviewer accepted a specific commit and the branch may
-- have moved between the review and the click.

alter table agentbridge.tasks add column if not exists returned_by        text;
alter table agentbridge.tasks add column if not exists returned_at        timestamptz;
alter table agentbridge.tasks add column if not exists returned_head_sha  text;
alter table agentbridge.tasks add column if not exists returned_notes     text;
alter table agentbridge.tasks add column if not exists accepted_by        text;
alter table agentbridge.tasks add column if not exists accepted_at        timestamptz;
alter table agentbridge.tasks add column if not exists accepted_head_sha  text;
alter table agentbridge.tasks add column if not exists cancelled_by       text;
alter table agentbridge.tasks add column if not exists cancelled_at       timestamptz;
alter table agentbridge.tasks add column if not exists cancelled_reason   text;

-- A sha is a sha or it is absent. Enforced here as well as in the guard,
-- because the guard runs in one process and this runs for every writer.
alter table agentbridge.tasks drop constraint if exists returned_head_sha_is_a_sha;
alter table agentbridge.tasks add  constraint returned_head_sha_is_a_sha
  check (returned_head_sha is null or returned_head_sha ~ '^[0-9a-f]{40}$');
alter table agentbridge.tasks drop constraint if exists accepted_head_sha_is_a_sha;
alter table agentbridge.tasks add  constraint accepted_head_sha_is_a_sha
  check (accepted_head_sha is null or accepted_head_sha ~ '^[0-9a-f]{40}$');

-- A returned task carries the evidence of its return, or it is not returned.
alter table agentbridge.tasks drop constraint if exists returned_carries_evidence;
alter table agentbridge.tasks add  constraint returned_carries_evidence
  check (state <> 'returned' or (returned_by is not null and returned_head_sha is not null));

-- An accepted task names who accepted it and what they accepted.
alter table agentbridge.tasks drop constraint if exists accepted_names_a_commit;
alter table agentbridge.tasks add  constraint accepted_names_a_commit
  check (state <> 'accepted' or (accepted_by is not null and accepted_head_sha is not null));

-- THE VIEW DOES NOT GROW A COLUMN WHEN ITS TABLE DOES.
--
-- public.tasks was created as `select *`, which Postgres expanded once at
-- creation. The identical oversight on session_registrations took the whole
-- registration path down earlier today with PGRST204 -- so the view is replaced
-- here, in the same migration that adds the columns, with an explicit list so
-- the next person to add one has to come here and decide.
--
-- The column list below was READ BACK from information_schema rather than
-- recalled: a first attempt named `revision` and `blocked_reason`, which exist
-- only in an unapplied draft, and the migration failed on them. Assuming a
-- schema is how a view ends up describing a table nobody has.
create or replace view public.tasks with (security_invoker = true) as
select task_id, title, state, lane_id, repo_id, base_sha,
       allowed_paths, forbidden_paths, shared_paths, depends_on,
       assigned_agent, assigned_session, assigned_at, assigned_by,
       created_at, updated_at,
       returned_by, returned_at, returned_head_sha, returned_notes,
       accepted_by, accepted_at, accepted_head_sha,
       cancelled_by, cancelled_at, cancelled_reason
  from agentbridge.tasks;

revoke all on public.tasks from anon, authenticated;
grant select, insert, update on public.tasks to service_role;

notify pgrst, 'reload schema';
