-- NINE WRITERS, ZERO READERS, AND A PARTIAL INDEX BUILT FOR A QUERY THAT DOES
-- NOT EXIST.  APPLIED as 20260916230050.
--
-- Found by code-d, confirmed here by counting: nine insert sites into
-- agentbridge.outbox across four migrations, and the only `from
-- agentbridge.outbox` anywhere is the view definition. Nothing selects the
-- view. NOTHING HAS EVER SET delivered_at. The partial index
-- `(event_id) where delivered_at is null` exists to make a drain fast, and
-- there was no drain. (code-d counted seven; it was seven in the two lease
-- migrations, and tonight's review write and eviction refusal added two.)
--
-- WHY SQL AND NOT A JS DRAIN. src/runtime.mjs already HAS a drainOutbox, and
-- shouldActOnEvent in src/leases.mjs is the predicate it wants. Neither is
-- usable: the module graph records an owner ruling that runtime.mjs must NOT
-- acquire a caller, because a second live implementation is the defect; and
-- leases.mjs is not in DEFAULT_SPLICES so the edge function cannot import it.
-- The whole chain sits inside the module forbidden to run. This is not a
-- second opinion, it is the only one.
--
-- THE RULES ARE shouldActOnEvent'S, MOVED RATHER THAN REINVENTED. An `assigned`
-- event is moot once the token differs, the lease expired, or the row left
-- `assigned`; `lease_expired` is moot unless the row really went back to the
-- pool; `returned` is moot unless the row is still returned.
--
-- THE FINDING THAT FELL OUT OF WRITING IT: nine sites emit SEVEN kinds and
-- shouldActOnEvent has rules for THREE. lease_renewed, review_claimed,
-- review_lease_expired and review_recorded hit its `unknown-kind` branch -- they
-- are inert the moment they are written. Four of seven kinds have no consumer.
-- They are drained and COUNTED SEPARATELY so that stays visible rather than
-- folded into a total. A number that hides its worst component is how 1,225
-- unconfirmed proposals went unnoticed.
--
-- delivered_at REMAINS ADVISORY. This marks what can no longer be acted on; it
-- does not license a consumer to trust the flag. shouldActOnEvent checks it
-- first only to save work and then fences on the lease token, because
-- at-least-once means the flag can be written twice.
--
-- PROVED IN A ROLLED-BACK TRANSACTION BEFORE APPLYING. Five assertions: the two
-- real rows drain; a superseded token drains; a kind with no consumer drains;
-- A CURRENT ASSIGNMENT WITH A LIVE LEASE SURVIVES (the positive control,
-- without which a drain that marked everything would pass everything else); and
-- a second run marks nothing new.
--
-- SCHEDULED, because a reaper that is not scheduled is a comment -- the title of
-- 20260915231022 and the lesson that stranded a work queue. It joins
-- reconcile_leases, the job pg_cron already runs every minute, rather than
-- adding a second schedule to forget separately. Verified by the cron, not by
-- calling it: both rows were drained at 23:01:00.174Z by the scheduled run.
--
-- reconcile_leases below is IDENTICAL to the live definition read back from
-- pg_get_functiondef immediately before writing, plus the drain.

create or replace function public.drain_outbox()
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public
as $fn$
declare
  n_moot     integer := 0;
  n_unknown  integer := 0;
  n_orphan   integer := 0;
  n_left     integer := 0;
  now_ts     timestamptz := now();
begin
  -- 1. EVENTS NOTHING WILL EVER ACT ON, because no consumer has a rule for the
  --    kind. shouldActOnEvent handles assigned, lease_expired and returned and
  --    returns unknown-kind for everything else, so lease_renewed,
  --    review_claimed, review_lease_expired and review_recorded are inert the
  --    moment they are written. Marked so the table stops growing; COUNTED
  --    separately so "four of seven kinds have no consumer" stays visible
  --    rather than being tidied into a total.
  update agentbridge.outbox
     set delivered_at = now_ts
   where delivered_at is null
     and kind not in ('assigned', 'lease_expired', 'returned');
  get diagnostics n_unknown = row_count;

  -- 2. EVENTS WHOSE TASK IS GONE.
  update agentbridge.outbox o
     set delivered_at = now_ts
   where o.delivered_at is null
     and o.task_id is not null
     and not exists (select 1 from agentbridge.tasks t where t.task_id = o.task_id);
  get diagnostics n_orphan = row_count;

  -- 3. EVENTS THE TASK ROW HAS ALREADY MOVED PAST. These are shouldActOnEvent's
  --    own refusals, and SQL is where they live now: src/runtime.mjs holds the
  --    only JS drainOutbox and the module graph records an owner ruling that it
  --    must NOT acquire a caller, because a second live implementation is the
  --    defect. src/leases.mjs is not spliced to the edge either. So this is not
  --    a second opinion -- it is the only one.
  update agentbridge.outbox o
     set delivered_at = now_ts
    from agentbridge.tasks t
   where o.delivered_at is null
     and o.task_id = t.task_id
     and (
          (o.kind = 'assigned'      and (t.lease_token is distinct from o.lease_token
                                         or t.state <> 'assigned'
                                         or t.lease_expires_at is null
                                         or t.lease_expires_at <= now_ts))
       or (o.kind = 'lease_expired' and t.state <> 'runnable')
       or (o.kind = 'returned'      and t.state <> 'returned')
     );
  get diagnostics n_moot = row_count;

  select count(*) into n_left from agentbridge.outbox where delivered_at is null;

  -- DELIVERED_AT STAYS ADVISORY. This marks what can no longer be acted on; it
  -- does not license a consumer to trust the flag. shouldActOnEvent checks it
  -- first only to save work and then fences on the lease token, because
  -- at-least-once delivery means the flag itself can be written twice. A drain
  -- that made it load-bearing would be the second opinion this avoids.
  return jsonb_build_object(
    'at', now_ts,
    'no_consumer_for_kind', n_unknown,
    'task_gone', n_orphan,
    'superseded_by_task_state', n_moot,
    'still_actionable', n_left
  );
end;
$fn$;

revoke execute on function public.drain_outbox() from public, anon, authenticated;
grant execute on function public.drain_outbox() to service_role;

create or replace function public.reconcile_leases()
returns jsonb
language plpgsql
security definer
set search_path = public, agentbridge
as $fn$
declare
  work_freed    integer;
  reviews_freed integer;
  drained       jsonb;
begin
  work_freed    := public.expire_dead_leases();
  reviews_freed := public.expire_dead_reviews();
  drained       := public.drain_outbox();

  -- Returned rather than raised: pg_cron records the value, so a quiet sweep is
  -- indistinguishable from a broken one unless it says what it found.
  return jsonb_build_object(
    'at', now(),
    'work_leases_expired', work_freed,
    'review_leases_expired', reviews_freed,
    'outbox', drained
  );
end;
$fn$;
