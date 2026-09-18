-- THE FOURTH GAP: NOTHING RELEASED THE REVIEW LEASE.
--
-- code-d's point 4, and the one I had not closed. The worker's lease is
-- consumed by the return, deliberately and explicitly, so a worker cannot hand
-- the same work in twice. The reviewer's lease had no equivalent: accept_task
-- and cancel_task move the row out of 'returned' and never touch reviewer,
-- review_lease_token or review_lease_expires_at. A reviewer would go on holding
-- a live lease over work that was already finished.
--
-- WHY A TRIGGER RATHER THAN FIXING THE TWO CALLERS.
--
-- The obvious fix is to clear the columns in acceptTask and cancelTask. That
-- works today and is wrong tomorrow: it makes the property depend on every
-- FUTURE path out of 'returned' remembering to do it too. This system already
-- has four ways a task can move -- an edge function, a CLI, a SQL function and
-- a cron reconciliation -- and the reviewer columns were missed by all four
-- once already. Asking the next author to remember is how that happens twice.
--
-- A trigger cannot be forgotten by a caller, because the caller is not
-- involved. The invariant is "a review lease exists only while the work is in
-- review", and an invariant belongs where it cannot be routed around.
--
-- IT FIRES ON LEAVING 'returned', NOT ON REACHING A TERMINAL STATE. Those are
-- different: work rejected back to 'runnable' for rework also ends the review,
-- and a rule written only for accept/cancel would leave a live reviewer lease
-- on a task somebody is about to start over.
--
-- VERIFIED BY PROBE, IN A TRANSACTION THAT ROLLED BACK:
--   under_review=1 | after_accept_lease_left=0 | after_rework_lease_left=0
--   | unrelated_update_kept_lease=1
-- The last cell is the positive control. A trigger that released the lease on
-- ANY update would also pass the first three, and would quietly end a review
-- every time somebody touched an unrelated column.
create or replace function agentbridge.release_review_lease()
returns trigger
language plpgsql
as $fn$
begin
  if old.state = 'returned' and new.state is distinct from 'returned' then
    new.reviewer := null;
    new.review_lease_token := null;
    new.review_lease_expires_at := null;
  end if;
  return new;
end;
$fn$;

drop trigger if exists release_review_lease on agentbridge.tasks;
create trigger release_review_lease
  before update on agentbridge.tasks
  for each row
  execute function agentbridge.release_review_lease();

revoke execute on function agentbridge.release_review_lease() from public, anon, authenticated;
