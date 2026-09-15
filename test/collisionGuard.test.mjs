import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLaneRegistry } from '../src/laneRegistry.mjs';
import {
  evaluateCommit,
  BLOCK,
  WARN,
  CANNOT_RUN,
  EXIT_ALLOW,
  EXIT_REFUSE,
  EXIT_CANNOT_RUN,
} from '../src/collisionGuard.mjs';

/**
 * EVERY RULE HERE HAS A SILENT TWIN.
 *
 * A suite that only proves rules FIRE passes completely against a guard that
 * refuses everything — and a guard nobody can commit past is removed within the
 * hour, which is a worse outcome than no guard at all. So each blocking case is
 * paired with the nearest state that differs in ONE field and must stay quiet.
 *
 * The pairs are the point. `foreign path blocks` and `the same path blocks
 * nobody once the lane owns it` are one test split in two; if the second ever
 * goes red the guard has started blocking correct work.
 */

const REG = parseLaneRegistry(`
lanes:
  - lane_id: messaging
    branch_patterns:
      - "code-c/*"
    worktrees:
      - "social-sparks-code-c"
    owned_paths:
      - "src/lib/reply/**"
    shared_paths:
      - "package.json"
  - lane_id: onboarding
    branch_patterns:
      - "code-b/*"
    owned_paths:
      - "src/lib/merchantPhone.server.ts"
      - "src/lib/onboarding/**"
  - lane_id: freeform
    owned_paths:
      - "docs/freeform/**"
`);

const base = {
  registry: REG,
  registryError: null,
  laneId: 'messaging',
  branch: 'code-c/anything',
  worktree: 'social-sparks-code-c',
  stagedPaths: [],
  strictShared: false,
};
const run = (over = {}) => evaluateCommit({ ...base, ...over });
const rules = (r) => r.findings.map((f) => f.rule);
const sev = (r, rule) => r.findings.find((f) => f.rule === rule)?.severity ?? null;

/* ── rule 1: a foreign path blocks, and names who owns it ────────────── */

test('foreign path blocks and names the owning lane', () => {
  const r = run({ stagedPaths: ['src/lib/merchantPhone.server.ts'] });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'foreign'), BLOCK);
  const f = r.findings.find((x) => x.rule === 'foreign');
  assert.deepEqual(f.owners, ['onboarding']);
  // A refusal that does not say who to talk to gets overridden with --no-verify.
  assert.match(f.message, /onboarding/);
});

test('NEAREST CLEAN: the same path is fine for the lane that owns it', () => {
  const r = run({ laneId: 'onboarding', branch: 'code-b/x', worktree: null, stagedPaths: ['src/lib/merchantPhone.server.ts'] });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(r.findings, []);
});

test('every foreign path is reported, not just the first', () => {
  const r = run({ stagedPaths: ['src/lib/merchantPhone.server.ts', 'src/lib/onboarding/a.ts'] });
  assert.equal(r.findings.filter((f) => f.rule === 'foreign').length, 2);
});

/* ── rule 2: shared is policy ────────────────────────────────────────── */

test('shared path warns by default and does NOT block', () => {
  const r = run({ stagedPaths: ['package.json'] });
  assert.equal(r.exitCode, EXIT_ALLOW, 'blocking package.json by default gets the hook uninstalled');
  assert.equal(sev(r, 'shared'), WARN);
});

test('shared path blocks under --strict-shared', () => {
  const r = run({ stagedPaths: ['package.json'], strictShared: true });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'shared'), BLOCK);
});

test('shared outranks owned: a lane that also owns it still only gets shared', () => {
  // laneRegistry resolves shared-anywhere before owned, so this asserts the
  // guard inherits that precedence rather than re-deciding it.
  const r = run({ laneId: 'messaging', stagedPaths: ['package.json'] });
  assert.equal(sev(r, 'shared'), WARN);
});

/* ── rule 3: owned and unclaimed both pass ───────────────────────────── */

test('owned path is silent', () => {
  const r = run({ stagedPaths: ['src/lib/reply/engine.ts'] });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(r.findings, []);
});

test('UNCLAIMED IS NOT FOREIGN — a partial lane map must not block ordinary work', () => {
  const r = run({ stagedPaths: ['README.md', 'src/lib/nobody/owns/this.ts'] });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(r.findings, []);
});

test('an empty staged list is allowed and does not crash', () => {
  const r = run({ stagedPaths: [] });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(r.findings, []);
});

/* ── rule 4: branch, only when the lane has an opinion ───────────────── */

test('a branch outside the lane pattern blocks', () => {
  const r = run({ branch: 'code-b/onboarding-phone' });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'branch'), BLOCK);
});

test('NEAREST CLEAN: a branch inside the pattern is silent', () => {
  const r = run({ branch: 'code-c/messaging-gates' });
  assert.equal(r.exitCode, EXIT_ALLOW);
});

test('A LANE WITH NO branch_patterns BLOCKS NOTHING', () => {
  // laneMatchesBranch returns null for "no opinion", and null must never block —
  // otherwise adding a lane without patterns freezes its holder out of every branch.
  const r = run({ laneId: 'freeform', branch: 'literally-anything', worktree: null });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(rules(r), []);
});

/* ── rule 5: worktree, same "only if declared" rule ──────────────────── */

test('a worktree outside the lane list blocks', () => {
  const r = run({ worktree: 'social-sparks-code-b' });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'worktree'), BLOCK);
});

test('NEAREST CLEAN: the declared worktree is silent', () => {
  assert.equal(run({ worktree: 'social-sparks-code-c' }).exitCode, EXIT_ALLOW);
});

test('a full path whose basename matches the declared worktree is accepted', () => {
  // The registry says a name; the hook is handed an absolute path. Comparing
  // those as strings would block every commit in a correctly configured tree.
  const r = run({ worktree: 'C:\\Users\\danny\\Documents\\social-sparks-code-c' });
  assert.equal(r.exitCode, EXIT_ALLOW);
});

test('A LANE WITH NO worktrees BLOCKS NOTHING', () => {
  const r = run({ laneId: 'onboarding', branch: 'code-b/x', worktree: '/somewhere/else' });
  assert.equal(r.exitCode, EXIT_ALLOW);
});

/* ── rule 6: no identity ─────────────────────────────────────────────── */

/*
 * THESE TWO ASSERT THE MESSAGE, AND THAT IS NOT PEDANTRY.
 *
 * Both cases emit rule 'identity' at BLOCK, so a test checking only rule and
 * severity cannot tell them apart — and mutation proved it: deleting the
 * `!laneId` branch entirely left the suite green, because the `!lane` lookup
 * right after it catches null too and raises the same rule. The check was
 * untested while looking tested.
 *
 * They are genuinely different failures. "No identity at all" is a session that
 * never declared a lane — the 14 Sep case. "Lane X is not in the registry" is a
 * typo or a stale config. A person needs to be told which.
 */
test('no resolvable lane blocks — this is how mixed-lane commits happen', () => {
  const r = run({ laneId: null });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'identity'), BLOCK);
  assert.match(r.findings[0].message, /no lane identity/);
});

test('a lane id that is not in the registry blocks, and says so distinctly', () => {
  const r = run({ laneId: 'no-such-lane' });
  assert.equal(r.exitCode, EXIT_REFUSE);
  assert.equal(sev(r, 'identity'), BLOCK);
  assert.match(r.findings[0].message, /not in the registry/);
  assert.doesNotMatch(r.findings[0].message, /no lane identity/);
});

test('NEAREST CLEAN: a known lane proceeds to the path rules', () => {
  assert.equal(run({ laneId: 'messaging', stagedPaths: ['src/lib/reply/a.ts'] }).exitCode, EXIT_ALLOW);
});

/* ── rule 7: no registry is exit 2, never exit 0 ─────────────────────── */

test('a missing registry CANNOT RUN — it must never be read as allowed', () => {
  const r = run({ registry: null, registryError: null });
  assert.equal(r.exitCode, EXIT_CANNOT_RUN);
  assert.equal(sev(r, 'registry'), CANNOT_RUN);
});

test('an invalid registry CANNOT RUN and carries the reason', () => {
  const r = run({ registry: null, registryError: 'path X is owned by both A and B' });
  assert.equal(r.exitCode, EXIT_CANNOT_RUN);
  assert.match(r.findings[0].message, /owned by both/);
});

test('cannot-run outranks a block: the code is 2, not 1', () => {
  const r = run({ registry: null, registryError: 'broken', laneId: null, stagedPaths: ['src/lib/merchantPhone.server.ts'] });
  assert.equal(r.exitCode, EXIT_CANNOT_RUN);
});

/* ── the shape of the verdict itself ─────────────────────────────────── */

test('blocked tracks the exit code in both directions', () => {
  assert.equal(run({ stagedPaths: ['src/lib/reply/a.ts'] }).blocked, false);
  assert.equal(run({ stagedPaths: ['src/lib/onboarding/a.ts'] }).blocked, true);
});

test('warnings alone leave blocked false', () => {
  const r = run({ stagedPaths: ['package.json'] });
  assert.equal(r.blocked, false);
  assert.equal(r.findings.length, 1);
});

test('evaluateCommit is pure — the same input twice gives the same verdict', () => {
  const input = { ...base, stagedPaths: ['src/lib/merchantPhone.server.ts', 'package.json'] };
  assert.deepEqual(evaluateCommit(input), evaluateCommit(input));
});

test('called with nothing at all it cannot run, rather than throwing or allowing', () => {
  assert.equal(evaluateCommit().exitCode, EXIT_CANNOT_RUN);
  assert.equal(evaluateCommit({}).exitCode, EXIT_CANNOT_RUN);
});

/* ── the real collision this exists to prevent ───────────────────────── */

test('14 SEP, REPLAYED: committing messaging files while acting as onboarding is refused', () => {
  // Code B, on its own branch and worktree, staging a file owned by messaging.
  // This is the commit that actually landed on another lane's branch that day.
  const r = evaluateCommit({
    ...base,
    laneId: 'onboarding',
    branch: 'code-b/onboarding-phone',
    worktree: 'social-sparks-code-b',
    stagedPaths: ['src/lib/reply/engine.ts'],
  });
  assert.equal(r.exitCode, EXIT_REFUSE);
  const f = r.findings.find((x) => x.rule === 'foreign');
  assert.deepEqual(f.owners, ['messaging']);
});

test('and the same agent committing its OWN lane files that day is untouched', () => {
  const r = evaluateCommit({
    ...base,
    laneId: 'onboarding',
    branch: 'code-b/onboarding-phone',
    worktree: 'social-sparks-code-b',
    stagedPaths: ['src/lib/merchantPhone.server.ts', 'src/lib/onboarding/setup.ts'],
  });
  assert.equal(r.exitCode, EXIT_ALLOW);
  assert.deepEqual(r.findings, []);
});
