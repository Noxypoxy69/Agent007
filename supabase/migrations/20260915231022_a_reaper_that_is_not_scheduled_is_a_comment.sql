-- A REAPER THAT IS NOT SCHEDULED IS A COMMENT.
--
-- code-d's phrase, from its independent audit, and it is exact. I wrote
-- expire_dead_leases and expire_dead_reviews, tested their pure counterparts,
-- applied them, probed them -- and never scheduled either. They had never run
-- and could never have run. cron.job held exactly one row: the dispatcher.
--
-- The whole argument for leases was that a worker killed by the host releases
-- its work automatically instead of holding it until a person notices. That
-- argument was FALSE AS SHIPPED. Nothing swept anything. The recovery property
-- existed in the function body and nowhere else.
--
-- This is the same family as the other hollow gates this project produced in a
-- single day: a guard that could not fail, a mutation that never applied, a
-- comment describing an intention as though it were a behaviour, and a column
-- nothing wrote. Here it is a correct function on a schedule that did not
-- exist. Every one of them passed inspection.
--
-- EVERY MINUTE, LIKE THE DISPATCHER. The lease default is 900s and the review
-- default 1800s, so a minute is far finer than needed -- which is the point.
-- The cost of a sweep that finds nothing is one cheap query; the cost of one
-- that runs too late is work sitting dead in the pool. Both functions use FOR
-- UPDATE SKIP LOCKED, so a slow sweep is skipped by the next rather than
-- queueing behind it.
--
-- ONE JOB, BOTH REAPERS, because they are the same act on two halves of one
-- lifecycle. Splitting them would let one be disabled without the other,
-- leaving dead workers swept and dead reviewers not -- which is exactly the
-- asymmetry that produced the reviewer-lease bug in the first place.
--
-- VERIFIED BY PROBE, IN A TRANSACTION THAT ROLLED BACK:
--   swept=1 | back_in_pool=1 | attempt_preserved=1 | outbox_event=1
-- attempt_preserved is the one that matters. A sweep that reset the counter
-- would make a task that kills every worker touching it look like fresh work
-- forever, and the retry limit would never be reached.
create or replace function public.reconcile_leases()
returns jsonb
language plpgsql
security definer
set search_path = public, agentbridge
as $fn$
declare
  work_freed    integer;
  reviews_freed integer;
begin
  work_freed    := public.expire_dead_leases();
  reviews_freed := public.expire_dead_reviews();

  -- Returned rather than raised: pg_cron records the value, so a quiet sweep is
  -- indistinguishable from a broken one unless it says what it found.
  return jsonb_build_object(
    'at', now(),
    'work_leases_expired', work_freed,
    'review_leases_expired', reviews_freed
  );
end;
$fn$;

revoke execute on function public.reconcile_leases() from public, anon, authenticated;
grant execute on function public.reconcile_leases() to service_role;

select cron.unschedule('agentbridge-reconcile-leases')
where exists (select 1 from cron.job where jobname = 'agentbridge-reconcile-leases');

select cron.schedule(
  'agentbridge-reconcile-leases',
  '* * * * *',
  $job$select public.reconcile_leases()$job$
);
