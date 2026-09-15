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
create or replace function prune(retain_hours int default 48) returns void
language sql as $$
  delete from heartbeats where received_at < now() - make_interval(hours => retain_hours);
  delete from nonces     where seen_at     < now() - interval '10 minutes';
  delete from rate_windows where window_start < now() - interval '1 hour';
$$;

-- Schedule with pg_cron if available:
--   select cron.schedule('agentbridge-prune', '*/15 * * * *', $$select agentbridge.prune(48)$$);
