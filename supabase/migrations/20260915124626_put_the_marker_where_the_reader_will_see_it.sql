-- PUT THE MARKER WHERE A TRUNCATED READER WILL STILL SEE IT.
--
-- Applied to ornbhvaijcpsbcgquzhd as version 20260915124626.
--
-- guard_session_owner refused a takeover correctly, but the edge function
-- reported it as a generic 400 instead of 409 with a hint. The cause is a
-- truncation nobody designed: PostgREST serialises its error as
--
--   {"code":..., "details":..., "hint":..., "message":...}
--
-- with `message` LAST, and the edge function's write() helper keeps only the
-- first 200 characters of the body. The exception NAME lives in `message`, so
-- the string the caller matches on had already had the marker cut off it. The
-- refusal was correct and unreadable -- the worker was told its payload was
-- malformed when the payload was fine and the session simply belonged to
-- somebody else.
--
-- Fixed here rather than in the edge function because it is the cheaper and
-- far safer half: a migration instead of a redeploy of the entire data plane,
-- on a day when a redeploy had already taken the registration path down once.
--
-- The marker now LEADS `details`, which is second in the JSON and survives the
-- cut. The human sentence follows it. The `message` is unchanged, so anything
-- matching on the exception name proper still works.

create or replace function agentbridge.guard_session_owner()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.agent_id is distinct from old.agent_id
     or new.machine_id is distinct from old.machine_id then
    raise exception 'session_owned_by_another_agent'
      using detail = format(
        'session_owned_by_another_agent: session %L is held by agent %L on machine %L; %L on %L may not take it over',
        old.session_id, old.agent_id, old.machine_id, new.agent_id, new.machine_id),
        hint = 'deregister the session first, then register it under the new identity';
  end if;
  return new;
end $$;
