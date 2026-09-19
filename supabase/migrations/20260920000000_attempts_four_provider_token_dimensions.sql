-- F4: agentbridge.attempts gains the four provider usage columns the record
-- already produces, and public.attempts projects them.
--
-- WHY. src/attemptRecord.mjs has emitted tokensCacheRead, tokensCacheCreation,
-- usageObserved and usageSource since a1e6e2d. The table has tokens_prompt and
-- tokens_completion and nothing else, so every finished row currently drops
-- four fields on the floor. Measured 2026-09-20: agentbridge.attempts holds 0
-- rows, so nothing existing is affected either way.
--
-- FOUR DIMENSIONS, NEVER MERGED. Cache read and cache creation are their own
-- columns and are not folded into input. The record's own header is explicit
-- that null is NOT OBSERVED and 0 is a real observed zero, which is why
-- usage_observed exists as a separate boolean: a row of nulls must read as "the
-- provider reported nothing", not as "this attempt was free". usage_source
-- names where the numbers came from, so a backfilled figure and a live one are
-- never confused.
--
-- ═══ CREATE OR REPLACE, NOT DROP, AND THAT IS THE WHOLE SAFETY ARGUMENT ═══
--
-- public.attempts is a VIEW over this table with an EXPLICIT COLUMN LIST, so
-- adding a column to the base table does not surface it through PostgREST --
-- that mismatch is the PGRST204 outage CLAUDE.md already records for
-- public.tasks.
--
-- The obvious repair is DROP VIEW + CREATE VIEW. It must not be used here.
-- DROP takes the object's ACL with it, and pg_default_acl for schema public on
-- this project grants ALL to anon and authenticated on every NEW relation -- so
-- a recreated view comes back with grants two earlier migrations
-- (20260915133357 and 20260916180034) issued deliberately to remove. A blind
-- audit caught exactly that shape in a proposed tasks-view migration.
--
-- Because these four columns are APPENDED and nothing is reordered or removed,
-- CREATE OR REPLACE VIEW is legal here. It preserves the ACL and the
-- reloptions, so no grant is restated and none can be silently restored. If a
-- future change needs to reorder or drop a column, it cannot use this pattern
-- and must restate the revokes explicitly.
--
-- security_invoker=true is preserved by REPLACE and is restated below anyway,
-- because a view that runs as owner bypasses RLS and this one projects a table
-- whose RLS is the only thing standing between anon and the rows.
--
-- REVERSIBLE. Dropping four nullable columns and replacing the view restores
-- the previous state exactly; there is no data to lose at 0 rows.
--
-- NOT ADDRESSED HERE, AND REPORTED INSTEAD: public.attempts and
-- public.attempt_steps currently grant arwdDxtm -- including INSERT, UPDATE,
-- DELETE and TRUNCATE -- to anon and authenticated. security_invoker plus RLS
-- on agentbridge.attempts is what actually refuses them today, so this is
-- defence in depth that was never applied to these two views rather than a live
-- hole. Changing a grant is a security-posture decision and is the owner's, so
-- it is written down and left alone by this migration.

alter table agentbridge.attempts
  add column if not exists tokens_cache_read integer,
  add column if not exists tokens_cache_creation integer,
  add column if not exists usage_observed boolean,
  add column if not exists usage_source text;

comment on column agentbridge.attempts.tokens_cache_read is
  'Provider cache-read tokens. Its own dimension, never folded into tokens_prompt. NULL means not observed; 0 means an observed zero.';
comment on column agentbridge.attempts.tokens_cache_creation is
  'Provider cache-creation tokens. Its own dimension, never folded into tokens_prompt. NULL means not observed; 0 means an observed zero.';
comment on column agentbridge.attempts.usage_observed is
  'Did the provider report ANY usage for this attempt. Without it a row of NULL token columns is indistinguishable from an attempt that genuinely cost nothing.';
comment on column agentbridge.attempts.usage_source is
  'Where the numbers came from, so a backfilled figure and a live provider reading are never read as the same evidence.';

create or replace view public.attempts
with (security_invoker = true) as
  select attempt_id,
    schema_version,
    task_id,
    attempt_no,
    state,
    engine,
    model,
    role_profile,
    worker_slot_id,
    session_id,
    lease_id,
    fence_token,
    repo,
    base_sha,
    task_class,
    risk_class,
    environment_digest,
    workspace_id,
    runtime_version,
    executor_version,
    policy_revision,
    tool_schema_revision,
    context_digest,
    retry_of_attempt_id,
    started_at,
    last_progress_at,
    finished_at,
    ending,
    exit_code,
    result_sha,
    result_envelope_digest,
    raw_output_ref,
    agent_claimed_success,
    verification_verdict,
    review_verdict,
    final_state,
    failure_code,
    failure_fingerprint,
    loop_verdict,
    workspace_clean,
    path_violations,
    tokens_prompt,
    tokens_completion,
    files_changed_count,
    tests_passed,
    tests_failed,
    duration_ms,
    -- APPENDED, which is what makes CREATE OR REPLACE legal. See the header.
    tokens_cache_read,
    tokens_cache_creation,
    usage_observed,
    usage_source
  from agentbridge.attempts;
