-- A SEAT REAPER, BECAUSE RETIREMENT ONLY EVER RAN AT REGISTRATION.
--
-- Same family as "a reaper that is not scheduled is a comment", and the same
-- lesson one layer over. retireStaleSeats is correct and it is only reachable
-- from the /register handler -- so a seat that goes stale AFTER the last
-- registration is never swept by anything. Nothing runs on a timer.
--
-- MEASURED 2026-09-19, not theorised. Fifteen rows for about five agents:
--
--   code-b   4 seats   stale 21450s, 61054s, 62086s, 163881s
--   code-a   3 seats
--   fixer    3 seats   two of them created ten seconds apart
--   code-c   2 seats
--
-- And it is not cosmetic. resolveLiveAgent refuses with ambiguous-session once
-- an agent has more than one candidate, so assign_task CANNOT ROUTE to code-a,
-- code-b, code-c or fixer at all. The queue is unusable while the debris sits
-- there, and every new session compounds it: fixer's two extra seats were each
-- LIVE when the other registered, so neither could retire the other, and they
-- went stale together afterwards with nothing left to look.
--
-- UNKNOWN LIVENESS IS NOT DEATH, AND THAT IS THE WHOLE SAFETY ARGUMENT.
-- A NULL heartbeat means nobody ever stamped this row, which is exactly the
-- state a just-registered session is in for its first moments. Sweeping it
-- would delete a session that is starting up. So a row is only reclaimable
-- when it carries a heartbeat AND that heartbeat is old -- evidence of death,
-- never absence of evidence. Same judgement the null-is-unknown contract makes
-- everywhere else in this system.
--
-- THE THRESHOLD IS DERIVED, NOT TYPED. The liveness window is 600 seconds, so
-- this sweeps at SIX consecutive missed windows. A session polls every cycle;
-- six in a row is not jitter. Deliberately far looser than the "offline"
-- display threshold, because being shown offline is recoverable in a second
-- and being deleted costs a re-registration.
--
-- AND IT WILL NOT TAKE A SEAT THAT IS HOLDING WORK. A registration whose
-- session still owns an assigned task with an unexpired lease is skipped
-- however old its heartbeat looks: deleting it would orphan work that
-- reconcile_leases is already the right mechanism to recover. Two reapers
-- fighting over one lifecycle is how the reviewer-lease asymmetry happened.
create or replace function public.reap_stale_seats(p_stale_windows integer default 6)
returns jsonb
language plpgsql
security definer
set search_path = public, agentbridge
as $fn$
declare
  cutoff   timestamptz := now() - make_interval(secs => 600 * greatest(p_stale_windows, 1));
  reaped   text[];
  skipped  integer;
begin
  -- Counted before the delete so the return value can distinguish "nothing was
  -- stale" from "everything stale was holding work" -- a sweep that reports one
  -- number for both is the quiet-failure shape this file is named after.
  select count(*) into skipped
  from agentbridge.session_registrations r
  where r.heartbeat_at is not null
    and r.heartbeat_at < cutoff
    and exists (
      select 1 from agentbridge.tasks t
      where t.assigned_session = r.session_id
        and t.state = 'assigned'
        and t.lease_expires_at is not null
        and t.lease_expires_at > now()
    );

  with doomed as (
    select r.session_id
    from agentbridge.session_registrations r
    where r.heartbeat_at is not null          -- unknown is not dead
      and r.heartbeat_at < cutoff
      and not exists (
        select 1 from agentbridge.tasks t
        where t.assigned_session = r.session_id
          and t.state = 'assigned'
          and t.lease_expires_at is not null
          and t.lease_expires_at > now()
      )
    for update skip locked
  ),
  gone as (
    delete from agentbridge.session_registrations r
    using doomed d
    where r.session_id = d.session_id
    returning r.session_id
  )
  select coalesce(array_agg(session_id), '{}') into reaped from gone;

  -- Returned rather than raised, like reconcile_leases: pg_cron records the
  -- value, so a quiet sweep is distinguishable from a broken one only if it
  -- says what it found.
  return jsonb_build_object(
    'at', now(),
    'cutoff', cutoff,
    'seats_reaped', coalesce(array_length(reaped, 1), 0),
    'sessions', reaped,
    'skipped_holding_work', skipped
  );
end;
$fn$;

revoke execute on function public.reap_stale_seats(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_seats(integer) to service_role;

-- EVERY FIVE MINUTES, NOT EVERY MINUTE. The lease reaper runs each minute
-- because work sitting dead in the pool is expensive; a stale SEAT costs
-- nothing until somebody tries to assign, and a sweep this coarse still clears
-- debris long before a human notices it. Cheap either way; this is the one
-- that does not need to be fast.
select cron.unschedule('agentbridge-reap-stale-seats')
where exists (select 1 from cron.job where jobname = 'agentbridge-reap-stale-seats');

select cron.schedule(
  'agentbridge-reap-stale-seats',
  '*/5 * * * *',
  $job$select public.reap_stale_seats()$job$
);
