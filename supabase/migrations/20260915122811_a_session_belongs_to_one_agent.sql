-- A SESSION BELONGS TO ONE AGENT ON ONE MACHINE.
--
-- Applied to ornbhvaijcpsbcgquzhd as version 20260915122811.
--
-- /register upserts on session_id alone, so any holder of the registration
-- token could overwrite any session row -- including one belonging to another
-- agent. Observed live: code-d registered as danny-win-f1 and code-b's next
-- heartbeat silently took it back, ~90 seconds later. Neither side saw an
-- error; the roster simply disagreed with reality.
--
-- WHY THIS IS NOT BOUND TO THE TOKEN. The obvious fix is to record which token
-- wrote the row and refuse a different one. There is exactly ONE registration
-- token, shared by every worker, so that check would pass for every attacker
-- and every accident it is meant to stop. It would be decoration. Ownership is
-- therefore (agent_id, machine_id) -- the identity the worker actually proves
-- by standing in a git worktree -- and the token label is recorded alongside
-- for provenance only.
--
-- CONSEQUENCE, DELIBERATE: renaming an agent while keeping its session id is
-- now refused. Handing a session to a different agent is deregister-then-
-- register, which is two explicit acts instead of one silent overwrite.
--
-- Proven in an aborting transaction before being relied on: a takeover of
-- danny-win-10 by another agent raised session_owned_by_another_agent, the
-- rightful owner's heartbeat still applied, and a brand new session still
-- inserted.

alter table agentbridge.session_registrations
  add column if not exists registered_by text;

comment on column agentbridge.session_registrations.registered_by is
  'Token label that last wrote this row. PROVENANCE ONLY -- never an authorization check: one registration token is shared by every worker, so this value does not distinguish them.';

create or replace function agentbridge.guard_session_owner()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.agent_id is distinct from old.agent_id
     or new.machine_id is distinct from old.machine_id then
    raise exception 'session_owned_by_another_agent'
      using detail = format(
        'session %L is held by agent %L on machine %L; %L on %L may not take it over',
        old.session_id, old.agent_id, old.machine_id, new.agent_id, new.machine_id),
        hint = 'deregister the session first, then register it under the new identity';
  end if;
  return new;
end $$;

-- Fires before stamp_registration_time: BEFORE triggers run in name order, and
-- a refusal must happen before anything is stamped.
drop trigger if exists guard_session_owner on agentbridge.session_registrations;
create trigger guard_session_owner
  before update on agentbridge.session_registrations
  for each row execute function agentbridge.guard_session_owner();
