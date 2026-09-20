/**
 * THE ENVIRONMENT MUST NOT AUTHENTICATE, ASSERTED THROUGH THE COMMAND.
 *
 * bc64310 closed P0-5: `candidate-record` used to take
 * AGENTBRIDGE_PRINCIPAL_ID straight from the environment and stamp the
 * record `identity_source: credential`, so any process that could set an
 * environment variable could author a candidate as anybody and reach a
 * gate-satisfying audit.
 *
 * IT SHIPPED WITH NO TEST OF THAT, and a blind auditor measured the cost:
 * reverting the three wiring lines in bin/agentbridge.mjs restores the hole
 * end to end, and the full suite is BYTE-IDENTICAL green -- 2836 tests,
 * 2831 pass, 0 fail, before and after. The whole behaviour change lives in
 * the caller; `test/principalResolution.test.mjs` exercises only the pure
 * function, and the string `candidate-record` appeared in no test at all.
 *
 * That is rule 17 in its exact words -- the wiring is a separate claim from
 * the logic, and only the logic had tests -- and rule 1, because a fix
 * nobody watched fail is a fix nobody has evidence for.
 *
 * SO THIS TEST DRIVES THE SHIPPED COMMAND, not the module. It is the
 * cheapest thing that would have caught the original defect: export the two
 * variables, run the command, and read what it bound.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run `candidate-record` in an isolated home with a chosen environment.
 *
 * NODE_TEST_CONTEXT IS STRIPPED. node --test sets it in every test process,
 * and a child that inherits it decides it is a nested test run and emits the
 * child protocol instead of its own output. That accident has already cost
 * this repository one false SKIP, recorded in scripts/audit-auto.mjs.
 */
function recordCandidate(env) {
  const home = mkdtempSync(path.join(tmpdir(), 'candrec-'));
  try {
    const clean = { ...process.env, AGENTBRIDGE_HOME: home };
    delete clean.NODE_TEST_CONTEXT;
    delete clean.AGENTBRIDGE_PRINCIPAL_ID;
    delete clean.AGENTBRIDGE_SESSION_ID;
    delete clean.AGENTBRIDGE_AGENT_ID;

    const r = spawnSync(process.execPath,
      [path.join(REPO, 'bin', 'agentbridge.mjs'), 'candidate-record', '--rev', 'HEAD'],
      { cwd: REPO, env: { ...clean, ...env }, encoding: 'utf8', timeout: 120_000 });

    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('A PRINCIPAL ASSERTED THROUGH THE ENVIRONMENT IS NOT A CREDENTIAL', () => {
  const { status, out } = recordCandidate({
    AGENTBRIDGE_PRINCIPAL_ID: 'danny',
    AGENTBRIDGE_SESSION_ID: 'session_IAMTHEOWNER',
  });

  /*
   * THE COMMAND MUST HAVE RUN, CHECKED FIRST. Without this the assertion
   * below passes for a command that crashed and printed nothing, which is
   * rule 3 -- the absence of the word "credential" is not evidence unless
   * something was produced to contain it.
   */
  assert.equal(status, 0, `candidate-record did not run cleanly:\n${out}`);
  assert.match(out, /bound to /,
    `candidate-record produced no binding line, so this proves nothing:\n${out}`);

  assert.match(out, /\(observed\)/,
    'a principal supplied through the environment was accepted as authenticated. '
    + `Setting AGENTBRIDGE_PRINCIPAL_ID must not produce a credential binding:\n${out}`);
  assert.doesNotMatch(out, /\(credential\)/,
    `the environment authenticated, which is P0-5 reopened:\n${out}`);
});

test('AND THE INVENTED PRINCIPAL DOES NOT BECOME THE AUTHOR', () => {
  /*
   * The other half of the same hole: even labelled `observed`, a record that
   * carried principal_id=danny would let a later reader attribute the work.
   * The binding must name the session, never the asserted principal.
   */
  const { out } = recordCandidate({
    AGENTBRIDGE_PRINCIPAL_ID: 'danny',
    AGENTBRIDGE_SESSION_ID: 'session_NOT_DANNY',
  });

  const bound = /bound to (\S+)/.exec(out)?.[1];
  assert.ok(bound, `no binding line to read:\n${out}`);
  assert.notEqual(bound, 'danny',
    `the asserted principal became the binding: ${bound}\n${out}`);
});

test('THE CONTROL: an ordinary session still records, and records as observed', () => {
  /*
   * Rule 5. If the command refused in every shape, the assertions above
   * would pass for a command that never works and the gate would measure
   * nothing.
   *
   * MY FIRST VERSION OF THIS CONTROL PASSED NO IDENTITY AT ALL and went
   * red -- correctly. candidate-record refuses outright with exit 3 and
   * 'session_id or principal_id is required: a candidate whose author
   * cannot be named cannot later be shown independent of its reviewer'.
   * That is the command being right, not a defect, and the control was
   * wrong to demand otherwise. An ordinary session is the real control.
   */
  const { status, out } = recordCandidate({ AGENTBRIDGE_SESSION_ID: 'session_ordinary' });
  assert.equal(status, 0, `candidate-record failed with a clean environment:\n${out}`);
  assert.match(out, /\(observed\)/, `expected an observed binding:\n${out}`);
});
