/**
 * VALIDATION RUNS OUTSIDE THE AUTHORITY PROCESS. (Directive item 6.)
 *
 * Measured on the prototype: a candidate submitted a test file, the verifier ran
 * `node --test` inside the candidate's own workspace, and the test wrote a file
 * outside that workspace DURING verification. It did so even though the
 * candidate was ultimately rejected -- so submitting for verification was itself
 * arbitrary code execution in the authority's context, before any verdict
 * existed. That is the Stop-gate problem moved one building over: the thing
 * being judged running inside the judge.
 *
 * Two things change here.
 *
 * FIRST, the candidate's code runs in a SEPARATE PROCESS. The authority never
 * imports it, never requires it, and keeps no handle on it. A crash, a hang or a
 * process.exit in candidate code cannot take the authority with it, and the
 * authority's own module state is not reachable from the candidate's heap.
 *
 * SECOND, it runs against a CHECKOUT OF THE APPROVED TREE, never the candidate's
 * working directory, so the bytes that are tested are the bytes that were
 * hashed. A file the candidate writes after the tree is built does not appear in
 * the run.
 *
 * WHAT THIS STILL DOES NOT DO, AND THE HONEST VERSION MATTERS MORE THAN THE
 * FEATURE. A separate process under the SAME OS USER is not containment. The
 * candidate's tests can still read and write anything that user can, including
 * the authoritative repository, the approval store and this file. Process
 * separation buys fault isolation and removes in-process state access; it does
 * not buy a trust boundary. That needs a different OS principal or a container,
 * which is Step 4B, and nothing in this module should be read as having
 * delivered it.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function discoverTests(root) {
  const out = [];
  const visit = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const p = path.join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p);
      else if (/\.test\.mjs$/i.test(e)) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  visit(path.join(root, 'test'));
  return out.sort();
}

export function runValidation({ treeCheckout, timeoutMs = 180000 }) {
  const tests = discoverTests(treeCheckout);
  /*
   * ZERO TESTS IS A REFUSAL, NOT A PASS. A candidate that deletes the suite
   * would otherwise validate perfectly.
   */
  if (tests.length === 0) return { ok: false, error: 'zero-tests-found', counts: null };

  /*
   * A MINIMAL, EXPLICIT ENVIRONMENT. Two reasons, one of them measured.
   *
   * MEASURED: inheriting process.env passed NODE_TEST_CONTEXT to the child when
   * the authority itself ran under `node --test`. The child then emitted the
   * nested-reporter stream instead of its own TAP summary, the `# tests N` lines
   * were absent, and every candidate was rejected as 'invalid-tap-summary' --
   * a verifier that fails closed for a reason that has nothing to do with the
   * candidate is still a broken verifier.
   *
   * AND ON PRINCIPLE: the authority's environment is not the candidate's
   * business. Whatever tokens, keys or paths the verifier was started with,
   * candidate test code should not receive them by default. This does not
   * contain hostile code -- same OS user, same filesystem -- but handing it the
   * environment as well is a choice, and the choice is no.
   */
  const childEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: treeCheckout,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test',
  };

  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
    cwd: treeCheckout,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
    /* No inherited stdio: candidate output cannot interleave with the authority's. */
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  if (run.error || run.signal || run.status !== 0) {
    return { ok: false, error: `exit=${run.status} signal=${run.signal} err=${run.error?.message ?? 'none'}`, counts: null, output: output.slice(-4000) };
  }

  /*
   * EXACTLY ONE SUMMARY LINE PER LABEL. A candidate can print anything it likes
   * to stdout, including a convincing fake TAP footer; requiring exactly one
   * match means an injected second summary is a refusal rather than a choice
   * between two answers.
   */
  const one = (label) => {
    const hits = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
    return hits.length === 1 ? Number(hits[0][1]) : null;
  };
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((l) => [l, one(l)]));
  if (Object.values(counts).some((v) => v === null)) return { ok: false, error: 'invalid-tap-summary', counts };
  if (counts.tests <= 0 || counts.fail !== 0 || counts.cancelled !== 0) return { ok: false, error: 'tap-counts-refused', counts };
  if (counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo !== counts.tests) {
    return { ok: false, error: 'tap-counts-do-not-reconcile', counts };
  }
  return { ok: true, error: null, counts, testFiles: tests.length };
}
