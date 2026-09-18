-- A VIEW DOES NOT GROW A COLUMN WHEN ITS TABLE DOES.
--
-- Applied to ornbhvaijcpsbcgquzhd as version 20260915124607, in response to a
-- live outage of the registration path.
--
-- public.session_registrations is a `select *` view over the agentbridge table.
-- Postgres expands `*` ONCE, at creation, and stores the resulting column list.
-- Adding registered_by to the table in 20260915122811 therefore changed nothing
-- PostgREST could see, and every worker heartbeat began failing the moment the
-- edge function started sending the new column:
--
--   PGRST204: Could not find the 'registered_by' column of
--             'session_registrations' in the schema cache
--
-- THIS IS NOT A STALE SCHEMA CACHE, and `notify pgrst, 'reload schema'` does
-- not fix it. The cache was describing the view accurately. Reloading it was
-- the first thing tried and changed nothing, which is the tell: when a reload
-- does not help, the object really does lack the column.
--
-- THE SHAPE OF THE MISS. The migration and the edge function were deliberately
-- decoupled so the migration was safe to land alone -- and it was. What was
-- missed is that the pair became coupled through a THIRD object neither of them
-- mentions. The deploy checklist asked whether the migration and the function
-- agreed; it did not ask what else reads the table.
--
-- Found by an end-to-end probe that was checking something else entirely: a
-- takeover attempt expected to return 409 came back 400, and the detail said
-- PGRST204. Nothing else would have caught it. The local suite passes against a
-- mock, the guard trigger is correct in isolation, and both deploys reported
-- success.
--
-- CREATE OR REPLACE VIEW can append a column at the end, which is where
-- registered_by sits, so the view is replaced rather than dropped. Dropping it
-- would take the grants with it.

create or replace view public.session_registrations
  with (security_invoker = true) as
select session_id, agent_id, machine_id, repo_id, worktree_id, lane_id,
       capacity, head_sha, verification_state, heartbeat_at, created_at,
       updated_at, registered_by
  from agentbridge.session_registrations;

-- Columns are named explicitly rather than `select *`, so the next person to
-- add one has to come here and decide. The silent version of that decision is
-- what took the registry down.

revoke all on public.session_registrations from anon, authenticated;
grant select, insert, update, delete on public.session_registrations to service_role;

notify pgrst, 'reload schema';
