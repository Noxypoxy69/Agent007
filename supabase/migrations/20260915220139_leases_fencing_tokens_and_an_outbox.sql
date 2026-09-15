-- APPLIED as 20260915220139. Verified live before this file was renamed to it.
--
-- ═══ THE TABLE IS agentbridge.tasks. public.tasks IS A VIEW OVER IT. ═══
--
-- The first attempt at this migration ran ALTER TABLE public.tasks and was
-- refused: "this operation is not supported for views". That view already had
-- an EXPLICIT column list rather than select * -- the fix applied to
-- session_registrations earlier today after a ten-minute PGRST204 outage. An
-- explicit list is right, and it means the view does NOT grow when its table
-- does. So every column added below is added to the view too, by hand, in the
-- same migration. Adding one and not the other is that outage exactly.
--
-- ASSIGNMENT BECOMES ONE TRANSACTION, AND A CLAIM CARRIES A FENCING TOKEN.
--
-- Until now an assignment was a PATCH from an edge function: read the task,
-- decide, write it back. Two confirmations arriving together could both read
-- "runnable" and both write "assigned", and the second would silently win. That
-- has not happened yet only because there has been one coordinator and almost
-- no traffic -- which is luck, not a guard.
--
-- WHAT A LEASE IS FOR. A worker holding work holds it UNTIL A DEADLINE, not
-- forever. Without an expiry, a worker killed by the host -- which happened
-- three times on 2026-09-15 -- holds its task until a person notices. With one,
-- the work returns to the pool by itself and the attempt counter records that
-- it was tried before.
--
-- WHY A RANDOM TOKEN RATHER THAN THE SESSION ID. It is a FENCING token, minted
-- fresh on every claim, so a worker that was assigned, died, and came back
-- under the same session id cannot use stale knowledge to return work that has
-- since been reassigned. Its token is simply not the current one. A session id
-- is stable and therefore useless for this; that is why fencing tokens exist.
--
-- THE OUTBOX IS WRITTEN IN THE SAME TRANSACTION AS THE CLAIM. That is the only
-- way to close "lost publish after DB commit": published after commit, a crash
-- in between leaves work assigned that nobody was ever told about. Committed
-- together, the event exists if and only if the assignment does. Delivery is
-- then AT-LEAST-ONCE by construction, which is precisely why every consumer
-- must re-read Postgres rather than trust an event body -- shouldActOnEvent().

alter table agentbridge.tasks
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt integer not null default 0;

/*
 * A REVIEW IS ALSO A LEASE, AND IT GETS ITS OWN FIELDS.
 *
 * Returned work is not finished; it is waiting for somebody who did not write
 * it. If a review were not leased, a reviewer that died would take the work out
 * of circulation silently -- the same failure as a worker dying, and one of the
 * behaviours this runtime is required to survive.
 *
 * SEPARATE FROM lease_token ON PURPOSE. The worker's lease is CONSUMED by the
 * return (set null, so it cannot return the same work twice). Reusing that
 * field for the reviewer would make "who holds this" ambiguous at exactly the
 * handover point, which is the one moment it has to be unambiguous.
 *
 * The guards over these columns are pure and already tested:
 * reviewerQueue() and canReview() in src/runtime.mjs.
 */
alter table agentbridge.tasks
  add column if not exists reviewer text,
  add column if not exists review_lease_token uuid,
  add column if not exists review_lease_expires_at timestamptz;

-- THE VIEW, RECREATED WITH THE NEW COLUMNS NAMED. security_invoker=true is
-- preserved deliberately: dropping it would make the view run as its owner and
-- silently bypass RLS on the base table.
create or replace view public.tasks
with (security_invoker = true) as
select task_id, title, state, lane_id, repo_id, base_sha,
       allowed_paths, forbidden_paths, shared_paths, depends_on,
       assigned_agent, assigned_session, assigned_at, assigned_by,
       created_at, updated_at,
       returned_by, returned_at, returned_head_sha, returned_notes,
       accepted_by, accepted_at, accepted_head_sha,
       cancelled_by, cancelled_at, cancelled_reason,
       lease_token, lease_expires_at, attempt,
       reviewer, review_lease_token, review_lease_expires_at
  from agentbridge.tasks;

grant select, insert, update, delete on public.tasks to service_role;

-- Events that MUST NOT be lost if the process publishing them dies.
create table if not exists agentbridge.outbox (
  event_id     bigserial primary key,
  kind         text        not null,
  task_id      text,
  agent_id     text,
  session_id   text,
  lease_token  uuid,
  payload      jsonb       not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  -- Set when a consumer has acted. NOT a delivery guarantee: at-least-once
  -- means this may be written more than once, and a consumer that trusts it
  -- instead of re-reading the task row is the bug this design prevents.
  delivered_at timestamptz
);

create index if not exists outbox_undelivered_idx
  on agentbridge.outbox (event_id) where delivered_at is null;

alter table agentbridge.outbox enable row level security;
create or replace view public.outbox
with (security_invoker = true) as
select event_id, kind, task_id, agent_id, session_id, lease_token,
       payload, created_at, delivered_at
  from agentbridge.outbox;

revoke all on public.outbox from public, anon, authenticated;
grant select, insert, update on public.outbox to service_role;
grant usage, select on sequence agentbridge.outbox_event_id_seq to service_role;

/*
 * CLAIM ONE TASK, ATOMICALLY.
 *
 * FOR UPDATE SKIP LOCKED is the load-bearing clause. Two schedulers racing for
 * one row: the first takes the lock, the second SKIPS it and is told so, rather
 * than blocking until the first commits and then overwriting its work. A plain
 * FOR UPDATE would serialise them and both would succeed in turn -- which is
 * exactly the double-assignment this exists to make impossible.
 */
create or replace function public.claim_task(
  p_task_id       text,
  p_agent_id      text,
  p_session_id    text,
  p_by            text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public, extensions
as $fn$
declare
  t         agentbridge.tasks%rowtype;
  tok       uuid := extensions.gen_random_uuid();
  now_ts    timestamptz := now();
  expires   timestamptz;
  dep       text;
  dep_state text;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 86400 then
    return jsonb_build_object('ok', false, 'reason',
      'lease_seconds must be between 30 and 86400');
  end if;

  select * into t from agentbridge.tasks
   where task_id = p_task_id
     for update skip locked;

  if not found then
    /*
     * Two readings, one answer, and the caller must not have to tell them
     * apart: either no such task, or another transaction holds it right now.
     * Both mean "you did not get it", and retrying is correct for both.
     */
    return jsonb_build_object('ok', false, 'reason', 'not-claimable',
      'detail', 'no such task, or another transaction holds it');
  end if;

  -- A LIVE lease held by somebody else blocks. An EXPIRED one does not: that is
  -- the whole point of an expiry.
  if t.lease_token is not null
     and t.lease_expires_at is not null
     and t.lease_expires_at > now_ts
     and t.assigned_session is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'leased',
      'detail', format('held by %s until %s', t.assigned_session, t.lease_expires_at));
  end if;

  if t.state not in ('runnable', 'returned') then
    return jsonb_build_object('ok', false, 'reason', 'state',
      'detail', format('task is "%s"; only runnable or returned work can be claimed', t.state));
  end if;

  -- Dependencies are checked INSIDE the same transaction, so one cannot be
  -- cancelled between the check and the write.
  for dep in select jsonb_array_elements_text(coalesce(t.depends_on, '[]'::jsonb)) loop
    select state into dep_state from agentbridge.tasks where task_id = dep;
    if dep_state is null then
      return jsonb_build_object('ok', false, 'reason', 'dependency',
        'detail', format('depends on "%s", which does not exist', dep));
    elsif dep_state <> 'accepted' then
      return jsonb_build_object('ok', false, 'reason', 'dependency',
        'detail', format('depends on "%s", which is "%s" and not accepted', dep, dep_state));
    end if;
  end loop;

  expires := now_ts + make_interval(secs => p_lease_seconds);

  update agentbridge.tasks
     set state            = 'assigned',
         assigned_agent   = p_agent_id,
         assigned_session = p_session_id,
         assigned_by      = p_by,
         assigned_at      = now_ts,
         lease_token      = tok,
         lease_expires_at = expires,
         attempt          = t.attempt + 1,
         updated_at       = now_ts
   where task_id = p_task_id;

  -- SAME TRANSACTION. The event and the assignment commit together or not at all.
  insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
  values ('assigned', p_task_id, p_agent_id, p_session_id, tok,
          jsonb_build_object('attempt', t.attempt + 1, 'lease_expires_at', expires));

  return jsonb_build_object('ok', true, 'task_id', p_task_id, 'lease_token', tok,
    'lease_expires_at', expires, 'attempt', t.attempt + 1);
end;
$fn$;

/*
 * RENEW, BY COMPARE-AND-SET ON THE TOKEN.
 *
 * A worker still working says so. It must present the CURRENT token: a
 * superseded one belongs to a claim that is over, and renewing it would
 * resurrect a lease somebody else now holds.
 */
create or replace function public.renew_lease(
  p_task_id text, p_lease_token uuid, p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public
as $fn$
declare
  expires timestamptz := now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 900), 30));
  hit     integer;
begin
  update agentbridge.tasks
     set lease_expires_at = expires, updated_at = now()
   where task_id = p_task_id
     and lease_token = p_lease_token
     and lease_expires_at > now();
  get diagnostics hit = row_count;

  if hit = 0 then
    -- The caller must STOP rather than keep working: the token is wrong, or the
    -- lease already expired and the task may be somebody else's now.
    return jsonb_build_object('ok', false, 'reason', 'lease-not-current');
  end if;
  return jsonb_build_object('ok', true, 'lease_expires_at', expires);
end;
$fn$;

/*
 * THE ZOMBIE GUARD.
 *
 * A worker that was assigned, went away long enough for its lease to expire,
 * and came back with a finished result must NOT be able to write it. By then
 * the task may have been re-claimed, and accepting the late result would
 * overwrite live work with the output of a run nobody is waiting for. Refused
 * on the TOKEN, which is why the token is random per claim.
 */
create or replace function public.return_with_lease(
  p_task_id text, p_lease_token uuid, p_head_sha text, p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public
as $fn$
declare
  t      agentbridge.tasks%rowtype;
  now_ts timestamptz := now();
begin
  if p_head_sha is null or p_head_sha !~ '^[0-9a-f]{40}$' then
    return jsonb_build_object('ok', false, 'reason', 'head-sha',
      'detail', 'a return requires a full 40-character sha');
  end if;

  select * into t from agentbridge.tasks where task_id = p_task_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no-such-task');
  end if;

  if t.lease_token is distinct from p_lease_token then
    return jsonb_build_object('ok', false, 'reason', 'stale-lease',
      'detail', 'this claim has been superseded; the work was re-assigned');
  end if;
  if t.lease_expires_at is null or t.lease_expires_at <= now_ts then
    return jsonb_build_object('ok', false, 'reason', 'lease-expired',
      'detail', format('the lease expired at %s; re-claim before returning', t.lease_expires_at));
  end if;
  if t.state <> 'assigned' then
    return jsonb_build_object('ok', false, 'reason', 'state',
      'detail', format('task is "%s"; only assigned work can be returned', t.state));
  end if;

  update agentbridge.tasks
     set state = 'returned', returned_by = t.assigned_session, returned_at = now_ts,
         returned_head_sha = p_head_sha,
         returned_notes = nullif(btrim(coalesce(p_notes, '')), ''),
         -- The lease is CONSUMED by the return. Holding a live lease afterwards
         -- would let the worker return the same work twice.
         lease_token = null, lease_expires_at = null,
         updated_at = now_ts
   where task_id = p_task_id;

  insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
  values ('returned', p_task_id, t.assigned_agent, t.assigned_session, p_lease_token,
          jsonb_build_object('head_sha', p_head_sha, 'attempt', t.attempt));

  return jsonb_build_object('ok', true, 'task_id', p_task_id, 'state', 'returned');
end;
$fn$;

/*
 * RECONCILIATION, WHICH IS ALL pg_cron IS FOR NOW.
 *
 * "pg_cron is reconciliation only, not the primary handoff engine." It does not
 * hand work out; it expires dead leases so the work becomes claimable again,
 * and records that it did. The handoff itself is claim_task, which is atomic
 * and does not need a scheduler in order to be correct.
 */
create or replace function public.expire_dead_leases()
returns integer
language plpgsql
security definer
set search_path = agentbridge, public
as $fn$
declare
  n integer := 0;
  r record;
begin
  for r in
    select task_id, assigned_agent, assigned_session, lease_token, attempt
      from agentbridge.tasks
     where state = 'assigned'
       and lease_token is not null
       and lease_expires_at is not null
       and lease_expires_at <= now()
       for update skip locked
  loop
    update agentbridge.tasks
       set state = 'runnable',
           assigned_agent = null, assigned_session = null, assigned_at = null,
           lease_token = null, lease_expires_at = null, updated_at = now()
     where task_id = r.task_id;

    insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
    values ('lease_expired', r.task_id, r.assigned_agent, r.assigned_session, r.lease_token,
            jsonb_build_object('attempt', r.attempt,
              'note', 'lease expired; work returned to the pool'));
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

revoke execute on function public.claim_task(text, text, text, text, integer) from public, anon, authenticated;
revoke execute on function public.renew_lease(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.return_with_lease(text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.expire_dead_leases() from public, anon, authenticated;
grant execute on function public.claim_task(text, text, text, text, integer) to service_role;
grant execute on function public.renew_lease(text, uuid, integer) to service_role;
grant execute on function public.return_with_lease(text, uuid, text, text) to service_role;
grant execute on function public.expire_dead_leases() to service_role;
