-- NOT YET APPLIED. The filename is provisional: apply_migration stamps its own
-- version, so read the version back from schema_migrations and rename this file
-- to it before believing the two agree. That trap has fired three times.
--
-- ═══ THE ATTEMPT RECORD. ONE ROW, FOUR VERDICTS, NEVER A `status` COLUMN. ═══
--
-- Nothing may advance authority along a "done" path before the attempt is
-- durable. Today the loop can close a task while the only account of what
-- happened lives in a process that has already exited. This is the row that
-- outlives it.
--
-- ONE RECORD, NOT TWO. Five specifications bottom out here: the loop needs a
-- durable attempt, learning needs routing identity, the execution fabric needs
-- environment identity, the console needs an attempt summary, and the expert
-- workforce needs a performance ledger. Giving the loop a thin row now and
-- adding a trajectory table beside it later produces a second table shadowing
-- the first, which the project bar names as always the wrong answer. So the
-- columns those five need are here, including ones the loop alone would not
-- have asked for.
--
-- ═══ WHY FOUR VERDICT COLUMNS AND NOT ONE STATUS ═══
--
--   agent_claimed_success   what the work said about itself
--   verification_verdict    what the machine observed
--   review_verdict          what an independent reviewer decided
--   final_state             what the task became
--
-- The DISAGREEMENT is the signal. An agent claiming success while verification
-- rejects is the false-done case the review runtime exists to catch, and a
-- schema keeping only the final answer has discarded it before anybody can
-- count how often it happens. They are deliberately four different enums, so
-- one cannot be written into another's column by a caller in a hurry.
--
-- Every one of them is NULLABLE and NULL IS NOT A PASS. A crashed attempt has
-- no verification verdict; it does not have a failing one. A learning set that
-- cannot tell "the machine rejected this" from "nothing ever checked" will
-- attribute an infrastructure crash to the engine's competence.
--
-- ═══ WHAT IS CAPTURED AT CLAIM, BECAUSE IT CANNOT BE RECONSTRUCTED LATER ═══
--
-- engine, model, role_profile, worker_slot_id, lease_id, fence_token, repo,
-- base_sha, task_class, risk_class, environment_digest. By the time an attempt
-- finishes the slot may be reused, the lease expired, the model rolled forward.
-- Benchmark identity includes the hardware it ran on, and the performance work
-- is unbuildable without it. Everything else in this row can be recomputed FROM
-- the row; these cannot, so they are NOT NULL.
--
-- ═══ RAW OUTPUT TRAVELS BY REFERENCE ═══
--
-- raw_output_ref is a cas:// reference and is CHECK-constrained to that shape.
-- stdout carries whatever the agent printed and the agent printed whatever its
-- tools did, so an inlined tool dump is the likeliest place in this system for
-- a credential to reach durable storage. The constraint is in the database and
-- not only in the writer, because the writer is one caller and the table is
-- forever.
--
-- ═══ A PUBLIC VIEW WITH AN EXPLICIT COLUMN LIST ═══
--
-- Same shape as public.tasks and for the same reason. The list does NOT grow
-- when the table does, so a later migration adding a column must add it here
-- too, by hand. Adding one and not the other is the PGRST204 outage of
-- 2026-09-15 exactly.

create table if not exists agentbridge.attempts (
  attempt_id text primary key,
  schema_version integer not null default 1,
  task_id text not null,
  attempt_no integer not null check (attempt_no >= 1),
  state text not null check (state in ('running', 'finished')),

  -- Routing identity. NOT NULL on purpose: see the header.
  engine text not null,
  model text not null,
  role_profile text not null,
  worker_slot_id text not null,
  session_id text not null,
  lease_id text not null,
  fence_token text not null,
  repo text not null,
  base_sha text not null,
  task_class text not null,
  risk_class text not null,
  environment_digest text not null check (environment_digest ~ '^[0-9a-f]{64}$'),

  workspace_id text not null,
  runtime_version text not null,
  executor_version text not null,
  policy_revision text not null,
  tool_schema_revision text not null,
  context_digest text not null check (context_digest ~ '^[0-9a-f]{64}$'),
  retry_of_attempt_id text references agentbridge.attempts (attempt_id),

  started_at timestamptz not null default now(),
  last_progress_at timestamptz not null default now(),
  finished_at timestamptz,

  ending text check (ending in ('exited', 'timeout', 'crashed', 'refused', 'unreachable')),
  exit_code integer,
  result_sha text,
  result_envelope_digest text check (result_envelope_digest ~ '^[0-9a-f]{64}$'),
  raw_output_ref text check (raw_output_ref like 'cas://%'),

  -- Four verdicts. Four columns. Never reconciled into one.
  agent_claimed_success boolean,
  verification_verdict text check (verification_verdict in ('verified', 'rejected', 'inconclusive')),
  review_verdict text check (review_verdict in ('accept', 'fix_required', 'reject')),
  final_state text check (final_state in ('done', 'failed', 'abandoned', 'superseded')),

  failure_code text,
  failure_fingerprint text,
  loop_verdict text,
  workspace_clean boolean,
  path_violations integer,
  tokens_prompt integer,
  tokens_completion integer,
  files_changed_count integer,
  tests_passed integer,
  tests_failed integer,
  duration_ms bigint,

  -- A killed run must not wear the shape of a clean finish. The result envelope
  -- refuses this in JavaScript; the table refuses it for every future caller.
  constraint exit_code_only_on_exited
    check (exit_code is null or ending = 'exited'),

  -- A finished attempt says how it ended. A running one has not.
  constraint finished_rows_are_complete
    check (
      (state = 'running' and finished_at is null and ending is null)
      or (state = 'finished' and finished_at is not null and ending is not null)
    ),

  unique (task_id, attempt_no)
);

create index if not exists attempts_task_idx on agentbridge.attempts (task_id, attempt_no desc);
create index if not exists attempts_unfinished_idx
  on agentbridge.attempts (last_progress_at)
  where state = 'running';

-- The disagreement is the thing worth finding fast, so it gets its own index:
-- the agent said yes and the machine said no.
create index if not exists attempts_false_done_idx
  on agentbridge.attempts (finished_at desc)
  where agent_claimed_success and verification_verdict = 'rejected';

alter table agentbridge.attempts enable row level security;
grant select, insert, update on agentbridge.attempts to service_role;

-- ═══ THE STEP JOURNAL ═══
--
-- Recovery asks WHICH DURABLE STEP ACTUALLY FINISHED, and never infers the
-- recovery point from logs. A log line saying "verifying" proves a process
-- reached a println, not that verification completed.

create table if not exists agentbridge.attempt_steps (
  step_id bigserial primary key,
  schema_version integer not null default 1,
  attempt_id text not null references agentbridge.attempts (attempt_id) on delete cascade,
  kind text not null check (kind in (
    'CLAIM', 'PREPARE_WORKSPACE', 'COMPILE_CONTEXT', 'START_EXECUTOR', 'AGENT_RUN',
    'COLLECT_RESULT', 'VERIFY', 'PUBLISH_ARTIFACTS', 'REQUEST_REVIEW', 'REVIEW',
    'ACCEPT_OR_REJECT', 'CLEANUP'
  )),
  status text not null check (status in ('started', 'finished', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  input_digest text check (input_digest ~ '^[0-9a-f]{64}$'),
  output_digest text check (output_digest ~ '^[0-9a-f]{64}$'),
  error_code text,
  retryable boolean,
  executor_version text,
  runtime_version text,
  policy_revision text,

  -- A step that claims to have finished without a finishing time looks complete
  -- and cannot be ordered against the step after it, which is precisely what
  -- breaks recovery.
  constraint ended_steps_have_an_end
    check ((status = 'started' and finished_at is null) or (status <> 'started' and finished_at is not null))
);

create index if not exists attempt_steps_attempt_idx
  on agentbridge.attempt_steps (attempt_id, started_at);

alter table agentbridge.attempt_steps enable row level security;
grant select, insert, update on agentbridge.attempt_steps to service_role;
grant usage, select on sequence agentbridge.attempt_steps_step_id_seq to service_role;

-- ═══ PUBLIC VIEWS, EXPLICIT COLUMN LISTS ═══

create or replace view public.attempts with (security_invoker = true) as
select
  attempt_id, schema_version, task_id, attempt_no, state,
  engine, model, role_profile, worker_slot_id, session_id, lease_id, fence_token,
  repo, base_sha, task_class, risk_class, environment_digest,
  workspace_id, runtime_version, executor_version, policy_revision,
  tool_schema_revision, context_digest, retry_of_attempt_id,
  started_at, last_progress_at, finished_at,
  ending, exit_code, result_sha, result_envelope_digest, raw_output_ref,
  agent_claimed_success, verification_verdict, review_verdict, final_state,
  failure_code, failure_fingerprint, loop_verdict, workspace_clean,
  path_violations, tokens_prompt, tokens_completion, files_changed_count,
  tests_passed, tests_failed, duration_ms
from agentbridge.attempts;

grant select, insert, update on public.attempts to service_role;

create or replace view public.attempt_steps with (security_invoker = true) as
select
  step_id, schema_version, attempt_id, kind, status,
  started_at, finished_at, input_digest, output_digest,
  error_code, retryable, executor_version, runtime_version, policy_revision
from agentbridge.attempt_steps;

grant select, insert, update on public.attempt_steps to service_role;
