import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE REFUSAL CONTRACT.
 *
 * scanPayload is unit-tested and mutation-proven, and none of that proves the
 * preflight can stop a publish. A guard that prints LEAK in red and exits 0 is
 * indistinguishable from a working one in every log anyone will ever read: the
 * payload goes to the hosted database anyway and the warning scrolls past.
 *
 * So this asserts the exit code and nothing else. Wording is for a person and
 * is free to change.
 *
 *   0  clean
 *   1  leaks found
 *   2  cannot run
 *
 * EXIT 2 IS THE ONE THAT MATTERS MOST. A preflight that cannot read its input
 * has established nothing, and reporting that as clean publishes on the
 * strength of a check that never ran — the operator believes they were
 * protected. There are four separate ways to reach it below.
 */

const CLI = fileURLToPath(new URL('../bin/agentbridge-preflight.mjs', import.meta.url));
const JANE = 'Jane Doe,C:\\Users\\Jane Doe,DESKTOP-ABC123';

function run(args, { stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }),
    );
    if (stdin !== null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

const CLEAN = JSON.stringify({
  schema: 'heartbeat/1',
  machine: { id: '62710e7e-09b5-48f8-b15c-f790be308b86', name: 'machine-62710e', platform: 'win32' },
  sessions: [{ agentId: 'code-b', lane: 'onboarding', git: { head: 'ad4fc1a', branch: 'b/payload-guard' } }],
});

const DIRTY = JSON.stringify({
  machine: { label: 'jane-win', hostname: 'DESKTOP-ABC123' },
  sessions: [{ worktree: 'C:\\Users\\Jane Doe\\Documents\\x', git: { worktree: 'C:/Users/Jane Doe/Documents/x' } }],
});

async function tmp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ab-pg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * THE STARTUP CONTROL, AND IT RUNS FIRST ON PURPOSE.
 *
 * Invented while building the collision guard, after a syntax error meant the
 * CLI never parsed: node exits 1 on a startup crash, and 1 is "refuse" in this
 * contract, so four tests passed against a program that could not start. Every
 * one asserted the right integer for entirely the wrong reason.
 *
 * A refuse-only suite cannot tell "correctly refused" from "died on startup".
 * This is the assertion that separates them, and every exit-1 case below is
 * meaningless without it.
 */
test('the preflight can start at all — a crash exits 1 and would read as a refusal', async () => {
  const r = await run(['--identity', JANE], { stdin: CLEAN });
  assert.doesNotMatch(r.stderr, /SyntaxError|ReferenceError|TypeError|Cannot find module/,
    'the preflight crashed on startup; every refusal below would be meaningless');
  assert.equal(r.code, 0, 'a clean payload must pass, or the guard refuses everything');
});

test('exit 1: a payload carrying identity is refused', async () => {
  const r = await run(['--identity', JANE], { stdin: DIRTY });
  assert.equal(r.code, 1);
});

test('exit 0: a clean payload on stdin', async () => {
  const r = await run(['--identity', JANE], { stdin: CLEAN });
  assert.equal(r.code, 0);
});

test('exit 1 and 0 via --file, the same two payloads', async (t) => {
  const root = await tmp(t);
  const dirty = path.join(root, 'dirty.json');
  const clean = path.join(root, 'clean.json');
  await writeFile(dirty, DIRTY);
  await writeFile(clean, CLEAN);
  assert.equal((await run(['--file', dirty, '--identity', JANE])).code, 1);
  assert.equal((await run(['--file', clean, '--identity', JANE])).code, 0);
});

test('exit 2: NO PAYLOAD AT ALL must never read as clean, and says which failure it is', async () => {
  const r = await run(['--identity', JANE], { stdin: '' });
  assert.equal(r.code, 2);
  /*
   * The message is asserted here and nowhere else, because mutation showed the
   * code alone cannot distinguish two different faults: delete the empty-input
   * check and JSON.parse('') throws, so the bad-JSON branch returns 2 as well
   * and the suite stays green. Same masking shape as the collision guard's
   * identity rule.
   *
   * "You piped me nothing" and "you piped me something unparseable" send a
   * person to different places — a broken pipeline versus a broken payload.
   */
  assert.match(r.stderr, /no payload/i);
  assert.doesNotMatch(r.stderr, /not JSON/i);
});

test('exit 2: a file that does not exist', async (t) => {
  const root = await tmp(t);
  const r = await run(['--file', path.join(root, 'nope.json'), '--identity', JANE]);
  assert.equal(r.code, 2);
});

test('exit 2: input that is not JSON', async () => {
  const r = await run(['--identity', JANE], { stdin: 'this is not json' });
  assert.equal(r.code, 2);
});

test('exit 2: truncated JSON — a half-written payload is not a clean one', async () => {
  const r = await run(['--identity', JANE], { stdin: '{"machine":{"label":' });
  assert.equal(r.code, 2);
});

test('the leak report names the JSON path, and does not republish the name', async () => {
  const r = await run(['--identity', JANE], { stdin: DIRTY });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\/sessions\/0\/worktree/, 'a leak nobody can locate is not actionable');
  assert.doesNotMatch(r.stderr, /Jane Doe/, 'the report is pasted into chat; it must not carry the leak');
});

test('leaks go to stderr, leaving stdout free for piping', async () => {
  const r = await run(['--identity', JANE], { stdin: DIRTY });
  assert.equal(r.stdout, '');
});

test('with no --identity it uses this machine, and does not crash doing so', async () => {
  // Cannot assert the verdict — it depends on whose machine this runs on — but
  // it must not be exit 2, which would mean the default path is broken.
  const r = await run([], { stdin: CLEAN });
  assert.notEqual(r.code, 2);
});
