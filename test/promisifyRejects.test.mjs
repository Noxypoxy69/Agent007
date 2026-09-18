/**
 * A CANARY FOR AN ASSUMPTION THE ERROR HANDLING IN THIS REPO RELIES ON.
 *
 * util.promisify(child_process.execFile) REJECTS on a non-zero exit -- the
 * rejection carries .code/.stdout/.stderr. It does NOT resolve { ok, stdout }
 * the way src/exec.mjs's exported run() does. Those are the same word in two
 * scopes, and confusing them is how a fix comment in the safeGit migration came
 * to claim "the old run resolved { stdout: '' }" when the local run there was
 * promisify(execFile), which threw. An auditor caught it and 426a114 corrected
 * the comment and made the fallback fail-safe.
 *
 * This pins the two behaviours so neither can be re-argued from memory: code
 * that treats a promisified execFile as non-throwing is exactly what turns this
 * red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('promisify(execFile) REJECTS on a non-zero exit, it does not resolve', async () => {
  const run = promisify(execFile);
  await assert.rejects(
    () => run(process.execPath, ['-e', 'process.exit(3)']),
    (e) => Boolean(e) && e.code === 3,
    'a promisified execFile must reject on a non-zero exit, with the code on the error',
  );
});

test('promisify(execFile) RESOLVES on a zero exit, returning stdout', async () => {
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(stdout, 'ok');
});
