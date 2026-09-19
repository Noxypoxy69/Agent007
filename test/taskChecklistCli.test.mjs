/**
 * THE CHECKLIST COMMAND'S EXIT CODE IS WHAT AUTOMATION READS, AND IT SAID
 * SUCCESS FOR A TASK WITH NOTHING PROVEN.
 *
 * `agentbridge task-checklist` exited `blocked.length ? 1 : 0`. `blocked` is
 * only the items whose proof REPORTED FAILURE, so a task where every item is
 * PENDING -- no evidence at all, nothing attempted -- exited 0.
 *
 * This repository's own HELP for observe-sha states the opposite policy in
 * capitals: "There is no exit 0. This command cannot authorise anything, so
 * it must not return the status automation reads as success." And it is the
 * same defect as the module the command reports on: saying a thing is done
 * and the thing being done must not be the same act. A status code that
 * cannot tell "all proven" from "nothing attempted" is a box that checks
 * itself.
 *
 * These drive the SHIPPED CLI as a subprocess. src/taskGate.mjs has thorough
 * unit tests and they all stop at the module boundary; the exit code is a
 * separate claim, and only the logic had tests (rule 17).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'bin', 'agentbridge.mjs');

const TASK = { task_id: 't-1', attempt: 3, candidate_sha: 'cafe1234', worker_session: 'sess-worker' };
const ONE_PHASE = {
  id: 'p', phases: ['reproduce'], requirements: { reproduce: ['reproduction_result'] },
};
const proof = (over = {}) => ({
  evidence_id: 'e1',
  type: 'reproduction_result',
  task_id: 't-1',
  attempt: 3,
  candidate_sha: 'cafe1234',
  producer_session: 'sess-worker',
  status: 'passed',
  ...over,
});

/** Run the shipped command against a state file; never piped, so the status is node's. */
function checklist(t, state, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  writeFileSync(file, JSON.stringify(state, null, 2));

  const r = spawnSync(process.execPath, [CLI, 'task-checklist', '--file', file, ...extra], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, AGENTBRIDGE_HOME: dir },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('A TASK WITH NOTHING PROVEN EXITS NON-ZERO', (t) => {
  const r = checklist(t, { task: TASK, template: ONE_PHASE, evidence: [], waivers: [] });

  assert.equal(r.status, 1,
    `nothing was proven, so this must not return the status automation reads as success. ${r.out}`);
  assert.match(r.out, /NOT satisfied/,
    `and it must say why, not just fail quietly. ${r.out}`);
});

test('the positive control: a task whose every item is proven exits 0', (t) => {
  /*
   * Rule 5. Without this, a command that exited 1 unconditionally would
   * satisfy the test above, and an exit code that is always 1 is exactly as
   * useless to automation as one that is always 0.
   */
  const r = checklist(t, { task: TASK, template: ONE_PHASE, evidence: [proof()], waivers: [] });

  assert.equal(r.status, 0, `real evidence must be able to clear the board. ${r.out}`);
  assert.match(r.out, /\[ok {2}\]/, r.out);
});

test('a RECORDED FAILURE exits non-zero and is named as a failure', (t) => {
  const r = checklist(t, {
    task: TASK, template: ONE_PHASE, evidence: [proof({ status: 'failed' })], waivers: [],
  });

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /REPORTED FAILURE/, r.out);
});

test('a WAIVED item is not double-prefixed in the report', (t) => {
  /*
   * satisfied_by already reads "waiver by <who>", and the printer prefixed
   * it again: "by waiver by danny". Small, but this board is meant to be
   * read by someone deciding whether to trust it.
   */
  const waived = {
    task: TASK,
    template: { id: 'w', phases: ['blind-review'], requirements: { 'blind-review': ['blind_review_result'] } },
    evidence: [],
    waivers: [{
      item_id: 'blind-review:blind_review_result',
      reason: 'deploy frozen',
      granted_by: 'danny',
      task_id: 't-1',
      attempt: 3,
      candidate_sha: 'cafe1234',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }],
  };
  const r = checklist(t, waived);

  assert.match(r.out, /waiver by danny/, r.out);
  assert.doesNotMatch(r.out, /by waiver by/, `the preposition is already in the value. ${r.out}`);
  assert.equal(r.status, 0, `an owner waiver satisfies the item, so the board is complete. ${r.out}`);
});

test('--advance REFUSED exits 1, PERMITTED exits 0', (t) => {
  const two = {
    id: 'two',
    phases: ['reproduce', 'verify'],
    requirements: { reproduce: ['reproduction_result'], verify: ['positive_test_result'] },
  };

  const refused = checklist(t,
    { task: TASK, template: two, evidence: [proof()], waivers: [] }, ['--advance', 'verify']);
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /REFUSED/, refused.out);
  assert.match(refused.out, /verify:positive_test_result/,
    `a refusal must name what is missing (rule 15). ${refused.out}`);

  const permitted = checklist(t, {
    task: TASK,
    template: two,
    evidence: [proof(), proof({ evidence_id: 'e2', type: 'positive_test_result' })],
    waivers: [],
  }, ['--advance', 'verify']);
  assert.equal(permitted.status, 0, permitted.out);
  assert.match(permitted.out, /PERMITTED/, permitted.out);
});

test('A TEMPLATE THAT REQUIRES NOTHING EXITS NON-ZERO TOO', (t) => {
  /*
   * THE HALF MY OWN FIX LEFT OPEN, found by blind audit.
   *
   * The first version computed `outstanding` over `items` and stopped. A
   * template with no requirements produces NO items, so outstanding was 0,
   * blocked was 0, and the command exited 0 for a checklist that proved
   * nothing -- in the commit whose headline was "exit 0 means the checklist
   * is complete". The emptiest case in the class was the one left returning
   * success.
   *
   * canAdvance already refuses exactly this, in the same module, with a unit
   * test pinning it. So one command answered the same question two ways
   * depending on which flag you passed, and the disagreeing half was the one
   * automation reads.
   */
  const r = checklist(t, {
    task: TASK,
    template: { id: 'tpl-empty', phases: ['verify'], requirements: {} },
    evidence: [],
    waivers: [],
  });

  assert.equal(r.status, 1,
    `a template requiring no proof establishes nothing and must not exit 0. ${r.out}`);
  assert.match(r.out, /requires NO proof at all/, r.out);

  /* A template with no phases at all is the same claim, one step emptier. */
  const noPhases = checklist(t, {
    task: TASK, template: { id: 'tpl-bare' }, evidence: [], waivers: [],
  });
  assert.equal(noPhases.status, 1,
    `a template with no phases proves nothing either. ${noPhases.out}`);

  /*
   * And the two halves must AGREE. The defect was that --advance refused
   * while the bare command said success, so this pins them to the same
   * answer rather than just fixing one side.
   */
  const advanced = checklist(t, {
    task: TASK,
    template: { id: 'tpl-empty', phases: ['verify'], requirements: {} },
    evidence: [],
    waivers: [],
  }, ['--advance', 'verify']);
  assert.equal(advanced.status, 1, advanced.out);
  assert.match(advanced.out, /REFUSED/, advanced.out);
  assert.match(advanced.out, /requires no proof/, advanced.out);
});
