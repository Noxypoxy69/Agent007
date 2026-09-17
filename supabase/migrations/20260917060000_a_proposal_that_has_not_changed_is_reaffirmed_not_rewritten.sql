-- A PROPOSAL THAT HAS NOT CHANGED IS REAFFIRMED, NOT REWRITTEN.
--
-- MEASURED ON THIS DATABASE AT 2026-09-17T05:41Z, before anything was written:
--
--   review proposals on t-wire-gate-scripts   185 of a 200-row page
--   one per minute, unbroken                  23:38Z -> 03:20Z
--   prepared after 03:20:37Z                  0
--   open proposals                            0
--
-- The dispatch tick superseded the entire open set and inserted fresh rows on
-- every run, whether or not anything had changed. One returned task nobody
-- reviewed therefore produced sixty identical rows an hour, indefinitely.
--
-- IT IS QUIET RIGHT NOW AND THAT IS NOT A FIX. The flood stopped at 03:20:37Z
-- because code-b accepted that task, not because anything changed here. The
-- next return restarts it.
--
-- TWO DATES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS. Keeping an unchanged row
-- alive needs a freshness signal, and the tempting shortcut is to bump
-- prepared_at on each tick. That would make every review proposal read sixty
-- seconds old forever -- and "this has been waiting four hours" is exactly the
-- signal whose absence let 676 rows accumulate without anyone noticing the
-- queue was stuck. So:
--
--   prepared_at    when the dispatcher FIRST said this. Never rewritten.
--                  How long the work has been waiting for a human.
--   reaffirmed_at  when it last said it again, unchanged. The staleness clock
--                  canConfirm reads.
--
-- A reaffirm_count WAS DRAFTED HERE AND DELETED BEFORE IT SHIPPED. It would have
-- read nicely -- "this proposal has been re-derived 240 times" is a consumer
-- that does not exist, stated as a number. But the dispatch tick writes through
-- PostgREST, which cannot express `reaffirm_count = reaffirm_count + 1` in a
-- PATCH, so the column would have been created, documented, and left at zero
-- forever. This project's third hollow gate was a guard reading a column
-- nothing ever wrote. The same shape does not get added on purpose.
-- The gap between prepared_at and reaffirmed_at answers the same question
-- without a writer: a row first seen four hours ago and reaffirmed ten seconds
-- ago has been ignored for four hours.
--
-- NULLABLE, NOT DEFAULTED TO now(). Rows written before this migration have no
-- reaffirmation and must not acquire a fake one: src/dispatch.mjs reads
-- `reaffirmed_at ?? prepared_at`, so a null ages from its original date exactly
-- as it did before. A default of now() would have made every historical row
-- permanently confirmable, which is a staleness check that has stopped
-- refusing. There is a test named for that fallback.

alter table agentbridge.proposals
  add column if not exists reaffirmed_at timestamptz;

comment on column agentbridge.proposals.reaffirmed_at is
  'Last tick at which the dispatcher derived this proposal unchanged. NULL means never reaffirmed; readers age such a row from prepared_at. Freshness reads this; prepared_at stays the waiting-since clock.';

-- The dispatch tick reads the open set every run and matches it against what it
-- has just derived, so it filters on state and orders by the freshness column.
create index if not exists proposals_open_by_reaffirmed
  on agentbridge.proposals (state, reaffirmed_at desc nulls last)
  where state = 'open';

-- public.proposals IS A VIEW WITH AN EXPLICIT COLUMN LIST, and a view does not
-- grow when its table does. That exact omission caused a PGRST204 outage here
-- once already, so the view is recreated rather than left to inherit nothing.
-- security_invoker MUST be preserved: without it the view runs as owner and
-- bypasses RLS.
do $$
begin
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'proposals') then
    execute $v$
      create or replace view public.proposals
      with (security_invoker = true) as
      select
        proposal_id, kind, state, task_id,
        agent_id, session_id, lane_id,
        returned_by, head_sha, notes,
        would_be_accepted, reasons,
        prepared_at, prepared_by,
        reaffirmed_at,
        confirmed_at, confirmed_by,
        superseded_at
      from agentbridge.proposals
    $v$;
  end if;
end $$;
