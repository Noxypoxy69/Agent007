import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegistrations, IDENTITY_FIELDS } from '../src/hostedRegistry.mjs';

/**
 * TWO REGISTRIES THAT NEVER DISAGREE OUT LOUD ARE ONE REGISTRY AND A DECOY.
 *
 * ═══ HOW THIS SURFACED ═══
 *
 * c8 ran `unregister-session` and got, from the hosted side:
 *
 *     session_owned_by_another_agent,
 *     'social-sparks-app-b6' held by agent 'b6'
 *
 * The hosted registry had that session as `b6`. The local store had it as
 * `code-b`. They had disagreed for hours, every READ was silently consistent,
 * and the first thing to notice was a refusal at the far end of an unrelated
 * command.
 *
 * ═══ WHY NOTHING COULD HAVE NOTICED ═══
 *
 * mergeRegistrations did `{ ...existing, ...r, origin: 'hosted' }`. Hosted
 * overwrote local in the same expression that would have had to compare them,
 * so the disagreement was destroyed at the moment it was created and nothing
 * downstream could report what it never saw.
 *
 * This is the day's recurring shape once more: a value that means "these two
 * sources contradict each other" rendering identically to "these two sources
 * agree".
 *
 * The hosted row still wins. It is the cross-machine authority and choosing the
 * other way would be worse. What changed is that the conflict now travels
 * attached to the row it happened on.
 */

const L = (over = {}) => ({
  session_id: 's1', agent_id: 'code-b', lane_id: 'voice',
  repo_id: 'social-sparks', worktree_id: 'wt-a', capacity: 'idle', ...over,
});
const H = (over = {}) => ({
  session_id: 's1', agent_id: 'code-b', lane_id: 'voice',
  repo_id: 'social-sparks', worktree_id: 'wt-a', capacity: 'busy', ...over,
});

// ── the case that went silent for hours ────────────────────────────────────

test('A DISAGREEMENT ABOUT agent_id IS REPORTED, not merged away', () => {
  // c8's exact case: local says code-b, hosted says b6.
  const [row] = mergeRegistrations([L({ agent_id: 'code-b' })], [H({ agent_id: 'b6' })]);

  assert.ok(row.conflicts, 'the two registries disagreed about who owns a session and said nothing');
  assert.deepEqual(row.conflicts, [{ field: 'agent_id', local: 'code-b', hosted: 'b6' }]);
});

test('the HOSTED value still wins — reporting is not overriding', () => {
  /*
   * Deliberate. Hosted is the cross-machine authority: its heartbeat is
   * server-stamped and it is what a second machine can trust. Letting local win
   * on a conflict would make every machine believe itself over the shared
   * record, which is a worse failure than the silent one being fixed here.
   */
  const [row] = mergeRegistrations([L({ agent_id: 'code-b' })], [H({ agent_id: 'b6' })]);
  assert.equal(row.agent_id, 'b6');
  assert.equal(row.origin, 'hosted');
});

test('EVERY ROUTING FIELD IS COMPARED, not just the one that bit us', () => {
  /*
   * Fixing only agent_id would be patching the instance. These four decide
   * where an assignment goes; a disagreement on any of them sends work to one
   * worker while the operator watches another.
   */
  const [row] = mergeRegistrations(
    [L({ agent_id: 'code-b', lane_id: 'voice', repo_id: 'r1', worktree_id: 'wt-a' })],
    [H({ agent_id: 'b6', lane_id: 'claims', repo_id: 'r2', worktree_id: 'wt-b' })],
  );

  /*
   * THE FIELD NAMES ARE WRITTEN OUT, NOT DERIVED FROM IDENTITY_FIELDS.
   *
   * The first version asserted `row.conflicts.map(f) === [...IDENTITY_FIELDS]`,
   * and a mutation narrowing that constant to just ['agent_id'] came back
   * GREEN — because narrowing the constant narrowed the expectation with it.
   * The test reconstructed the rule it was checking and therefore agreed with
   * itself straight through the regression.
   *
   * That is hollow gate 2 in CLAUDE.md, produced here by me while writing a
   * test about a different one. A gate must read the SHIPPED value against a
   * literal it does not share.
   */
  assert.deepEqual(row.conflicts.map((c) => c.field).sort(),
    ['agent_id', 'lane_id', 'repo_id', 'worktree_id']);

  // And the constant itself must not quietly shrink.
  assert.deepEqual([...IDENTITY_FIELDS].sort(),
    ['agent_id', 'lane_id', 'repo_id', 'worktree_id'],
    'IDENTITY_FIELDS lost a routing field; a disagreement there would go unreported');
});

// ── what must NOT be called a conflict ─────────────────────────────────────

test('AGREEMENT IS SILENT — the positive control', () => {
  /*
   * Required, and load-bearing. "Attach a conflict to every row" satisfies the
   * assertions above and makes the field meaningless: a roster where every row
   * is flagged is a roster where no row is.
   */
  const [row] = mergeRegistrations([L()], [H()]);
  assert.equal(row.conflicts, undefined, 'two agreeing registries were reported as in conflict');
  assert.equal(row.capacity, 'busy', 'the hosted row still won on liveness');
});

test('LIVENESS DIFFERING IS NORMAL AND IS NOT A CONFLICT', () => {
  /*
   * The hosted heartbeat is server-stamped and the local one is not, so one
   * being fresher is the expected state rather than a fault. Flagging it would
   * fire on every healthy row forever — which is how a warning becomes noise
   * and then becomes ignored.
   */
  const [row] = mergeRegistrations(
    [L({ capacity: 'idle', heartbeat_at: '2026-09-16T05:00:00.000Z' })],
    [H({ capacity: 'busy', heartbeat_at: '2026-09-16T05:05:00.000Z' })],
  );
  assert.equal(row.conflicts, undefined);
});

test('ABSENCE IS NOT DISAGREEMENT', () => {
  /*
   * A local row that simply does not carry a field has not contradicted
   * anything. Treating null as a conflicting value would flag every partial
   * record as a fault — the same error as reading "I could not find out" as
   * "there is nothing there", which is what the [local] tag did to c8.
   */
  const [a] = mergeRegistrations([L({ lane_id: null })], [H({ lane_id: 'voice' })]);
  assert.equal(a.conflicts, undefined);

  const [b] = mergeRegistrations([{ session_id: 's1' }], [H()]);
  assert.equal(b.conflicts, undefined);
  assert.equal(b.agent_id, 'code-b', 'the hosted value still filled the gap');
});

test('a session in only ONE registry is not a conflict either', () => {
  const rows = mergeRegistrations([L({ session_id: 'only-local' })], [H({ session_id: 'only-hosted' })]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.conflicts === undefined));

  // And origin still distinguishes where each was seen.
  assert.equal(rows.find((r) => r.session_id === 'only-local').origin, 'local');
  assert.equal(rows.find((r) => r.session_id === 'only-hosted').origin, 'hosted');
});

test('the roster never throws, whatever it finds', () => {
  /*
   * A roster that throws is one nobody can read during exactly the incident it
   * is describing. The conflict travels as DATA and the caller decides how loud
   * to be about it.
   */
  assert.doesNotThrow(() => mergeRegistrations([L({ agent_id: 'x' })], [H({ agent_id: 'y' })]));
  assert.doesNotThrow(() => mergeRegistrations(undefined, undefined));
  assert.doesNotThrow(() => mergeRegistrations([null, { }], [null]));
});
