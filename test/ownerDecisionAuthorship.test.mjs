/**
 * NOBODY MAY RECORD A DECISION AS SOMEBODY ELSE.
 *
 * THE DEFECT THIS PINS, found by a blind audit 2026-09-18 and verified by
 * reading rather than by exploitation -- demonstrating it live would have forged
 * an owner decision in the operator's real ledger.
 *
 * The hosted recordOwnerDecision built its record with `created_by` taken from
 * the caller's own `owner_id` field. validateDecision refuses a record whose
 * created_by differs from its owner_id -- so forcing them equal meant THAT CHECK
 * COULD NEVER FIRE from that call site, and owner_id was never compared against
 * the authenticated caller. A coordinator token could therefore record, as the
 * owner, a decision granting capabilities ["*"] at bridge scope, after which
 * resolve_owner_decision answers `allowed` for every action with no narrower
 * decision.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than a unit test. The bug lived in
 * supabase/functions/mcp/index.ts, which is Deno-only and cannot be imported.
 * Rule 10 is usually read as "move the logic to src/" -- but this repository
 * already has the other answer, and I only learned it by breaking it: three
 * tests in test/edgeSourceGuards.test.mjs read index.ts AS TEXT and assert on
 * its source. That is a real gate over an unimportable file, and it is what this
 * uses. The logic itself needs no moving: validateDecision was always correct
 * and always tested. What was missing was anything checking that the call site
 * still reached it.
 *
 * COMMENT-BLANKED BEFORE MATCHING, and the reason is immediate rather than
 * theoretical. The fix in index.ts explains itself by QUOTING the defective line
 * it replaced. A gate that grepped the raw file would match that explanation and
 * report the bug present forever after it was fixed -- CLAUDE.md rule 13, which
 * the file records being rediscovered three times in one day. The control test
 * below proves the blanking works by planting the string in a comment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateDecision, createDecision } from '../supabase/functions/mcp/_shared.js';

const INDEX = fileURLToPath(new URL('../supabase/functions/mcp/index.ts', import.meta.url));

/** Source with every comment replaced by whitespace, so prose cannot match. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));
}

const SOURCE = readFileSync(INDEX, 'utf8');
const CODE = codeOnly(SOURCE);

/* ── the decision logic itself, which was always right ──────────────────── */

test('THE POSITIVE FIRST: a decision recorded by the owner is accepted', () => {
  const rec = createDecision({
    decision_id: 'd-t1', owner_id: 'danny', statement: 'ok',
    scope_type: 'bridge', scope_id: null, effect: 'allow',
    capabilities: ['deploy.production'], constraints: {},
    created_by: 'danny', created_at: new Date().toISOString(), supersedes: null,
  });
  assert.equal(validateDecision(rec).ok, true, validateDecision(rec).errors?.join('; '));
});

test('THE CHECK THAT COULD NEVER FIRE: a recorder who is not the owner is refused', () => {
  /*
   * This assertion passed before the fix and proved nothing, because no call
   * site could produce the input. It is the reachability that changed, not the
   * rule.
   */
  const rec = createDecision({
    decision_id: 'd-t2', owner_id: 'danny', statement: 'ok',
    scope_type: 'bridge', scope_id: null, effect: 'allow',
    capabilities: ['*'], constraints: {},
    created_by: 'code-b', created_at: new Date().toISOString(), supersedes: null,
  });
  const v = validateDecision(rec);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => /cannot record a decision on the owner's behalf/.test(e)),
    `expected the authorship refusal, got: ${v.errors.join('; ')}`,
  );
  // It NAMES both parties, so a refusal is actionable rather than a dead end.
  assert.ok(v.errors.some((e) => e.includes('code-b') && e.includes('danny')));
});

/* ── the call site, checked as text because it cannot be imported ───────── */

test('THE WIRING: index.ts must not take created_by from the caller payload', () => {
  /*
   * The exact defect. Any spelling that sources created_by from the request
   * body re-opens it, so this matches the SHAPE -- created_by assigned from a
   * property of the arguments object -- rather than one literal.
   */
  const fromPayload = /created_by\s*:\s*[A-Za-z_$][\w$]*\s*\.\s*owner_id/;
  assert.ok(
    !fromPayload.test(CODE),
    'created_by is being read from the caller payload; the authorship check cannot fire',
  );
});

test('THE WIRING: index.ts records the AUTHENTICATED label as created_by', () => {
  // The positive half. Absence of the bad spelling is not presence of the good
  // one -- a refactor that dropped created_by entirely would pass the test above.
  assert.match(CODE, /created_by\s*:\s*label\b/,
    'created_by must be the authenticated token label');
});

test('THE CONTROL: both wiring gates can actually fail', () => {
  /*
   * CLAUDE.md rule 1, and the reason edgeSourceGuards pairs every source gate
   * with one of these: a grep over a file that no longer contains the string is
   * green whether the property holds or the file was renamed out from under it.
   */
  const reintroduced = codeOnly('const rec = createDecision({ created_by: d.owner_id });');
  assert.ok(/created_by\s*:\s*[A-Za-z_$][\w$]*\s*\.\s*owner_id/.test(reintroduced),
    'the defect matcher does not match the defect');

  const dropped = codeOnly('const rec = createDecision({ decision_id: d.decision_id });');
  assert.ok(!/created_by\s*:\s*label\b/.test(dropped),
    'the presence matcher passes a source with no created_by at all');
});

test('THE CONTROL: comment-blanking works, or the gate matches its own prose', () => {
  /*
   * MEASURED ON A SYNTHETIC FIXTURE, NOT ON THE REAL FILE, and that separation
   * is the point. An earlier version of this asserted that CODE does not contain
   * the defective spelling -- which is word-for-word what the wiring gate above
   * asserts. So when the defect was genuinely reintroduced, this "control"
   * failed too, and could not distinguish "blanking is broken" from "the bug is
   * back". Two assertions, one property, and the one that fires tells you the
   * wrong thing: CLAUDE.md rule 14.
   *
   * The precondition below still reads the real file, because the hazard is real
   * -- the fix explains itself by QUOTING the line it replaced, so index.ts DOES
   * contain the defective spelling in prose. Without blanking, the wiring gate
   * would fail forever on a correct file. But whether blanking WORKS is proven
   * against strings this test owns.
   */
  assert.match(SOURCE, /created_by\s*:\s*d\.owner_id/,
    'precondition: the explanation in index.ts still quotes the old line, '
    + 'so blanking is load-bearing rather than decorative');

  const commentOnly = codeOnly('/* it used to read created_by: d.owner_id here */');
  assert.ok(!/created_by\s*:\s*d\.owner_id/.test(commentOnly),
    'comment-blanking failed: prose is being read as code');

  const lineComment = codeOnly('// created_by: d.owner_id\n');
  assert.ok(!/created_by\s*:\s*d\.owner_id/.test(lineComment),
    'line comments must be blanked too');

  // And blanking must not eat real code that merely follows a comment.
  const mixed = codeOnly('/* created_by: d.owner_id */\nconst x = { created_by: label };');
  assert.match(mixed, /created_by\s*:\s*label\b/, 'blanking ate real code');
  assert.ok(!/created_by\s*:\s*d\.owner_id/.test(mixed));

  // A URL is not a line comment; blanking must not swallow the rest of the line.
  assert.match(codeOnly('const u = "https://x.test/a"; const y = { created_by: label };'),
    /created_by\s*:\s*label\b/, 'a double slash inside a string was treated as a comment');
});
