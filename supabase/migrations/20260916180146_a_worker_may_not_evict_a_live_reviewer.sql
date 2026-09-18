-- A WORKER CLAIMING RETURNED WORK DESTROYED A LIVE REVIEWER'S LEASE, SILENTLY.
--
-- Found by code-d, confirmed independently in test/leaseWiring.test.mjs by
-- reading the shipped definitions, and left as a deliberately vacuous assertion
-- there because the eviction was UNREACHABLE: claim_review had no caller
-- anywhere outside migrations and tests, so a lease that could not be taken
-- could not be evicted.
--
-- THAT STOPPED BEING TRUE TODAY. src/reviewRunner.mjs and
-- bin/agentbridge-review.mjs call claim_review. The gate in leaseWiring fires on
-- exactly that pairing -- claim_review reachable while claim_task still does not
-- mention the review lease -- because that pairing is the release where the
-- eviction goes live.
--
-- THE MECHANISM, in three steps, none of which logs anything:
--   1. claim_task admits state in ('runnable', 'returned') and sets 'assigned'.
--   2. release_review_lease is a BEFORE UPDATE trigger that nulls reviewer,
--      review_lease_token and review_lease_expires_at on leaving 'returned'.
--   3. So a worker claiming work a reviewer is holding SUCCEEDS, the reviewer's
--      lease is gone, and the only message emitted is an ordinary 'assigned'
--      row addressed to the worker. The reviewer finds out at submit_review,
--      when the fence refuses a token that was superseded half an hour earlier.
--
-- THE RULING IS DANNY'S AND IT PREDATES THIS CHANGE: claim_task must REFUSE
-- while a live review lease exists, mirroring the 'under-review' check
-- claim_review already carries, with a detail naming the reviewer and the
-- expiry. This migration implements that ruling and invents nothing.
--
-- AN EXPIRED REVIEW LEASE DOES NOT BLOCK, for the same reason an expired work
-- lease does not: recovery lives in the reaper, and a refusal keyed on a
-- timestamp that has passed would strand the work until expire_dead_reviews ran.
-- The condition below is `review_lease_expires_at > now()`, which is the same
-- liveness test claim_review uses, so the two cannot drift into disagreeing
-- about what "under review" means.
--
-- Everything else in this definition is byte-identical to the one in
-- 20260915220223 (the same-session re-claim fix). It is restated in full rather
-- than patched because Postgres has no patch: create or replace takes a whole
-- body, and a body assembled from memory is how a function loses a rule nobody
-- noticed it had.

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
  t            agentbridge.tasks%rowtype;
  tok          uuid := extensions.gen_random_uuid();
  now_ts       timestamptz := now();
  expires      timestamptz;
  dep          text;
  dep_state    text;
  is_renewal   boolean;
  next_attempt integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 86400 then
    return jsonb_build_object('ok', false, 'reason',
      'lease_seconds must be between 30 and 86400');
  end if;

  select * into t from agentbridge.tasks
   where task_id = p_task_id
     for update skip locked;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-claimable',
      'detail', 'no such task, or another transaction holds it');
  end if;

  is_renewal := t.lease_token is not null
            and t.lease_expires_at is not null
            and t.lease_expires_at > now_ts
            and t.assigned_session is not distinct from p_session_id;

  if t.lease_token is not null
     and t.lease_expires_at is not null
     and t.lease_expires_at > now_ts
     and t.assigned_session is distinct from p_session_id then
    return jsonb_build_object('ok', false, 'reason', 'leased',
      'detail', format('held by %s until %s', t.assigned_session, t.lease_expires_at));
  end if;

  -- A LIVE REVIEW BLOCKS A CLAIM. Danny's ruling, and the reason this refusal
  -- reads like claim_review's 'under-review': to a caller they are the same
  -- fact. A renewal is exempt -- the holder is already mid-work and its own
  -- re-claim must not be refused by a review of an earlier return.
  if not is_renewal
     and t.review_lease_token is not null
     and t.review_lease_expires_at is not null
     and t.review_lease_expires_at > now_ts then
    return jsonb_build_object('ok', false, 'reason', 'under-review',
      'detail', format('held for review by %s until %s; a claim here would destroy that lease '
                       || 'through the release_review_lease trigger and tell nobody',
                       t.reviewer, t.review_lease_expires_at));
  end if;

  -- A renewal is exempt from the state check: the holder is mid-work, and the
  -- row is legitimately 'assigned' rather than runnable or returned.
  if not is_renewal and t.state not in ('runnable', 'returned') then
    return jsonb_build_object('ok', false, 'reason', 'state',
      'detail', format('task is "%s"; only runnable or returned work can be claimed', t.state));
  end if;

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
  next_attempt := case when is_renewal then t.attempt else t.attempt + 1 end;

  update agentbridge.tasks
     set state            = 'assigned',
         assigned_agent   = p_agent_id,
         assigned_session = p_session_id,
         assigned_by      = p_by,
         assigned_at      = now_ts,
         lease_token      = tok,
         lease_expires_at = expires,
         attempt          = next_attempt,
         updated_at       = now_ts
   where task_id = p_task_id;

  insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
  values (case when is_renewal then 'lease_renewed' else 'assigned' end,
          p_task_id, p_agent_id, p_session_id, tok,
          jsonb_build_object('attempt', next_attempt, 'lease_expires_at', expires));

  return jsonb_build_object('ok', true, 'task_id', p_task_id, 'lease_token', tok,
    'lease_expires_at', expires, 'attempt', next_attempt, 'renewal', is_renewal);
end;
$fn$;
