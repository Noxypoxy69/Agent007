/**
 * ONLY AN OWNER TOKEN MAY RECORD AN OWNER DECISION.
 *
 * THE PROBLEM THIS CLOSES. `f7ae118` anchored owner decisions so `owner_id`
 * must name the ACTUAL owner, and `index.ts` binds `created_by` to the
 * authenticated token label. Measured against the live database on 2026-09-18,
 * the entire coordinator table is one row labelled `chatgpt-work coordinator` —
 * so once the anchor deploys, `record_owner_decision` refuses EVERYONE
 * including Danny, and `settleOpenRequestsAgainstPolicy` goes with it. That is
 * rule 15: a client sending a credential it cannot acquire.
 *
 * AND RELABELLING THAT TOKEN IS NOT THE FIX. CLAUDE.md records that the OAuth
 * consent page hands out THE COORDINATOR TOKEN for a write grant, so relabelling
 * it to an owner spelling would let every write-scoped remote connector record
 * rulings as the owner. Two secrets exist precisely so that "this client may
 * direct my agents" is not the credential that means "this client may decide
 * for me".
 *
 * READ AS TEXT, because `index.ts` is Deno-only and cannot be imported by the
 * suite (rule 10) — the same treatment `edgeSourceGuards` and
 * `ownerDecisionAuthorship` already give it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = fs.readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');

/** Rule 13 — the route's own comments name every token table this searches for. */
const CODE = RAW
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

test('THE POSITIVE FIRST: the owner scope exists and is resolved from its own table', () => {
  /*
   * Rule 5. Every "a coordinator cannot" assertion below passes against a file
   * with no owner scope at all — which is the state this commit changes.
   */
  assert.match(CODE, /tokenLabel\(\s*['"]owner_tokens['"]/,
    'nothing authenticates against owner_tokens, so the owner scope cannot exist');
  assert.match(CODE, /scope\s*=\s*['"]owner['"]/, 'the owner scope is never assigned');
  assert.match(CODE, /coordinatorStore\(\s*label\s*,\s*\{\s*owner:\s*true/,
    'the owner scope does not build a store that carries the ledger');
});

test('THE ORDER IS OWNER, COORDINATOR, READER — each a superset of the next', () => {
  /*
   * Checked as ORDER rather than presence: if reader were tested first, an
   * owner token that also happened to be in reader_tokens would resolve to the
   * weaker scope and silently lose the ledger.
   */
  const owner = CODE.indexOf("tokenLabel('owner_tokens'");
  const coord = CODE.indexOf("tokenLabel('coordinator_tokens'");
  const reader = CODE.indexOf("tokenLabel('reader_tokens'");
  assert.ok(owner !== -1 && coord !== -1 && reader !== -1, 'a token table is missing from resolution');
  assert.ok(owner < coord, 'coordinator is checked before owner — an owner would resolve to the weaker scope');
  assert.ok(coord < reader, 'reader is checked before coordinator');
});

test('A COORDINATOR TOKEN DOES NOT CARRY recordOwnerDecision', () => {
  /*
   * SCOPE DECIDES WHICH TOOLS EXIST, NOT WHICH ONES REFUSE. toolDefs builds
   * record_owner_decision only when the store carries the method, so removing
   * it means the tool is ABSENT from tools/list and the caller gets -32602
   * no-such-tool. A refusal string is something a model argues with; a missing
   * tool is not.
   */
  assert.match(CODE, /if\s*\(\s*!owner\s*\)\s*delete\s+store\.recordOwnerDecision/,
    'the coordinator store still carries recordOwnerDecision, so every write-scoped '
    + 'connector holding that token can reach the decision ledger');
});

test('created_by IS STILL THE AUTHENTICATED LABEL, not the payload', () => {
  /*
   * The defect this file's subject was born from: record_owner_decision shipped
   * with `created_by: d.owner_id`, so the payload supplied both sides of its own
   * authorship check and the check could never fire. Narrowing the scope must
   * not quietly undo the binding.
   */
  assert.match(CODE, /created_by:\s*label\b/, 'created_by is no longer bound to the token label');
  assert.equal(/created_by:\s*d\.[A-Za-z_$][\w$]*/.exec(CODE), null,
    'created_by is taken from the caller payload again');
});

test('THE OWNER TABLE IS CREATED EMPTY AND GRANTS NOBODY ANYTHING', () => {
  /*
   * The reason this was safe to write before the owner had decided anything: an
   * empty token table authenticates no one, so applying the migration changes
   * no behaviour at all. The authority arrives when a row is minted, and not
   * before.
   */
  const sql = fs.readFileSync(
    path.join(REPO, 'supabase/migrations/20260919020000_an_owner_token_class_so_the_owner_can_speak.sql'),
    'utf8',
  );
  assert.match(sql, /create table if not exists agentbridge\.owner_tokens/, 'the table is not created');
  assert.equal(/insert\s+into\s+agentbridge\.owner_tokens/i.exec(sql), null,
    'the migration mints a token — authority must arrive by the owner minting a row, not by a migration');

  /*
   * A token table anon can read is the whole system. Every sibling table has
   * RLS on with no policy, so the service role bypasses it and nothing else
   * gets in.
   */
  assert.match(sql, /enable row level security/, 'RLS is not enabled on a credential table');
  assert.match(sql, /revoke all on agentbridge\.owner_tokens from anon, authenticated/,
    'anon and authenticated are not revoked on a credential table');
  assert.equal(/create\s+(or replace\s+)?view\s+public\.owner_tokens/i.exec(sql), null,
    'a public view over a credential table would turn a PostgREST misconfiguration into a compromise');
});

test('THE CONTROL: comment-blanking really removed the prose', () => {
  /*
   * Every token table name appears in the explanatory comments above the code
   * that uses it. If blanking failed, each assertion here would be reading
   * documentation rather than behaviour — rule 13, rediscovered five times in
   * this repository.
   */
  assert.match(RAW, /promotion by typo/, 'the explanatory comment is gone; update this control');
  assert.ok(!/promotion by typo/.test(CODE),
    'comment-blanking did not remove the prose — the matches above may all be comments');
});
