-- A GUARD OVER A FIELD NOTHING WRITES CANNOT FAIL, WHICH MEANS IT CANNOT HOLD.
--
-- Found by code-d reviewing fb4d604, and confirmed against the live database
-- rather than the repo: after the lease migration landed, the three reviewer
-- columns existed and NOT ONE FUNCTION WROTE THEM.
--
--   select proname from pg_proc where functiondef ilike '%review_lease_token%'
--   -> (none)
--
-- The consequence is the interesting part. canReview() in src/runtime.mjs
-- computes `held` from review_lease_token and review_lease_expires_at. If
-- nothing ever sets them, `held` is permanently false, canReview always
-- permits, and the mutual exclusion between two reviewers is enforced by a
-- comparison against null. The test for it passes. It is testing nothing.
--
-- That is the same shape as two other hollow gates this project hit the same
-- day: a loopback test whose mutation never applied, and a regression gate that
-- reconstructed the rule it was checking. All three pass. All three prove
-- nothing. The rule code-d drew from its own near-miss applies here too --
-- ASSERT THE MUTATION LANDED BEFORE TRUSTING THE RESULT OF RUNNING IT -- and
-- its database-shaped cousin is: A COLUMN WITH NO WRITER IS NOT A FEATURE.
--
-- WORSE, THE PREVIOUS MIGRATION SAID OTHERWISE IN PROSE. It claimed the
-- reviewer columns existed so that "a reviewer that died would not take the
-- work out of circulation silently". As shipped, a dead reviewer did exactly
-- that: expire_dead_leases filters `where state = 'assigned'`, and a task under
-- review is 'returned', so no sweep ever reached it. The worker half of that
-- failure was closed and the reviewer half was not, while the comment read as
-- though both were. A comment describing an intention as though it were a
-- behaviour is worse than no comment.

/*
 * MINT A REVIEW LEASE. The writer that was missing.
 *
 * THE AUTHOR IS REFUSED IN SQL, not merely in the pure guard. canReview()
 * already refuses the returning session, but a guard living only in one caller
 * is advice; the database is where the property has to hold, because this is
 * the one rule whose violation is invisible afterwards -- an accepted task does
 * not record who reviewed it against who wrote it.
 */
create or replace function public.claim_review(
  p_task_id text, p_reviewer_session text, p_lease_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public, extensions
as $fn$
declare
  t       agentbridge.tasks%rowtype;
  tok     uuid := extensions.gen_random_uuid();
  now_ts  timestamptz := now();
  expires timestamptz;
begin
  if p_reviewer_session is null or btrim(p_reviewer_session) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no-reviewer');
  end if;
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

  if t.state <> 'returned' then
    return jsonb_build_object('ok', false, 'reason', 'state',
      'detail', format('task is "%s"; only returned work is reviewable', t.state));
  end if;

  -- NOBODY REVIEWS THEIR OWN RETURN. One party on both sides of a review is not
  -- a review, it is a formality -- and it is the entire property the returned
  -- state exists to create.
  if t.returned_by is not null and t.returned_by = p_reviewer_session then
    return jsonb_build_object('ok', false, 'reason', 'self-review',
      'detail', 'the session that returned this work cannot review it');
  end if;

  -- A LIVE review held by somebody else blocks; an expired one does not. Same
  -- rule as the worker lease, for the same reason.
  if t.review_lease_token is not null
     and t.review_lease_expires_at is not null
     and t.review_lease_expires_at > now_ts
     and t.reviewer is distinct from p_reviewer_session then
    return jsonb_build_object('ok', false, 'reason', 'under-review',
      'detail', format('held by %s until %s', t.reviewer, t.review_lease_expires_at));
  end if;

  expires := now_ts + make_interval(secs => p_lease_seconds);

  update agentbridge.tasks
     set reviewer = p_reviewer_session,
         review_lease_token = tok,
         review_lease_expires_at = expires,
         updated_at = now_ts
   where task_id = p_task_id;

  insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
  values ('review_claimed', p_task_id, null, p_reviewer_session, tok,
          jsonb_build_object('review_expires_at', expires));

  return jsonb_build_object('ok', true, 'task_id', p_task_id,
    'review_lease_token', tok, 'review_expires_at', expires);
end;
$fn$;

/* RENEW A REVIEW, compare-and-set on the review token. The renewer that was missing. */
create or replace function public.renew_review_lease(
  p_task_id text, p_review_token uuid, p_lease_seconds integer default 1800
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public
as $fn$
declare
  expires timestamptz := now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 1800), 30));
  hit     integer;
begin
  update agentbridge.tasks
     set review_lease_expires_at = expires, updated_at = now()
   where task_id = p_task_id
     and review_lease_token = p_review_token
     and review_lease_expires_at > now();
  get diagnostics hit = row_count;

  if hit = 0 then
    return jsonb_build_object('ok', false, 'reason', 'review-lease-not-current');
  end if;
  return jsonb_build_object('ok', true, 'review_expires_at', expires);
end;
$fn$;

/*
 * SWEEP DEAD REVIEWS. The reaper that was missing, and the one that makes the
 * previous migration's stated reason actually true.
 *
 * It matches `state = 'returned'`, which is precisely why expire_dead_leases
 * never touched these: that function filters `state = 'assigned'`, and a task
 * under review has already left that state.
 */
create or replace function public.expire_dead_reviews()
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
    select task_id, reviewer, review_lease_token
      from agentbridge.tasks
     where state = 'returned'
       and review_lease_token is not null
       and review_lease_expires_at is not null
       and review_lease_expires_at <= now()
       for update skip locked
  loop
    update agentbridge.tasks
       set reviewer = null, review_lease_token = null,
           review_lease_expires_at = null, updated_at = now()
     where task_id = r.task_id;

    insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
    values ('review_lease_expired', r.task_id, null, r.reviewer, r.review_lease_token,
            jsonb_build_object('note', 'reviewer lease expired; work is waiting for review again'));
    n := n + 1;
  end loop;
  return n;
end;
$fn$;

/*
 * FIX 1: A SAME-SESSION RE-CLAIM NO LONGER BURNS AN ATTEMPT.
 *
 * Also code-d's, flagged as lower-confidence in its report and right on
 * inspection. The live-lease check exempts the holder, so a worker re-claiming
 * its own live lease instead of calling renew_lease incremented `attempt` each
 * time. At RETRY_LIMIT 3 that reaches escalation without anything having failed
 * -- an escalation counter sensitive to which API the worker happened to use,
 * and renew_lease is the easier of the two to forget.
 *
 * A re-claim by the SAME session holding a LIVE lease is a renewal in all but
 * name, so it is counted as one. A re-claim after expiry is a genuine second
 * attempt and still counts.
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

/*
 * FIX 2: assigned_by IS CLEARED WITH THE REST.
 *
 * Cosmetic but misleading: a row returned to 'runnable' that still names who
 * assigned it reads as though somebody assigned it and nobody is holding it,
 * which is two different states at once.
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
           assigned_by = null,
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

revoke execute on function public.claim_review(text, text, integer) from public, anon, authenticated;
revoke execute on function public.renew_review_lease(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.expire_dead_reviews() from public, anon, authenticated;
grant execute on function public.claim_review(text, text, integer) to service_role;
grant execute on function public.renew_review_lease(text, uuid, integer) to service_role;
grant execute on function public.expire_dead_reviews() to service_role;
