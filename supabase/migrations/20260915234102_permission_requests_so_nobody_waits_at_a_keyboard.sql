-- A PERMISSION REQUEST THAT DOES NOT NEED A HUMAN AT A KEYBOARD.
--
-- chatgpt-work, 21:58:17Z: "interactive Claude permission prompts are a blocking
-- defect, not an owner workflow." A keypress is not a control; it is a PERSON
-- BEING the control, and the person is asleep or on another machine while the
-- agent sits stopped.
--
-- The classification half is src/permissionRequest.mjs -- resolve policy first,
-- route by risk, deduplicate, pause only the asking task. 21 tests, 9 mutations
-- RED. This is where the requests LIVE, so that a worker killed mid-ask does not
-- lose the question, and so the owner's outstanding list survives every process
-- that produced it.
--
-- THE KEY IS THE DEDUPLICATION, AND IT IS A COLUMN RATHER THAN A CONVENTION.
-- requestKey() composes action::task::scope and deliberately excludes the
-- attempt number and the clock, so a crash-looping worker asks ONE question
-- sixty times instead of sixty questions. A unique index on the key WHERE the
-- request is undecided makes that structural: the sixtieth insert collides
-- rather than relying on every caller remembering to check first.
--
-- NOTHING HERE GRANTS ANYTHING. There is no approve() and no default that
-- resolves to allowed. A row arrives undecided and stays undecided until
-- somebody with the authority writes a decision into it. The moment this table
-- could answer its own rows, every guard downstream would be decoration.
--
-- VERIFIED BY PROBE, IN A TRANSACTION THAT ROLLED BACK:
--   filed=1 | duplicate_refused=yes | half_answer_refused=yes
--   | reask_after_answer=yes | rows=2 (history kept)
-- The third and fourth are the ones worth reading. A half-written answer is
-- refused, and a key becomes askable again once its question has been answered.
create table if not exists agentbridge.permission_requests (
  request_id    uuid        primary key default extensions.gen_random_uuid(),

  -- WHAT IS BEING ASKED, in the terms the classifier uses.
  key           text        not null,
  action        text        not null,
  task_id       text,
  scope_id      text,

  -- WHO DECIDES, as classified. Recorded rather than recomputed at read time,
  -- so a later change to the risk table cannot silently re-route a question
  -- that is already in front of somebody.
  decider       text        not null check (decider in ('policy', 'coordinator', 'owner')),
  risk          text        not null check (risk in ('routine', 'elevated', 'irreversible')),

  -- THE EVIDENCE THE DECIDER NEEDS, which is the whole point of not using a
  -- keypress: a terminal prompt shows a tool name, and a person approving from
  -- their phone needs to know what it touches and whether it can be undone.
  requested_by  text        not null,
  arguments_summary text,
  environment   text,
  reversible    boolean,

  requested_at  timestamptz not null default now(),

  -- THE ANSWER. Null until somebody with authority writes it.
  decided_at    timestamptz,
  decided_by    text,
  outcome       text        check (outcome in ('allowed', 'denied')),
  decision_note text,

  -- An answer is all three or none of them. A row carrying decided_at with no
  -- outcome is a question that LOOKS settled and is not -- worse than an open
  -- one, because it leaves the list.
  constraint decided_is_complete check (
    (decided_at is null and decided_by is null and outcome is null)
    or (decided_at is not null and decided_by is not null and outcome is not null)
  )
);

/*
 * ONE OUTSTANDING ASK PER QUESTION, ENFORCED RATHER THAN REMEMBERED.
 *
 * Partial on undecided rows only, so the history of answered requests is kept
 * in full -- the record of what was asked and what was decided is the audit
 * trail, and collapsing it would lose exactly the thing that makes a delegated
 * approval reviewable afterwards.
 */
create unique index if not exists permission_requests_one_open_per_key
  on agentbridge.permission_requests (key) where decided_at is null;

create index if not exists permission_requests_waiting
  on agentbridge.permission_requests (decider, requested_at desc) where decided_at is null;

alter table agentbridge.permission_requests enable row level security;

-- The view carries an EXPLICIT column list, for the reason recorded in
-- 20260915220139: a `select *` view does not grow when its table does, and that
-- cost this project a ten-minute PGRST204 outage once already.
create or replace view public.permission_requests
with (security_invoker = true) as
select request_id, key, action, task_id, scope_id, decider, risk,
       requested_by, arguments_summary, environment, reversible, requested_at,
       decided_at, decided_by, outcome, decision_note
  from agentbridge.permission_requests;

revoke all on public.permission_requests from public, anon, authenticated;
grant select, insert, update on public.permission_requests to service_role;
