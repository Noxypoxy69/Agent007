import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentId, sameSession, SOURCE, SAFE_ID } from '../src/watcherIdentity.mjs';

/**
 * THE CASE THIS EXISTS FOR, TAKEN FROM THE LIVE STORE.
 *
 * SHAPE copied from %USERPROFILE%\.agentbridge\registrations.json, VALUES NOT.
 * Trimmed to the fields that decide anything. Three agents have registered in
 * the Agent007 worktree -- which is what makes the ambiguous case REAL here
 * rather than invented, and it is why sole-occupant must refuse on this machine.
 *
 * THE OPERATOR'S NAME AND MACHINE ID ARE NOT COMMITTED, and the first version of
 * this file committed both. `test/leakRegression.test.mjs` scans src, test,
 * scripts, bin, docs and root markdown for exactly that, and it caught this --
 * in an audit clone first, then locally, so it is a defect and not an
 * environment finding. This repository is on GitHub; a home directory names the
 * operator and a session id built from a first name does the same.
 *
 * WHAT HAD TO SURVIVE THE SCRUB, because the fixture is worthless otherwise:
 * the row SHAPE, the three-occupant ambiguity, one agent holding two sessions,
 * a second repo whose rows must be filtered out, and a session id stored
 * WITHOUT the `claude-` prefix. Those are the properties the resolver decides
 * on. A name is not one of them.
 */
const MACHINE = 'machine-0000-fixture-0000-000000000000';
const LIVE_ROWS = [
  { agent_id: 'probe-bug-a', session_id: 'bugA-watch', repo_id: 'agentbridge', worktree_id: 'agentbridge', machine_id: MACHINE },
  { agent_id: 'fixer', session_id: 'claude-probe-watcher-4', repo_id: 'Agent007', worktree_id: 'Agent007', machine_id: MACHINE },
  { agent_id: 'code-a', session_id: 'code-a-62f8283a', repo_id: 'Agent007', worktree_id: 'Agent007', machine_id: MACHINE },
  { agent_id: 'code-c', session_id: 'op-win-10', repo_id: 'agentbridge', worktree_id: 'agentbridge', machine_id: MACHINE },
  { agent_id: 'code-b', session_id: 'op-win-b-live', repo_id: 'Agent007', worktree_id: 'Agent007', machine_id: MACHINE },
  { agent_id: 'fixer', session_id: 'op-win-fixer', repo_id: 'Agent007', worktree_id: 'Agent007', machine_id: MACHINE },
  { agent_id: 'code-b', session_id: 'session_01Y8egWiyweM7m64nvHVeFoy', repo_id: 'Agent007', worktree_id: 'Agent007', machine_id: MACHINE },
];

const here = (over = {}) => ({
  registrations: LIVE_ROWS, repoId: 'Agent007', worktreeId: 'Agent007', machineId: MACHINE, ...over,
});

test('THE REGRESSION: a session that registered before is resolved, not refused', () => {
  /*
   * Measured 2026-09-21: this exact session id sits in the live store as
   * code-b, while AGENTBRIDGE_AGENT_ID was empty and the watcher declined. The
   * evidence to resolve it was on disk the whole time.
   *
   * Note the id is stored WITHOUT the claude- prefix while the hook builds one
   * WITH it -- so this also pins the normalisation, which is the part that
   * makes the lookup hit at all.
   */
  const r = resolveAgentId(here({ env: {}, sessionId: 'claude-session_01Y8egWiyweM7m64nvHVeFoy' }));
  assert.equal(r.agentId, 'code-b');
  assert.equal(r.source, SOURCE.THIS_SESSION);
  assert.match(r.why, /its own earlier declaration/);
});

test('THE POSITIVE FIRST: the declared variable still wins and still short-circuits', () => {
  /*
   * Rule 5. Every refusal below is worthless unless the ordinary path works,
   * and this must beat the store rather than be overridden by it.
   */
  const r = resolveAgentId(here({ env: { AGENTBRIDGE_AGENT_ID: 'code-d' }, sessionId: 'claude-session_01Y8egWiyweM7m64nvHVeFoy' }));
  assert.equal(r.agentId, 'code-d', 'the store overrode an explicitly declared id');
  assert.equal(r.source, SOURCE.DECLARED);
});

test('AN UNKNOWN SESSION IN A SHARED WORKTREE REFUSES, AND NAMES WHO IS THERE', () => {
  /*
   * The whole safety argument. Agent007 has hosted code-a, code-b and fixer,
   * so "who is this" has no answer and inventing one puts a name on the roster
   * that assign_task routes real work by.
   */
  const r = resolveAgentId(here({ env: {}, sessionId: 'claude-brand-new-session' }));
  assert.equal(r.agentId, null, 'an unknown session in a shared worktree was given an identity');
  assert.deepEqual(r.candidates, ['code-a', 'code-b', 'fixer']);
  assert.match(r.why, /cannot be established/);
});

test('sole-occupant resolves ONLY when there is genuinely one', () => {
  const solo = [
    { agent_id: 'code-q', session_id: 's1', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE },
    { agent_id: 'code-q', session_id: 's2', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE },
  ];
  const r = resolveAgentId({ env: {}, sessionId: 'unseen', registrations: solo, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, 'code-q');
  assert.equal(r.source, SOURCE.SOLE_OCCUPANT);

  // and a second agent in the same worktree removes that answer
  const two = [...solo, { agent_id: 'code-r', session_id: 's3', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE }];
  const r2 = resolveAgentId({ env: {}, sessionId: 'unseen', registrations: two, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r2.agentId, null, 'two occupants still produced an identity');
  assert.deepEqual(r2.candidates, ['code-q', 'code-r']);
});

test('ANOTHER MACHINE CANNOT LEND THIS SESSION AN IDENTITY', () => {
  /*
   * Registrations are shared state. Without this, a session here could adopt an
   * agent that has only ever run on a different machine -- identity theft
   * across machines, using our own store as the source.
   *
   * Differenced against the SAME row with the machine corrected, so the
   * assertion cannot pass because something else refused.
   */
  const foreign = [{ agent_id: 'code-z', session_id: 'mine', repo_id: 'R', worktree_id: 'W', machine_id: 'OTHER-MACHINE' }];
  const bad = resolveAgentId({ env: {}, sessionId: 'mine', registrations: foreign, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(bad.agentId, null, 'a row from another machine resolved an identity');

  const fixed = [{ ...foreign[0], machine_id: MACHINE }];
  const good = resolveAgentId({ env: {}, sessionId: 'mine', registrations: fixed, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(good.agentId, 'code-z', 'the same row with our machine id did not resolve, so the test proves nothing');
});

test('ANOTHER WORKTREE CANNOT LEND THIS SESSION AN IDENTITY EITHER', () => {
  const elsewhere = [{ agent_id: 'code-y', session_id: 'mine', repo_id: 'R', worktree_id: 'OTHER', machine_id: MACHINE }];
  const bad = resolveAgentId({ env: {}, sessionId: 'mine', registrations: elsewhere, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(bad.agentId, null, 'a row from another worktree resolved an identity');

  const good = resolveAgentId({
    env: {}, sessionId: 'mine', registrations: [{ ...elsewhere[0], worktree_id: 'W' }],
    repoId: 'R', worktreeId: 'W', machineId: MACHINE,
  });
  assert.equal(good.agentId, 'code-y', 'the differenced control did not resolve');
});

test('ONE SESSION ID NAMING TWO AGENTS REFUSES RATHER THAN PICKING', () => {
  /*
   * The store disagreeing with itself is not a tie to be broken. Either answer
   * is a coin-flip on the roster.
   */
  const conflict = [
    { agent_id: 'code-a', session_id: 'dup', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE },
    { agent_id: 'code-b', session_id: 'dup', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE },
  ];
  const r = resolveAgentId({ env: {}, sessionId: 'dup', registrations: conflict, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, null);
  assert.deepEqual(r.candidates, ['code-a', 'code-b']);
  assert.match(r.why, /different agents/);
});

test('AN UNSAFE ID IS REFUSED FROM EVERY SOURCE, NOT SANITISED', () => {
  /*
   * Rule 7, generated from the real list rather than three hand-picked strings,
   * so adding a hostile spelling extends the coverage without anybody
   * remembering to. The id becomes a filename and an argv downstream.
   */
  const hostile = ['../../etc/passwd', 'a b', '-rf', '', '   ', 'x/y', 'a;rm', '.hidden', 'a'.repeat(200)];
  for (const id of hostile) {
    const fromEnv = resolveAgentId(here({ env: { AGENTBRIDGE_AGENT_ID: id }, sessionId: 'claude-x' }));
    assert.equal(fromEnv.agentId, null, `AGENTBRIDGE_AGENT_ID=${JSON.stringify(id)} was accepted`);

    const fromStore = resolveAgentId({
      env: {}, sessionId: 'mine', repoId: 'R', worktreeId: 'W', machineId: MACHINE,
      registrations: [{ agent_id: id, session_id: 'mine', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE }],
    });
    assert.equal(fromStore.agentId, null, `a stored agent_id of ${JSON.stringify(id)} was accepted`);
  }
  // the positive, so the loop above is not passing by refusing everything
  assert.ok(SAFE_ID.test('code-b'));
  assert.equal(resolveAgentId(here({ env: { AGENTBRIDGE_AGENT_ID: 'code-b' } })).agentId, 'code-b');
});

test('NO EVIDENCE AT ALL STILL REFUSES, AND SAYS WHAT WOULD FIX IT', () => {
  const r = resolveAgentId({ env: {}, sessionId: 'x', registrations: [], repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, null);
  assert.deepEqual(r.candidates, []);
  assert.match(r.why, /AGENTBRIDGE_AGENT_ID is not set/);
});

test('sameSession strips ONE known prefix and is not a fuzzy match', () => {
  assert.ok(sameSession('claude-abc', 'abc'));
  assert.ok(sameSession('abc', 'claude-abc'));
  assert.ok(sameSession('claude-abc', 'claude-abc'));
  // a prefix relationship is NOT identity
  assert.equal(sameSession('claude-a', 'claude-abc'), false);
  assert.equal(sameSession('abc', 'abcd'), false);
  assert.equal(sameSession(null, null), false, 'two missing ids must not match each other');
  assert.equal(sameSession('', ''), false);
});

test('AN UN-AWAITED STORE READ IS SAID OUT LOUD, NOT READ AS AN EMPTY STORE', () => {
  /*
   * THE REAL DEFECT THIS TEST WAS WRITTEN FOR, found 2026-09-21 by a dry run
   * against the live store minutes after this file went 11/11 green with 9 of 9
   * mutations killed.
   *
   * registrationStore.readRegistrations() is ASYNC. The first wire of this
   * module called it without await, so `registrations` arrived as a Promise.
   * The old line coerced anything non-array to [], which meant every session
   * resolved to "no prior registration" -- a refusal byte-identical to the bug
   * being fixed, against a store that held the answer.
   *
   * Every other test here passes a plain array, which is exactly why none of
   * them could catch it. could-not-read and read-nothing must be
   * distinguishable or the integration failure is invisible.
   */
  const promise = Promise.resolve([]);
  const r = resolveAgentId({ env: {}, sessionId: 'mine', registrations: promise, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, null);
  assert.match(r.why, /not an array/, 'an un-awaited read was reported as an empty store');
  assert.match(r.why, /NOT the same as an empty store/);
  promise.catch(() => {});

  // and a genuinely empty store says something DIFFERENT
  const empty = resolveAgentId({ env: {}, sessionId: 'mine', registrations: [], repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.doesNotMatch(empty.why, /not an array/, 'an empty store and an unreadable one give the same message');
  assert.match(empty.why, /no prior registration/);
});

test('MALFORMED ROWS DO NOT THROW AND DO NOT RESOLVE', () => {
  /*
   * The store is a JSON file several processes append to. A guard that throws
   * on a bad row disables the watcher entirely, which is the outage direction.
   */
  const junk = [null, 'string', 42, {}, { agent_id: null }, { session_id: 'mine' }];
  const r = resolveAgentId({ env: {}, sessionId: 'mine', registrations: junk, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, null);
  assert.equal(resolveAgentId({ registrations: 'not an array' }).agentId, null);
  assert.equal(resolveAgentId().agentId, null, 'called with no arguments at all');
});

test('AN UNVOUCHED ROW MAKES THE ANSWER MORE AMBIGUOUS, NEVER LESS', () => {
  /*
   * THE REGRESSION THE FAIL-OPEN FIX INTRODUCED, taken verbatim from the blind
   * audit that found it. Dropping an unvouched row from the list used to COUNT
   * occupants shrank 2 to 1 and turned a refusal into a confident name, with a
   * `why` that was flatly false: "the only agent ever registered in this
   * worktree".
   *
   * DIFFERENCED THREE WAYS, because the interesting part is that the middle
   * case must refuse while BOTH ends resolve or refuse for their own reasons.
   */
  const q = { agent_id: 'code-q', session_id: 's1', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE };
  const ask = (rows) => resolveAgentId({ env: {}, sessionId: 'unseen', registrations: rows, repoId: 'R', worktreeId: 'W', machineId: MACHINE });

  // POSITIVE CONTROL: genuinely one occupant, fully stated -> resolves.
  assert.equal(ask([q]).agentId, 'code-q', 'the sole fully-stated occupant did not resolve');

  // THE DEFECT: a second occupant that states no machine. It may not lend a
  // name, but it must still make "who is here" unanswerable.
  const silent = { agent_id: 'code-r', session_id: 's3', repo_id: 'R', worktree_id: 'W' };
  const r = ask([q, silent]);
  assert.equal(r.agentId, null,
    'an unvouched second occupant was deleted from the count, turning a refusal into a name');
  assert.deepEqual(r.candidates, ['code-q', 'code-r'], 'the refusal must name who it saw');

  // AND A POSITIVELY FOREIGN ROW IS STILL EXCLUDED FROM THE COUNT, so this has
  // not simply reverted the fail-open: evidence about another machine is not
  // evidence about this worktree.
  const elsewhere = { agent_id: 'code-r', session_id: 's3', repo_id: 'R', worktree_id: 'W', machine_id: 'OTHER-MACHINE' };
  assert.equal(ask([q, elsewhere]).agentId, 'code-q',
    'a row from another machine was counted as an occupant here');
});

test('A DUPLICATED ROW REFERENCE DOES NOT INVENT AN UNVOUCHED ROW', () => {
  /*
   * RULE 11: THE POINT WHERE THE MUTATION STOPS BEING A NO-OP.
   *
   * `unvouchedCount` was `present.length - vouched.size`, and `vouched` is a Set
   * of row OBJECTS. Reverting to that subtraction leaves every existing fixture
   * green -- a blind auditor checked all 20 `registrations:` sites and none
   * aliases a row, and the production caller feeds `JSON.parse` output, which
   * yields distinct objects. So the fix was committed as a no-op and nothing
   * pinned it.
   *
   * A set size is not a count of the thing being counted. Here is the input
   * where that matters: the SAME object twice. Subtraction gives 2 - 1 = 1 and
   * invents an unvouched row, which blocks the sole-occupant rung and refuses a
   * session that should resolve.
   */
  const q = { agent_id: 'code-q', session_id: 's1', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE };
  const r = resolveAgentId({
    env: {}, sessionId: 'unseen', registrations: [q, q], repoId: 'R', worktreeId: 'W', machineId: MACHINE,
  });
  assert.equal(r.agentId, 'code-q',
    'a duplicated reference to one vouched row was counted as an unvouched row, refusing a resolvable session');
  assert.equal(r.source, SOURCE.SOLE_OCCUPANT);

  // DIFFERENCED: two DISTINCT rows of identical content behave the same, so
  // this is about object identity and not about the content being repeated.
  const twin = { ...q };
  assert.equal(resolveAgentId({
    env: {}, sessionId: 'unseen', registrations: [q, twin], repoId: 'R', worktreeId: 'W', machineId: MACHINE,
  }).agentId, 'code-q', 'two distinct rows of identical content did not resolve');
});

test('THE SAME FLIP ONE RUNG UP: an unvouched row naming this session does not resolve it', () => {
  /*
   * The audit named this twin and it is the sharper of the two, because rung 2
   * describes its answer as "its own earlier declaration, not a guess". A row
   * that does not say where it is from cannot support that sentence.
   */
  const ask = (rows) => resolveAgentId({ env: {}, sessionId: 'mine', registrations: rows, repoId: 'R', worktreeId: 'W', machineId: MACHINE });

  const stated = { agent_id: 'code-z', session_id: 'mine', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE };
  assert.equal(ask([stated]).agentId, 'code-z', 'the stated row did not resolve, so this proves nothing');

  const { machine_id: _drop, ...unstated } = stated;
  const r = ask([unstated]);
  assert.equal(r.agentId, null, 'an unattributable row was adopted as this session\'s own declaration');
  assert.match(r.why, /does not state its/, r.why);
});

test('ROWS PRESENT BUT UNVOUCHED DO NOT READ AS AN EMPTY STORE', () => {
  /*
   * The third state. "could not read" and "read nothing" were deliberately kept
   * apart; the provenance filter added "read something we may not speak for"
   * and the first version collapsed it into the empty message -- which points a
   * reader at a missing registration when the real cause is a registration
   * written while the config was unreadable.
   */
  const unstated = [{ agent_id: 'code-z', session_id: 'other', repo_id: 'R', worktree_id: 'W' }];
  const r = resolveAgentId({ env: {}, sessionId: 'mine', registrations: unstated, repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.equal(r.agentId, null);
  assert.doesNotMatch(r.why, /no prior registration/, 'an unvouched row was reported as an empty store');

  const empty = resolveAgentId({ env: {}, sessionId: 'mine', registrations: [], repoId: 'R', worktreeId: 'W', machineId: MACHINE });
  assert.match(empty.why, /no prior registration/, 'the genuinely empty store changed its message');
});

test('A ROW THAT DECLINES TO SAY WHERE IT IS FROM IS NOT ADMITTED', () => {
  /*
   * THE SHAPE THE HOSTILE LIST ABOVE COULD NOT REACH, and the reason it could
   * not: every entry in `junk` is rejected by the agent_id check, so the loop
   * proved nothing about the location filters. Rule 7 and rule 8 -- hostile
   * inputs drawn from what already failed bound nothing, and the one malformed
   * row that RESOLVED was the one nobody wrote down.
   *
   * This is not a hypothetical row. bin/agentbridge.mjs writes
   * `machine_id: cfg?.machineId ?? null` and loadConfig() returns null when
   * ~/.agentbridge/config.json is missing or unreadable, so a real
   * register-session on an uninitialised machine produces it.
   */
  const at = (over) => [{ agent_id: 'code-z', session_id: 'mine', repo_id: 'R', worktree_id: 'W', machine_id: MACHINE, ...over }];
  const ask = (rows) => resolveAgentId({ env: {}, sessionId: 'mine', registrations: rows, repoId: 'R', worktreeId: 'W', machineId: MACHINE });

  // THE POSITIVE CONTROL FIRST (rule 5): the complete row resolves, so every
  // refusal below is about the field removed and not about something else.
  assert.equal(ask(at({})).agentId, 'code-z', 'the complete row did not resolve, so this test proves nothing');

  for (const field of ['machine_id', 'worktree_id', 'repo_id']) {
    for (const [label, value] of [['absent', undefined], ['null', null], ['empty', ''], ['blank', '   '], ['a number', 42]]) {
      const row = at({ [field]: value });
      if (value === undefined) delete row[0][field];
      assert.equal(ask(row).agentId, null,
        `a row with ${field} ${label} was admitted, so it is unfiltered on that field`);
    }
  }

  /*
   * AND THE OTHER HALF STAYS TRUE: not knowing OUR value is a reason not to
   * filter, never a reason to refuse. readMachineId() returns null when this
   * machine's config cannot be read, and that must not take out sessions that
   * have done nothing wrong.
   */
  const blind = resolveAgentId({
    env: {}, sessionId: 'mine', registrations: at({}), repoId: 'R', worktreeId: 'W', machineId: null,
  });
  assert.equal(blind.agentId, 'code-z', 'a null machineId on OUR side must not refuse a fully-stated row');
});
