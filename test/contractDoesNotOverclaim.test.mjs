/**
 * THE CONTRACT MUST NOT CALL SELF-REPORTED DATA "OBSERVED".
 *
 * WHY THIS EXISTS. The PREAMBLE handed to every connecting client said:
 *
 *   "Every field is observed from git plumbing and the process table on the
 *    developer machine, not reported by the agents themselves, so an agent
 *    cannot misreport its own state here."
 *
 * True of the node collector. FALSE of the hosted surface, which projects
 * identity and placement straight out of `session_registrations` — a table
 * `index.ts` itself describes as "populated entirely from the POST /register
 * body", stamped `runtime-self-registration`. Those are exactly the fields an
 * agent would want to lie about: which lane it is in, which worktree it holds,
 * whether it has capacity.
 *
 * That is worse than saying nothing. A reader told "an agent cannot misreport
 * its own state here" stops applying the scepticism that would catch the lie.
 *
 * WHY A WORDING CHECK WOULD BE HOLLOW. Asserting the paragraph contains some
 * phrase pins prose, and prose can be true or false with identical wording once
 * the projection underneath it changes — that is hollow gate 2, a check
 * agreeing with itself. So this derives the self-reported fields FROM
 * `index.ts` and asserts the contract does not describe THOSE as observed. If
 * somebody adds a ninth self-reported field, this fails until the contract
 * mentions it.
 *
 * index.ts is Deno-only and cannot be imported (CLAUDE.md rule 10), so it is
 * read as text — the same way test/edgeSourceGuards and
 * test/ownerDecisionAuthorship already treat it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTRUCTIONS as TWIN } from '../mcp/toolDefs.mjs';
import { INSTRUCTIONS as HOSTED } from '../supabase/functions/mcp/_shared.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = fs.readFileSync(path.join(REPO, 'supabase/functions/mcp/index.ts'), 'utf8');

/**
 * COMMENT-BLANK BEFORE MATCHING ANYTHING — CLAUDE.md rule 13, rediscovered
 * independently three times in this repository.
 *
 * The block comment inside this very projection quotes the old contract
 * sentence verbatim and names every field. A check that matched raw source
 * would read that explanation as if it were code and pass while the projection
 * said something else entirely.
 *
 * Replaces comment bytes with spaces rather than deleting them, so offsets and
 * line numbers survive for anything that reports them.
 */
const blankComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, ' '));

const CODE = blankComments(INDEX);

test('THE POSITIVE FIRST: the self-reported projection is still there to find', () => {
  /*
   * Rule 5. Every assertion below passes vacuously if the extraction finds
   * nothing — a renamed table or a refactor would silently empty this gate.
   */
  assert.ok(CODE.includes('session_registrations'),
    'session_registrations is gone from index.ts; this gate is measuring nothing');
  assert.ok(/verification_state/.test(CODE) || /runtime-self-registration/.test(INDEX),
    'the self-registration marker is gone; check whether this data is still self-reported');
});

/**
 * The fields the hosted surface hands out straight from the registration row.
 *
 * DERIVED, NOT TYPED: taken from the `rows.map((r) => ({ ... }))` that follows
 * the `session_registrations?select=*` read, keeping only keys whose value
 * comes from `r.` — the registration row itself. A key computed from anything
 * else is not self-reported and is deliberately excluded.
 */
/**
 * COLUMNS ON THE REGISTRATION ROW THAT THE AGENT DOES NOT SUPPLY.
 *
 * "Comes off `r.`" is a good proxy for self-reported and it is not a perfect
 * one. `last_seen_at` lives on the same row but the agent never sends it: the
 * server stamps it in `touchLiveness` on the /task, /return, /wait and /review
 * routes. Calling it self-reported in the contract would be a NEW false
 * statement in the paragraph this gate exists to keep true, so it is excluded
 * here rather than described there.
 *
 * AN ENTRY HERE IS A CLAIM THAT NEEDS A REASON, not a way to silence a failure.
 * The list may only shrink without argument; adding to it means asserting the
 * server writes that column, which the next reader can go and check.
 */
const SERVER_STAMPED = Object.freeze(['lastSeenAt']);

function selfReportedFields() {
  /*
   * ANCHORED ON THE PROJECTION, NOT ON THE TABLE NAME.
   *
   * The first version searched for the first `session_registrations?select=*`
   * and read the next few thousand characters. index.ts reads that table in at
   * least five places and the first is not the projection, so the window landed
   * on unrelated code and the extraction came back EMPTY — which the
   * "found a real set" assertion caught rather than passing over.
   *
   * `rows.map((r) => ({ ... }))` is the shape that actually hands registration
   * columns to a caller, so that is what this looks for.
   */
  const m = /rows\s*\.\s*map\s*\(\s*\(\s*r\s*\)\s*=>\s*\(\s*\{/.exec(CODE);
  assert.ok(m, 'could not locate the registration projection (rows.map) in index.ts');
  const after = CODE.slice(m.index, m.index + 4000);
  const out = new Set();
  for (const hit of after.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*r\.[A-Za-z_][A-Za-z0-9_]*/g)) {
    out.add(hit[1]);
  }
  for (const k of SERVER_STAMPED) out.delete(k);
  return [...out];
}

const SELF_REPORTED = selfReportedFields();

test('THE EXTRACTION FOUND A REAL SET, not an empty one', () => {
  assert.ok(SELF_REPORTED.length >= 4,
    `only found ${SELF_REPORTED.length} self-reported fields (${SELF_REPORTED.join(', ')}); `
    + 'the extraction has probably broken and this gate would pass over anything');
});

for (const [name, text] of [['twin', TWIN], ['hosted', HOSTED]]) {
  test(`${name}: THE CONTRACT DOES NOT CLAIM EVERY FIELD IS OBSERVED`, () => {
    /*
     * The specific overclaim, stated as the property rather than the wording:
     * a blanket "every field is observed / cannot be misreported" is false while
     * ANY field is self-reported, whatever words carry it.
     */
    assert.ok(SELF_REPORTED.length > 0, 'nothing is self-reported, so this gate should be deleted');
    assert.ok(
      !/every field is observed/i.test(text),
      `${name}: the contract still tells every client that EVERY field is observed, while `
      + `index.ts serves ${SELF_REPORTED.length} fields straight from the POST /register body `
      + `(${SELF_REPORTED.join(', ')})`,
    );
    assert.ok(
      !/an agent cannot misreport its own state here/i.test(text),
      `${name}: the contract still promises an agent cannot misreport its own state, which is `
      + 'the sentence that stops a reader being sceptical about exactly the fields it should be',
    );
  });

  test(`${name}: THE CONTRACT SAYS WHICH FIELDS ARE SELF-REPORTED`, () => {
    /*
     * Not enough to drop the false claim — silence would also pass that. A
     * reader has to be able to weigh a field by where it came from, so the
     * self-reported ones must be named.
     */
    assert.match(text, /self-reported/i,
      `${name}: the contract never tells a reader that anything is self-reported`);

    const missing = SELF_REPORTED.filter((f) => {
      // camelCase in code, prose in the contract: match the words, not the identifier.
      const words = f.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
      const head = words.split(' ')[0];
      return !text.toLowerCase().includes(words) && !text.toLowerCase().includes(head);
    });
    assert.deepEqual(missing, [],
      `${name}: these fields are served from the registration body and the contract does not `
      + `mention them, so a reader has no way to know they are claims rather than measurements: `
      + `${missing.join(', ')}`);
  });

  test(`${name}: AND IT STILL SAYS WHAT *IS* OBSERVED — the positive half`, () => {
    /*
     * The wrong fix here is to delete the observed-claim entirely and leave a
     * contract that vouches for nothing. The git and process facts genuinely
     * ARE observed, and that is the server's whole value; a reader who stops
     * trusting a HEAD because the paragraph went vague is worse off.
     */
    assert.match(text, /observed/i, `${name}: nothing is described as observed any more`);
    assert.match(text, /null/i, `${name}: the null-is-unknown clause was lost`);
  });
}

test('BOTH SURFACES CARRY THE SAME CONTRACT', () => {
  assert.equal(TWIN, HOSTED, 'the contract has forked between the two transports');
});

test('THE CONTROL: the overclaim check can actually fail', () => {
  /*
   * Rule 1. Pins that the matcher would catch the sentence it exists to catch —
   * otherwise a typo in the regex makes every assertion above vacuous and the
   * old claim could come straight back.
   */
  const OLD = 'Live engineering state. Every field is observed from git plumbing and the '
    + 'process table, so an agent cannot misreport its own state here.';
  assert.ok(/every field is observed/i.test(OLD), 'the overclaim matcher is inert');
  assert.ok(/an agent cannot misreport its own state here/i.test(OLD), 'the promise matcher is inert');
  assert.ok(!/self-reported/i.test(OLD), 'the self-reported matcher would pass the old text');
});

test('EVERY SERVER-STAMPED EXCLUSION IS STILL A REAL COLUMN', () => {
  /*
   * A stale exclusion is worse than none: it silences a field nobody is
   * checking any more and reads as coverage. Same rule toolDefsParity applies
   * to its DECLARED list — it may only shrink.
   */
  for (const k of SERVER_STAMPED) {
    const col = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    assert.ok(CODE.includes(`r.${col}`),
      `${k} is excluded as server-stamped but index.ts no longer projects r.${col}; `
      + 'drop the exclusion rather than leaving it to rot');
  }
  assert.ok(/touchLiveness/.test(CODE),
    'touchLiveness is gone from index.ts — the reason lastSeenAt is excluded no longer holds');
});

test('THE CONTROL: comment-blanking really removed the explanation', () => {
  /*
   * The projection's own comment quotes the old sentence. If blanking failed,
   * this gate would be reading prose as code — the exact trap rule 13 names.
   */
  assert.ok(/every field is observed/i.test(INDEX),
    'the raw source no longer quotes the old claim; this control needs updating');
  assert.ok(!/every field is observed/i.test(CODE),
    'comment-blanking did not remove the quoted claim from index.ts — matches here are prose');
});
