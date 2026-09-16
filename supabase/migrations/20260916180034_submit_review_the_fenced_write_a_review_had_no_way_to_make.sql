-- THE REVIEW COULD BE CLAIMED, RENEWED AND REAPED. IT COULD NOT BE RECORDED.
--
-- 20260915220223 added claim_review, renew_review_lease and expire_dead_reviews
-- and closed the gap code-d found: reviewer columns nothing ever wrote. It left
-- a different one, and the same shape. A reviewer can now take a lease, hold it,
-- renew it and lose it on a timeout -- and there is NO FUNCTION THAT WRITES A
-- REVIEW DECISION. accept_task exists and is the coordinator's verb: it takes no
-- review token, compares nothing, and a reviewer calling it would be accepting
-- work with a credential it was never asked to show.
--
-- So the review lease was a credential with nothing to spend it on. Every path
-- out of 'returned' available to a reviewer was an unfenced one.
--
-- WHAT FENCED MEANS HERE, and it is the same rule return_with_lease follows: the
-- token minted by claim_review is compared inside the write, and a stale token
-- matches nothing. PostgREST answers a PATCH whose predicate matched nothing
-- with 200 and an empty array, which is why this is a function with an explicit
-- row_count check and not a filtered update from the edge: A LOST RACE IS NOT A
-- SUCCESS, and a reviewer whose lease expired thirty minutes ago must be told
-- so rather than have its verdict land on work somebody else now holds.
--
-- THE HEAD SHA IS PINNED FROM THE ROW, NOT TAKEN FROM THE CALLER. Same reason
-- accept_task pins accepted_head_sha from returned_head_sha: the reviewer
-- reviewed a specific commit, and a caller-supplied sha is a claim about which
-- one. The caller's p_head_sha is compared and refused on mismatch rather than
-- trusted -- it is a check that the reviewer and the row agree about what was
-- under review, not a source of truth.

alter table agentbridge.tasks add column if not exists review_decision  text;
alter table agentbridge.tasks add column if not exists review_reasons   jsonb;
alter table agentbridge.tasks add column if not exists reviewed_by      text;
alter table agentbridge.tasks add column if not exists reviewed_at      timestamptz;
alter table agentbridge.tasks add column if not exists fix_of           text;
alter table agentbridge.tasks add column if not exists fix_task_id      text;

alter table agentbridge.tasks drop constraint if exists review_decision_is_known;
alter table agentbridge.tasks add  constraint review_decision_is_known
  check (review_decision is null
         or review_decision in ('accept', 'fix_required', 'reject'));

-- THE VIEW DOES NOT GROW A COLUMN WHEN ITS TABLE DOES, and this repository has
-- already taken a PGRST204 outage for forgetting it.
--
-- THE FIRST DRAFT OF THIS MIGRATION GOT IT WRONG IN THE OTHER DIRECTION, and it
-- is worth writing down because the trap is not the one the last author warned
-- about. I built the list by copying it out of 20260915133357 and appending the
-- six new columns. That migration has carried a comment since the day it landed
-- saying the list was READ BACK from information_schema rather than recalled --
-- and I recalled it. Six columns had been added to the view since: lease_token,
-- lease_expires_at, attempt, reviewer, review_lease_token and
-- review_lease_expires_at, all from the lease migration.
--
-- Postgres would have refused it: create or replace view cannot drop a column or
-- rename one in place, so it fails with "cannot change name of view column
-- lease_token to review_decision". A loud failure, which is the only reason this
-- was cheap. Had the six columns happened to sit at the END of the old list, the
-- replace would have SUCCEEDED and silently narrowed the view -- which is the
-- PGRST204 outage again, from the opposite side.
--
-- So this list is read back from the live catalogue, in ordinal order, with the
-- new columns appended. security_invoker is restated because dropping it makes
-- the view run as owner and bypass RLS entirely.
create or replace view public.tasks with (security_invoker = true) as
select task_id, title, state, lane_id, repo_id, base_sha,
       allowed_paths, forbidden_paths, shared_paths, depends_on,
       assigned_agent, assigned_session, assigned_at, assigned_by,
       created_at, updated_at,
       returned_by, returned_at, returned_head_sha, returned_notes,
       accepted_by, accepted_at, accepted_head_sha,
       cancelled_by, cancelled_at, cancelled_reason,
       lease_token, lease_expires_at, attempt,
       reviewer, review_lease_token, review_lease_expires_at,
       review_decision, review_reasons, reviewed_by, reviewed_at,
       fix_of, fix_task_id
  from agentbridge.tasks;

revoke all on public.tasks from anon, authenticated;
grant select, insert, update on public.tasks to service_role;

/*
 * RECORD A REVIEW, UNDER THE LEASE THAT AUTHORISED IT.
 *
 * WHERE EACH DECISION LEAVES THE TASK, and why none of them leaves it in
 * 'returned': the release_review_lease trigger clears the reviewer columns on
 * the way out of 'returned', so a decision that did not move the row would hold
 * its own lease open afterwards and a second reviewer could not take the work.
 *
 *   accept        -> 'accepted', pinned at returned_head_sha.
 *
 *   reject        -> 'runnable'. There is no commit worth building on -- the
 *                    runner only sends reject when the attempt produced none --
 *                    so the task goes back to the pool for a fresh attempt from
 *                    its original base. Nothing is created.
 *
 *   fix_required  -> 'blocked', and a SEPARATE task is inserted, runnable, based
 *                    on the reviewed commit, carrying the findings. The reviewed
 *                    task gains a dependency on it, which claim_task already
 *                    enforces ("depends on X, which is not accepted").
 *
 * THE HALF THIS DOES NOT DECIDE, stated here rather than left to be discovered:
 * WHAT HAPPENS TO THE BLOCKED ORIGINAL ONCE ITS FIX IS ACCEPTED. The dependency
 * unlock returns it to the pool and it would be re-attempted from its ORIGINAL
 * base, which throws away the fix -- or the fix's acceptance should accept the
 * original, which is a rule nothing here implements. Both are defensible and
 * choosing between them is a design call, not a detail. It is written down as
 * an open question on purpose: the alternative was to pick one quietly inside a
 * migration, which is how a decision nobody made becomes the behaviour.
 *
 * A fix task is inserted with `on conflict do nothing`. A duplicate delivery
 * after a crash is the ordinary case here and the id is derived from the
 * reviewed commit, so the second delivery finds the same row rather than
 * creating a second fix for one finding.
 */
create or replace function public.submit_review(
  p_task_id           text,
  p_review_token      uuid,
  p_decision          text,
  p_reasons           jsonb default '[]'::jsonb,
  p_reviewer_session  text default null,
  p_head_sha          text default null,
  p_fix_task          jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = agentbridge, public, extensions
as $fn$
declare
  t        agentbridge.tasks%rowtype;
  now_ts   timestamptz := now();
  next     text;
  fix_id   text;
  fix_base text;
  hit      integer;
begin
  if p_decision is null or p_decision not in ('accept', 'fix_required', 'reject') then
    return jsonb_build_object('ok', false, 'reason', 'decision',
      'detail', format('"%s" is not accept, fix_required or reject', p_decision));
  end if;

  -- The row is read under the same lock the write takes, so the fence below
  -- cannot be raced between the read and the update.
  select * into t from agentbridge.tasks
   where task_id = p_task_id
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  -- THE FENCE. An expired or superseded token is not current, and neither is a
  -- token for a task that has already left review.
  if t.review_lease_token is null
     or t.review_lease_token is distinct from p_review_token
     or t.review_lease_expires_at is null
     or t.review_lease_expires_at <= now_ts then
    return jsonb_build_object('ok', false, 'reason', 'review-lease-not-current',
      'detail', 'the review lease that authorised this decision is no longer the current one; '
             || 'the work was reclaimed and this verdict is about a review somebody else now holds');
  end if;

  if t.state <> 'returned' then
    return jsonb_build_object('ok', false, 'reason', 'state',
      'detail', format('task is "%s"; a review decides returned work', t.state));
  end if;

  -- The reviewer named in the submit must be the one holding the lease. The
  -- token already proves that; this catches a caller that sends somebody else's
  -- session id alongside a token it legitimately holds, which would file the
  -- decision under the wrong name in reviewed_by.
  if p_reviewer_session is not null and t.reviewer is distinct from p_reviewer_session then
    return jsonb_build_object('ok', false, 'reason', 'reviewer-mismatch',
      'detail', format('the lease is held by %s, not %s', t.reviewer, p_reviewer_session));
  end if;

  -- A REVIEW OF A DIFFERENT COMMIT IS NOT A REVIEW OF THIS ONE.
  if p_head_sha is not null and t.returned_head_sha is distinct from p_head_sha then
    return jsonb_build_object('ok', false, 'reason', 'head-moved',
      'detail', format('the review is of %s; the task returned %s', p_head_sha, t.returned_head_sha));
  end if;

  next := case p_decision
            when 'accept' then 'accepted'
            when 'reject' then 'runnable'
            else 'blocked'
          end;

  if p_decision = 'fix_required' then
    if p_fix_task is null or coalesce(p_fix_task->>'task_id', '') = '' then
      return jsonb_build_object('ok', false, 'reason', 'fix-task-missing',
        'detail', 'fix_required must carry the separate task that will carry the findings; '
               || 'a decision with nowhere for the work to go is a task that stops here');
    end if;
    fix_id := p_fix_task->>'task_id';
    if fix_id = p_task_id then
      return jsonb_build_object('ok', false, 'reason', 'fix-task-collides',
        'detail', 'the fix task reuses the reviewed task id, which makes it a retry and not a '
               || 'separate task');
    end if;

    fix_base := coalesce(p_fix_task->>'base_sha', t.returned_head_sha);

    /*
     * A BASE THAT IS NOT A FULL SHA IS REFUSED HERE RATHER THAN BY A CONSTRAINT.
     *
     * tasks_base_sha_check demands exactly 40 hex characters. The result
     * envelope that produces this value accepts 7 to 64, so an abbreviated
     * commit is a shape the caller can legitimately hold -- and it would abort
     * this transaction with a constraint violation, which reaches the edge
     * function as a 500. That is the one answer that invites a retry, handed to
     * the one caller that must not retry, and the review lease would be spent.
     * Name it instead.
     */
    if fix_base is null or fix_base !~ '^[0-9a-f]{40}$' then
      return jsonb_build_object('ok', false, 'reason', 'fix-task-base',
        'detail', format('the fix task needs a full 40-character commit to start from; got %s',
                         coalesce(fix_base, 'nothing')));
    end if;

    /*
     * THE FIX INHERITS THE REVIEWED TASK'S PATH CONTRACT, AND THAT IS NOT A
     * CONVENIENCE.
     *
     * These columns default to '[]', and an EMPTY ALLOW-LIST MEANS NOTHING IS
     * ALLOWED -- pathViolations in src/evidenceCollector.mjs is explicit about
     * it, because a contract that failed to load must not read as permission.
     * So a fix task inserted without them is a task on which every file the
     * fixer touches is a path violation: the machine verdict rejects every
     * attempt, forever, and the loop looks busy while nothing can ever pass.
     * A fix to the same work has the same scope as the work.
     */
    insert into agentbridge.tasks
      (task_id, title, state, lane_id, repo_id, base_sha,
       allowed_paths, forbidden_paths, shared_paths, depends_on, fix_of,
       created_at, updated_at)
    values
      (fix_id,
       coalesce(p_fix_task->>'title', format('Fix findings raised on %s', p_task_id)),
       'runnable',
       coalesce(p_fix_task->>'lane_id', t.lane_id),
       coalesce(p_fix_task->>'repo_id', t.repo_id),
       fix_base,
       coalesce(p_fix_task->'allowed_paths', t.allowed_paths),
       coalesce(p_fix_task->'forbidden_paths', t.forbidden_paths),
       coalesce(p_fix_task->'shared_paths', t.shared_paths),
       '[]'::jsonb,
       p_task_id,
       now_ts, now_ts)
    on conflict (task_id) do nothing;
  end if;

  update agentbridge.tasks
     set state             = next,
         review_decision   = p_decision,
         review_reasons    = coalesce(p_reasons, '[]'::jsonb),
         reviewed_by       = t.reviewer,
         reviewed_at       = now_ts,
         fix_task_id       = case when p_decision = 'fix_required' then fix_id else null end,
         depends_on        = case
                               when p_decision = 'fix_required'
                               then coalesce(depends_on, '[]'::jsonb) || to_jsonb(fix_id)
                               else depends_on
                             end,
         accepted_by       = case when p_decision = 'accept' then t.reviewer else accepted_by end,
         accepted_at       = case when p_decision = 'accept' then now_ts else accepted_at end,
         accepted_head_sha = case when p_decision = 'accept' then t.returned_head_sha
                                  else accepted_head_sha end,
         updated_at        = now_ts
   where task_id = p_task_id
     and review_lease_token = p_review_token
     and review_lease_expires_at > now_ts;
  get diagnostics hit = row_count;

  -- The check above is not the fence; THIS is. The read and the write are in one
  -- transaction and the row is locked, so they cannot disagree -- and asserting
  -- that rather than assuming it costs one integer.
  if hit = 0 then
    return jsonb_build_object('ok', false, 'reason', 'review-lease-not-current',
      'detail', 'the fenced write matched no row');
  end if;

  insert into agentbridge.outbox (kind, task_id, agent_id, session_id, lease_token, payload)
  values ('review_recorded', p_task_id, null, t.reviewer, p_review_token,
          jsonb_build_object('decision', p_decision, 'reasons', coalesce(p_reasons, '[]'::jsonb),
                             'state', next, 'fix_task_id', fix_id));

  return jsonb_build_object('ok', true, 'task_id', p_task_id, 'decision', p_decision,
    'state', next, 'fix_task_id', fix_id, 'reviewed_by', t.reviewer, 'reviewed_at', now_ts);
end;
$fn$;

revoke execute on function public.submit_review(text, uuid, text, jsonb, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_review(text, uuid, text, jsonb, text, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
