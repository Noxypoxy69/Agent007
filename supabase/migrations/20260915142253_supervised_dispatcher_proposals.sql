-- THE SUPERVISED DISPATCHER: proposals, and a token class that cannot assign.
-- Applied to ornbhvaijcpsbcgquzhd. See src/dispatch.mjs for the guard.
--
-- The owner's ruling: the dispatcher PREPARES an assignment, the coordinator
-- confirms on its pass. Two things follow, and both are structural rather than
-- conventional.
--
-- 1. A FOURTH TOKEN CLASS. The dispatcher runs unattended on a schedule. If it
--    held a coordinator token it COULD assign work, and the only thing stopping
--    it would be that it chooses not to -- which is not a control, it is a
--    habit. This system's rule is that absence of capability is the control.
--
--    reader_tokens        read coordination state
--    registration_tokens  a worker: own liveness, own returns, own waits
--    coordinator_tokens   assign, accept, cancel, message, record decisions
--    dispatcher_tokens    PREPARE PROPOSALS. Nothing else. Cannot assign.
--
-- 2. A PROPOSAL IS NOT A PERMISSION. would_be_accepted and reasons are recorded
--    so a coordinator can READ why something was suggested. Confirmation
--    re-runs the guard against live rows and ignores them. Nothing in this
--    schema should ever be read as authority; it is a notebook, not a warrant.

create table if not exists agentbridge.dispatcher_tokens (
  token_sha256 text primary key,
  label        text not null,
  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table agentbridge.dispatcher_tokens enable row level security;
revoke all on agentbridge.dispatcher_tokens from anon, authenticated;
grant select, update on agentbridge.dispatcher_tokens to service_role;

create table if not exists agentbridge.proposals (
  proposal_id      uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('assign', 'review')),
  state            text not null default 'open'
                     check (state in ('open', 'confirmed', 'superseded')),
  task_id          text not null references agentbridge.tasks(task_id),

  -- For an assign proposal. Both, or neither: a proposal that names an agent
  -- without the session it was formed against cannot be re-verified, and
  -- re-verification is the entire safety property.
  agent_id         text,
  session_id       text,
  lane_id          text,

  -- For a review proposal: what to look at. The dispatcher cannot read a diff
  -- and forms no opinion on whether the work is good.
  returned_by      text,
  head_sha         text check (head_sha is null or head_sha ~ '^[0-9a-f]{40}$'),
  notes            text,

  -- READ THIS, DO NOT TRUST IT. The verdict as it stood when prepared.
  would_be_accepted boolean not null,
  reasons          jsonb not null default '[]'::jsonb,

  prepared_at      timestamptz not null default now(),
  prepared_by      text not null,
  confirmed_at     timestamptz,
  confirmed_by     text,
  superseded_at    timestamptz,

  constraint assign_names_a_session
    check (kind <> 'assign' or (agent_id is not null and session_id is not null)),
  constraint confirmed_names_who
    check (state <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null))
);

-- Only one open proposal per task at a time. A second would let a coordinator
-- confirm a suggestion the dispatcher has already replaced, which is the stale
-- authority problem wearing a different hat.
create unique index if not exists proposals_one_open_per_task
  on agentbridge.proposals (task_id) where state = 'open';

create index if not exists proposals_open_idx on agentbridge.proposals (prepared_at desc) where state = 'open';

alter table agentbridge.proposals enable row level security;
revoke all on agentbridge.proposals from anon, authenticated;
grant select, insert, update on agentbridge.proposals to service_role;

-- PostgREST serves `public` only, and a view does not grow a column when its
-- table does -- so the column list is explicit and the next person to add one
-- has to come here and decide. That oversight took the registration path down
-- earlier today.
create or replace view public.proposals with (security_invoker = true) as
select proposal_id, kind, state, task_id, agent_id, session_id, lane_id,
       returned_by, head_sha, notes, would_be_accepted, reasons,
       prepared_at, prepared_by, confirmed_at, confirmed_by, superseded_at
  from agentbridge.proposals;
revoke all on public.proposals from anon, authenticated;
grant select, insert, update on public.proposals to service_role;

create or replace view public.dispatcher_tokens with (security_invoker = true) as
select token_sha256, label, disabled, created_at, last_used_at
  from agentbridge.dispatcher_tokens;
revoke all on public.dispatcher_tokens from anon, authenticated;
grant select, update on public.dispatcher_tokens to service_role;

notify pgrst, 'reload schema';
