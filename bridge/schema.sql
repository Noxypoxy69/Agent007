-- Agent Bridge — Step 1 schema (read-only coordination plane)
-- Deploy into a SEPARATE Supabase project from the We're Local production app.
-- Nothing here references or touches product tables.

create schema if not exists agentbridge;
set search_path = agentbridge, public;

-- ── machines ────────────────────────────────────────────────────────────────
-- `secret` is an HMAC key, so it must be stored recoverable — it cannot be
-- hashed like a password. RLS is enabled with NO policies, which means only
-- the service_role key can read this table. The bridge server is the only
-- thing that should ever hold that key. See THREAT_MODEL.md.
create table if not exists machines (
  id            uuid primary key,
  label         text not null,
  secret        text not null,
  platform      text,
  disabled      boolean not null default false,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
alter table machines enable row level security;

-- ── replay protection ───────────────────────────────────────────────────────
create table if not exists nonces (
  machine_id uuid not null references machines(id) on delete cascade,
  nonce      text not null,
  seen_at    timestamptz not null default now(),
  primary key (machine_id, nonce)
);
create index if not exists nonces_seen_at_idx on nonces (seen_at);
alter table nonces enable row level security;

-- ── rate limiting ───────────────────────────────────────────────────────────
create table if not exists rate_windows (
  machine_id   uuid not null references machines(id) on delete cascade,
  window_start timestamptz not null,
  count        integer not null default 0,
  primary key (machine_id, window_start)
);
alter table rate_windows enable row level security;

-- ── lanes (declared path ownership) ─────────────────────────────────────────
create table if not exists lanes (
  machine_id uuid not null references machines(id) on delete cascade,
  name       text not null,
  globs      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (machine_id, name)
);
alter table lanes enable row level security;

-- ── sessions: latest snapshot per agent ─────────────────────────────────────
create table if not exists sessions (
  machine_id   uuid not null references machines(id) on delete cascade,
  agent_id     text not null,
  lane         text,
  worktree     text,
  branch       text,
  head_sha     text,
  base_sha     text,
  main_ref     text,
  main_sha     text,
  upstream     text,
  unpushed     integer,
  ahead_main   integer,
  behind_main  integer,
  staged_count integer,
  dirty_count  integer,
  lock_count   integer,
  proc_count   integer,
  git_ok       boolean,
  state        jsonb not null,
  last_seen_at timestamptz not null default now(),
  primary key (machine_id, agent_id)
);
create index if not exists sessions_last_seen_idx on sessions (last_seen_at desc);
alter table sessions enable row level security;

-- ── heartbeats: append-only audit trail ─────────────────────────────────────
create table if not exists heartbeats (
  id          bigserial primary key,
  machine_id  uuid not null references machines(id) on delete cascade,
  received_at timestamptz not null default now(),
  payload     jsonb not null
);
create index if not exists heartbeats_machine_time_idx on heartbeats (machine_id, received_at desc);
alter table heartbeats enable row level security;

-- ── reader tokens (read-only API / MCP) ─────────────────────────────────────
-- Compared by digest, so these ARE hashed. A leaked DB row does not yield a
-- usable token.
create table if not exists reader_tokens (
  token_sha256 text primary key,
  label        text not null,
  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
alter table reader_tokens enable row level security;

-- ── retention ───────────────────────────────────────────────────────────────
-- search_path is pinned to empty and every name is qualified. Unqualified names
-- inside a function resolve against the CALLER's search_path, which is a hazard
-- nobody should have to reason about at call time (Supabase linter 0011).
create or replace function agentbridge.prune(retain_hours int default 48)
returns void
language sql
set search_path = ''
as $$
  delete from agentbridge.heartbeats   where received_at  < now() - make_interval(hours => retain_hours);
  delete from agentbridge.nonces       where seen_at      < now() - interval '10 minutes';
  delete from agentbridge.rate_windows where window_start < now() - interval '1 hour';
$$;

-- A REVOKE BINDS TO A SIGNATURE, NOT A NAME, and Postgres grants EXECUTE on
-- every newly created function to PUBLIC. Keep this in the same file as the
-- signature above; an old revoke does not follow a changed argument list.
revoke all on function agentbridge.prune(int) from public, anon, authenticated;
grant execute on function agentbridge.prune(int) to service_role;

-- Schedule with pg_cron if available:
--   select cron.schedule('agentbridge-prune', '*/15 * * * *', $$select agentbridge.prune(48)$$);

-- ── the REST projection the Worker reads ────────────────────────────────────
-- bridge/httpStore.mjs reads sessions_latest, lanes_latest and reader_tokens
-- over PostgREST. For a long time this file defined NONE of them: only the base
-- tables above, in a schema PostgREST does not even expose. The hosted surface
-- was written against a projection that did not exist, and nothing said so,
-- because a missing relation is a 404 and no code path had ever met a real
-- database. test/restProjection.test.mjs pins the shapes below.
--
-- WHY VIEWS IN public RATHER THAN EXPOSING THE agentbridge SCHEMA. PostgREST
-- serves `public` by default; exposing a second schema is a dashboard setting
-- that lives outside this file and outside review.
--
-- WHY security_invoker. A view runs as its OWNER by default, which would make
-- these a hole straight through the RLS above -- reader_tokens included,
-- readable by anon. With security_invoker the caller's own RLS applies, and
-- since the base tables have RLS on with NO policies, only service_role (which
-- holds BYPASSRLS) sees anything. Verified with has_table_privilege, not by
-- reading this text.

create or replace view public.sessions_latest
with (security_invoker = true) as
select
  s.agent_id,
  s.lane,
  m.label                                       as machine_label,
  s.worktree,
  s.state -> 'git'                              as git,
  coalesce(s.state -> 'locks',     '[]'::jsonb) as locks,
  coalesce(s.state -> 'processes', '[]'::jsonb) as processes,
  -- Null when the probe never reported. httpStore reads `!== false`, matching
  -- the node store spreading an absent key as undefined. Do NOT coalesce to
  -- true here, or the two surfaces disagree about an unknown probe.
  (s.state ->> 'processProbeOk')::boolean       as process_probe_ok,
  s.last_seen_at
from agentbridge.sessions s
join agentbridge.machines m on m.id = s.machine_id
order by s.lane, s.agent_id;

-- One row, one jsonb object: name -> globs, matching Object.fromEntries in
-- store.mjs. Over an empty table this yields a single NULL row, which
-- httpStore turns into {} -- "no lanes file" and "lanes unknown" must not
-- render the same to a caller iterating lanes.
create or replace view public.lanes_latest
with (security_invoker = true) as
select jsonb_object_agg(l.name, l.globs) as lanes
from agentbridge.lanes l;

create or replace view public.reader_tokens
with (security_invoker = true) as
select r.token_sha256, r.label, r.disabled
from agentbridge.reader_tokens r;

revoke all on public.sessions_latest, public.lanes_latest, public.reader_tokens
  from public, anon, authenticated;
grant select on public.sessions_latest, public.lanes_latest, public.reader_tokens
  to service_role;
